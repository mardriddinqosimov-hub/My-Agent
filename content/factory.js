import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { execSync } from 'child_process';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const IS_WIN  = process.platform === 'win32';
const FFMPEG  = IS_WIN ? path.join(process.cwd(), 'bin', 'ffmpeg.exe')  : 'ffmpeg';
const FFPROBE = IS_WIN ? path.join(process.cwd(), 'bin', 'ffprobe.exe') : 'ffprobe';

// ── Helpers ────────────────────────────────────────────────────────────────────

export function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
}

export function outDir(topic) {
  const date = new Date().toISOString().slice(0, 10);
  const dir = path.join(process.cwd(), 'workspace', 'content', date, slug(topic));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function srtTime(s) {
  const h = Math.floor(s / 3600).toString().padStart(2, '0');
  const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  const ms = Math.round((s % 1) * 1000).toString().padStart(3, '0');
  return `${h}:${m}:${sec},${ms}`;
}

export function downloadUrl(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return downloadUrl(res.headers.location, dest).then(resolve).catch(reject);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

function fwd(p) { return p.replace(/\\/g, '/'); }

function getAudioDuration(audioPath) {
  const out = execSync(`"${FFPROBE}" -v quiet -show_entries format=duration -of csv=p=0 "${fwd(audioPath)}"`).toString().trim();
  return parseFloat(out);
}

function runCmd(dir, name, cmd) {
  if (IS_WIN) {
    const bat = path.join(dir, `_${name}.bat`);
    fs.writeFileSync(bat, `@echo off\r\n${cmd}\r\n`, 'utf-8');
    try {
      execSync(`"${bat}"`, { timeout: 300000, maxBuffer: 20 * 1024 * 1024 });
    } finally {
      fs.unlink(bat, () => {});
    }
  } else {
    execSync(cmd, { shell: true, timeout: 300000, maxBuffer: 20 * 1024 * 1024 });
  }
}

// ── Step 1: Generate voiceover script ─────────────────────────────────────────

export async function generateReelScript(topic, onProgress) {
  onProgress?.('✍️ Writing reel script...');
  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: `Write a punchy 30-45 second spoken voiceover script for a social media reel about: "${topic}".
No stage directions, no markdown — just words to speak out loud.
Start with a strong hook. End with a short CTA.`
    }]
  });
  return res.choices[0].message.content.trim();
}

// ── Step 2: Generate TTS audio ─────────────────────────────────────────────────

export async function generateAudio(script, dir, onProgress) {
  onProgress?.('🎙 Generating voiceover...');
  const mp3 = await openai.audio.speech.create({ model: 'tts-1-hd', voice: 'onyx', input: script });
  const buffer = Buffer.from(await mp3.arrayBuffer());
  const audioPath = path.join(dir, 'voiceover.mp3');
  fs.writeFileSync(audioPath, buffer);
  return audioPath;
}

// ── Step 3: Generate subtitles via Whisper ─────────────────────────────────────

export async function generateSubtitles(audioPath, dir, onProgress) {
  onProgress?.('📝 Generating subtitles...');
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: 'whisper-1',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment']
  });
  const srt = transcription.segments.map((seg, i) =>
    `${i + 1}\n${srtTime(seg.start)} --> ${srtTime(seg.end)}\n${seg.text.trim()}\n`
  ).join('\n');
  const srtPath = path.join(dir, 'subtitles.srt');
  fs.writeFileSync(srtPath, srt, 'utf-8');
  return srtPath;
}

// ── Step 4: Generate AI images via DALL-E 3 ───────────────────────────────────

export async function generateAIImages(topic, dir, count = 4, onProgress) {
  onProgress?.(`🎨 Generating ${count} AI images...`);
  const prompts = [
    `Cinematic vertical portrait, social media reel background for "${topic}". Dramatic lighting, modern. No text.`,
    `Wide cinematic shot related to "${topic}". Vibrant colors, professional. No text.`,
    `Close-up detail shot for "${topic}". Shallow depth of field, editorial style. No text.`,
    `Lifestyle scene related to "${topic}". Golden hour lighting, high contrast. No text.`
  ];
  const imagePaths = new Array(count);
  await Promise.all(prompts.slice(0, count).map(async (prompt, i) => {
    const res = await openai.images.generate({ model: 'dall-e-3', prompt, n: 1, size: '1024x1792', quality: 'standard' });
    const imgPath = path.join(dir, `bg_${i}.png`);
    await downloadUrl(res.data[0].url, imgPath);
    imagePaths[i] = imgPath;
  }));
  return imagePaths;
}

