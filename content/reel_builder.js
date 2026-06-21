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

export function parseScenes(text) {
  return text.split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.replace(/^(scene\s*\d+|hook|point\s*\d*|cta|outro|\d+)[:\.\)]\s*/i, '').trim())
    .filter(Boolean);
}

async function sceneToVisualPrompt(scene, index, total, topic) {
  const isHook = index === 0;
  const system = isHook
    ? 'You write ultra-cinematic AI image prompts. The hook must be VISUALLY SHOCKING and emotionally powerful — something that stops the scroll instantly. Dark, dramatic, high contrast, photorealistic. No text or words in the image. Vertical 9:16 portrait format. Output ONLY the prompt, under 80 words.'
    : 'You write cinematic AI image prompts. Match the emotion and meaning of the script line. Dramatic, high quality, photorealistic. No text or words in the image. Vertical 9:16 portrait format. Output ONLY the prompt, under 80 words.';

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

// Generate one AI image via FLUX then animate with Ken Burns zoom/pan
async function generateClip(prompt, clipSeconds, dir, index, onProgress) {
  onProgress?.(`🎨 Scene ${index + 1}: generating AI image...`);
  fal.config({ credentials: process.env.FAL_API_KEY });

  const result = await fal.subscribe('fal-ai/flux/schnell', {
    input: {
      prompt,
      image_size: { width: 576, height: 1024 },
      num_inference_steps: 4,
      num_images: 1
    },
    logs: false,
    onQueueUpdate: () => {}
  });

  const url = result.data?.images?.[0]?.url;
  if (!url) throw new Error(`fal.ai returned no image URL for scene ${index + 1}`);

  const imgPath = path.join(dir, `img_${index}.jpg`);
  await downloadUrl(url, imgPath);

  // Ken Burns: alternate zoom-in and zoom-out with slight pans
  const clipPath = path.join(dir, `clip_${index}.mp4`);
  const frames = Math.ceil(clipSeconds * 25);
  const zooms = [
    `zoompan=z='min(zoom+0.0015,1.5)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
    `zoompan=z='if(lte(zoom,1.0),1.5,max(1.001,zoom-0.0015))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
    `zoompan=z='min(zoom+0.0015,1.5)':x='0':y='0'`,
    `zoompan=z='min(zoom+0.0015,1.5)':x='iw-(iw/zoom)':y='ih-(ih/zoom)'`,
  ];
  const zf = zooms[index % zooms.length];

  runFFmpeg(`"${FFMPEG}" -loop 1 -i "${fwd(imgPath)}" -vf "${zf}:d=${frames}:s=1080x1920,fps=25,scale=1080:1920" -t ${clipSeconds.toFixed(3)} -c:v libx264 -preset fast -crf 22 -an -y "${fwd(clipPath)}" -loglevel warning`);

  try { fs.unlinkSync(imgPath); } catch {}
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

function renderFinal(fittedPaths, audioPath, srtPath, dir) {
  const concatFile = path.join(dir, 'concat.txt');
  const tempPath   = path.join(dir, 'temp_joined.mp4');
  const videoPath  = path.join(dir, 'reel.mp4');

  fs.writeFileSync(concatFile, fittedPaths.map(p => `file '${fwd(p)}'`).join('\n'));

  runFFmpeg(`"${FFMPEG}" -f concat -safe 0 -i "${fwd(concatFile)}" -i "${fwd(audioPath)}" -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 192k -shortest -y "${fwd(tempPath)}" -loglevel warning`);

  const srtEsc = IS_WIN ? fwd(srtPath).replace(/^([A-Za-z]):/, '$1\\:') : fwd(srtPath);
  const style  = 'FontName=Times New Roman,FontSize=12,Italic=1,PrimaryColour=&H00EEE8D5,OutlineColour=&H00000000,Outline=1,Shadow=1,Bold=0,Alignment=2,MarginL=50,MarginR=50,MarginV=40';
  runFFmpeg(`"${FFMPEG}" -i "${fwd(tempPath)}" -vf "subtitles='${srtEsc}':force_style='${style}'" -c:v libx264 -preset fast -crf 22 -c:a copy -y "${fwd(videoPath)}" -loglevel warning`);

  [concatFile, tempPath, ...fittedPaths].forEach(p => { try { fs.unlinkSync(p); } catch {} });

  if (!fs.existsSync(videoPath)) throw new Error('Final render failed — reel.mp4 not created');
  return videoPath;
}

export async function buildCustomReel(scenes, targetSeconds, topic, onProgress) {
  const dir = outDir(topic);

  // Step 1: voiceover
  onProgress?.('🎙 Generating voiceover...');
  const fullScript = scenes.join(' ');
  const wordCount  = fullScript.split(/\s+/).length;
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

  // Step 2: subtitles
  const srtPath = await generateSubtitles(audioPath, dir, onProgress);

  // Step 3: AI images + Ken Burns animation (parallel)
  onProgress?.(`🎨 Generating ${scenes.length} AI scenes in parallel...`);
  const secPerScene = actualDuration / scenes.length;

  const prompts = await Promise.all(
    scenes.map((s, i) => sceneToVisualPrompt(s, i, scenes.length, topic))
  );

  const clipPaths = await Promise.all(
    prompts.map((p, i) => generateClip(p, secPerScene, dir, i, onProgress))
  );

  // Step 4: fit clips to exact scene duration
  onProgress?.('✂️ Fitting clips to audio...');
  const fittedPaths = clipPaths.map((cp, i) => {
    const isLast   = i === clipPaths.length - 1;
    const duration = isLast ? actualDuration - secPerScene * i : secPerScene;
    const out = path.join(dir, `fitted_${i}.mp4`);
    fitClip(cp, duration, out);
    try { fs.unlinkSync(cp); } catch {}
    return out;
  });

  // Step 5: render final reel
  onProgress?.('🎬 Rendering final reel...');
  const videoPath = renderFinal(fittedPaths, audioPath, srtPath, dir);

  fs.writeFileSync(path.join(dir, 'script.txt'), fullScript);
  return { dir, video: videoPath, audio: audioPath, script: fullScript };
}
