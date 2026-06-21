import { fal } from '@fal-ai/client';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { downloadUrl, outDir, generateSubtitles } from './factory.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const IS_WIN  = process.platform === 'win32';
const FFMPEG  = IS_WIN ? path.join(process.cwd(), 'bin', 'ffmpeg.exe')  : 'ffmpeg';
const FFPROBE = IS_WIN ? path.join(process.cwd(), 'bin', 'ffprobe.exe') : 'ffprobe';

function fwd(p) { return p.replace(/\\/g, '/'); }

function runFFmpeg(cmd) {
  execSync(cmd, { shell: true, timeout: 300000, maxBuffer: 20 * 1024 * 1024 });
}

function getVideoDuration(filePath) {
  const out = execSync(`"${FFPROBE}" -v quiet -show_entries format=duration -of csv=p=0 "${fwd(filePath)}"`).toString().trim();
  return parseFloat(out);
}

// Parse scenes from user's message (strips scene labels like "1.", "Hook:", etc.)
export function parseScenes(text) {
  return text.split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.replace(/^(scene\s*\d+|hook|point\s*\d*|cta|outro|\d+)[:\.\)]\s*/i, '').trim())
    .filter(Boolean);
}

// GPT generates a cinematic visual prompt for each scene
async function sceneToVisualPrompt(scene, index, total, topic) {
  const isHook = index === 0;
  const system = isHook
    ? 'You write ultra-cinematic AI video prompts. The hook must be VISUALLY SHOCKING and emotionally powerful — something that stops the scroll instantly. Dark, dramatic, high contrast, photorealistic. No text or words in the scene. Vertical 9:16 format. Output ONLY the prompt.'
    : 'You write cinematic AI video prompts. Match the emotion and meaning of the script line. Dramatic, high quality, photorealistic. No text or words in the scene. Vertical 9:16 format. Output ONLY the prompt.';

  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Topic: "${topic}"\nScene (${index + 1}/${total}): "${scene}"\n\nWrite the visual prompt:` }
    ],
    max_tokens: 120
  });
  return res.choices[0].message.content.trim();
}

// Generate one video clip via fal.ai Kling
async function generateClip(prompt, clipSeconds, dir, index, onProgress) {
  onProgress?.(`🎬 Scene ${index + 1}: generating AI video...`);
  fal.config({ credentials: process.env.FAL_API_KEY });

  const result = await fal.subscribe('fal-ai/kling-video/v1.6/standard/text-to-video', {
    input: {
      prompt,
      negative_prompt: 'text, watermark, logo, blur, low quality, cartoon',
      duration: clipSeconds >= 8 ? '10' : '5',
      aspect_ratio: '9:16'
    },
    logs: false,
    onQueueUpdate: () => {}
  });

  const url = result.data?.video?.url;
  if (!url) throw new Error(`fal.ai returned no video URL for scene ${index + 1}`);

  const clipPath = path.join(dir, `clip_${index}.mp4`);
  await downloadUrl(url, clipPath);
  onProgress?.(`✅ Scene ${index + 1} ready`);
  return clipPath;
}

// Trim or loop a clip to exact duration
function fitClip(inputPath, targetSec, outputPath) {
  const actual = getVideoDuration(inputPath);
  if (actual >= targetSec) {
    runFFmpeg(`"${FFMPEG}" -i "${fwd(inputPath)}" -t ${targetSec.toFixed(3)} -c:v libx264 -preset fast -crf 22 -an -y "${fwd(outputPath)}" -loglevel warning`);
  } else {
    runFFmpeg(`"${FFMPEG}" -stream_loop -1 -i "${fwd(inputPath)}" -t ${targetSec.toFixed(3)} -c:v libx264 -preset fast -crf 22 -an -y "${fwd(outputPath)}" -loglevel warning`);
  }
}

// Concatenate fitted clips + mix audio + burn subtitles
function renderFinal(fittedPaths, audioPath, srtPath, dir) {
  const concatFile = path.join(dir, 'concat.txt');
  const tempPath   = path.join(dir, 'temp_joined.mp4');
  const videoPath  = path.join(dir, 'reel.mp4');

  fs.writeFileSync(concatFile, fittedPaths.map(p => `file '${fwd(p)}'`).join('\n'));

  // Join clips
  runFFmpeg(`"${FFMPEG}" -f concat -safe 0 -i "${fwd(concatFile)}" -i "${fwd(audioPath)}" -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 192k -shortest -y "${fwd(tempPath)}" -loglevel warning`);

  // Burn subtitles
  const srtEsc = IS_WIN ? fwd(srtPath).replace(/^([A-Za-z]):/, '$1\\:') : fwd(srtPath);
  const style  = 'FontName=Arial,FontSize=12,PrimaryColour=&Hffffff,OutlineColour=&H000000,Outline=3,Shadow=2,Bold=1,Alignment=2,MarginL=30,MarginR=30,MarginV=32';
  runFFmpeg(`"${FFMPEG}" -i "${fwd(tempPath)}" -vf "subtitles='${srtEsc}':force_style='${style}'" -c:v libx264 -preset fast -crf 22 -c:a copy -y "${fwd(videoPath)}" -loglevel warning`);

  // Cleanup
  [concatFile, tempPath, ...fittedPaths].forEach(p => { try { fs.unlinkSync(p); } catch {} });

  if (!fs.existsSync(videoPath)) throw new Error('Final render failed — reel.mp4 not created');
  return videoPath;
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function buildCustomReel(scenes, targetSeconds, topic, onProgress) {
  const dir = outDir(topic);

  // ── Step 1: voiceover ──────────────────────────────────────────────────────
  onProgress?.('🎙 Generating voiceover...');
  const fullScript = scenes.join(' ');
  const wordCount  = fullScript.split(/\s+/).length;

  // Estimate natural duration at 120 WPM (dramatic speech is slower)
  const naturalDuration = (wordCount / 120) * 60;
  const speed = Math.min(4.0, Math.max(0.25, parseFloat((naturalDuration / targetSeconds).toFixed(2))));

  const mp3 = await openai.audio.speech.create({
    model: 'tts-1-hd',
    voice: 'onyx',
    input: fullScript,
    speed
  });
  const audioPath = path.join(dir, 'voiceover.mp3');
  fs.writeFileSync(audioPath, Buffer.from(await mp3.arrayBuffer()));

  const actualDuration = getVideoDuration(audioPath);
  onProgress?.(`🎙 Voiceover: ${actualDuration.toFixed(1)}s (target ${targetSeconds}s, speed ${speed}x)`);

  // ── Step 2: subtitles ──────────────────────────────────────────────────────
  const srtPath = await generateSubtitles(audioPath, dir, onProgress);

  // ── Step 3: AI video per scene (parallel) ──────────────────────────────────
  onProgress?.(`🎨 Generating ${scenes.length} AI video scenes in parallel...`);
  const secPerScene = actualDuration / scenes.length;
  const clipSec     = secPerScene >= 8 ? 10 : 5;

  const prompts = await Promise.all(
    scenes.map((s, i) => sceneToVisualPrompt(s, i, scenes.length, topic))
  );

  const clipPaths = await Promise.all(
    prompts.map((p, i) => generateClip(p, clipSec, dir, i, onProgress))
  );

  // ── Step 4: trim clips to scene duration ───────────────────────────────────
  onProgress?.('✂️ Fitting clips to audio...');
  const fittedPaths = clipPaths.map((cp, i) => {
    const isLast   = i === clipPaths.length - 1;
    const duration = isLast
      ? actualDuration - secPerScene * i
      : secPerScene;
    const out = path.join(dir, `fitted_${i}.mp4`);
    fitClip(cp, duration, out);
    try { fs.unlinkSync(cp); } catch {}
    return out;
  });

  // ── Step 5: render final reel ──────────────────────────────────────────────
  onProgress?.('🎬 Rendering final reel...');
  const videoPath = renderFinal(fittedPaths, audioPath, srtPath, dir);

  fs.writeFileSync(path.join(dir, 'script.txt'), fullScript);
  return { dir, video: videoPath, audio: audioPath, script: fullScript };
}