// ── Step 5: Render 9:16 video (two-pass: slideshow + subtitles) ───────────────

export async function renderVideo(imagePaths, audioPath, srtPath, dir, onProgress) {
  onProgress?.('🎬 Rendering 9:16 reel...');

  const audioDuration = getAudioDuration(audioPath);
  const n = imagePaths.length;
  const crossfade = 0.5;
  const imgDuration = (audioDuration / n + crossfade).toFixed(3);

  const tempPath = path.join(dir, 'temp_nosub.mp4');
  const videoPath = path.join(dir, 'reel.mp4');

  // ── Pass 1: slideshow + audio ──────────────────────────────────────────────

  const inputs = imagePaths.map(p => `-loop 1 -t ${imgDuration} -i "${fwd(p)}"`).join(' ');

  const scales = imagePaths.map((_, i) =>
    `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[vs${i}]`
  ).join(';');

  let xfade = '';
  let prev = 'vs0';
  if (n > 1) {
    for (let i = 1; i < n; i++) {
      const offset = Math.max(0.1, (i * audioDuration / n - crossfade * i)).toFixed(3);
      const next = i === n - 1 ? 'vout' : `vx${i}`;
      xfade += `[${prev}][vs${i}]xfade=transition=fade:duration=${crossfade}:offset=${offset}[${next}];`;
      prev = next;
    }
  }

  const fc1 = n === 1 ? scales : `${scales};${xfade.slice(0, -1)}`;
  const outLabel = n === 1 ? 'vs0' : 'vout';

  const cmd1 = [
    `"${FFMPEG}"`,
    inputs,
    `-i "${fwd(audioPath)}"`,
    `-filter_complex "${fc1}"`,
    `-map "[${outLabel}]" -map ${n}:a`,
    `-c:v libx264 -preset fast -crf 22`,
    `-c:a aac -b:a 192k`,
    `-shortest -y "${fwd(tempPath)}" -loglevel warning`
  ].join(' ');

  runCmd(dir, 'pass1', cmd1);

  if (!fs.existsSync(tempPath)) throw new Error('Pass 1 failed — temp video not created. Check image paths.');

  // ── Pass 2: burn subtitles ─────────────────────────────────────────────────

  const srtEsc = IS_WIN ? fwd(srtPath).replace(/^([A-Za-z]):/, '$1\\:') : fwd(srtPath);
  const style = 'FontName=Arial,FontSize=22,PrimaryColour=&Hffffff,OutlineColour=&H000000,Outline=3,Bold=1,Alignment=2,MarginV=130';

  const cmd2 = [
    `"${FFMPEG}"`,
    `-i "${fwd(tempPath)}"`,
    `-vf "subtitles='${srtEsc}':force_style='${style}'"`,
    `-c:v libx264 -preset fast -crf 22`,
    `-c:a copy`,
    `-y "${fwd(videoPath)}" -loglevel warning`
  ].join(' ');

  runCmd(dir, 'pass2', cmd2);

  try { fs.unlinkSync(tempPath); } catch {}

  if (!fs.existsSync(videoPath)) throw new Error('Pass 2 failed — final video not created.');
  return videoPath;
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function runReelFactory(topic, imagePaths, onProgress, existingDir = null) {
  const dir = existingDir ?? outDir(topic);
  onProgress?.(`📁 Saving to workspace...`);

  const script = await generateReelScript(topic, onProgress);
  const audio  = await generateAudio(script, dir, onProgress);
  const srt    = await generateSubtitles(audio, dir, onProgress);

  const images = (imagePaths && imagePaths.length > 0)
    ? imagePaths
    : await generateAIImages(topic, dir, 4, onProgress);

  onProgress?.(`🖼 Using ${images.length} image(s)...`);
  const video = await renderVideo(images, audio, srt, dir, onProgress);

  fs.writeFileSync(path.join(dir, 'script.txt'), script);
  return { dir, video, audio, script };
}
