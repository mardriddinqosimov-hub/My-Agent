import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import https from 'https';
import OpenAI from 'openai';
import { chat } from './core.js';
import { runReelFactory, outDir, generateAIImages } from './content/factory.js';
import { uploadToYouTube } from './youtube/uploader.js';
import { runOrchestrator } from './agents/orchestrator.js';
import { log } from './events.js';
import { setBot, setOpenAI } from './telegram/client.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) { console.error('TELEGRAM_BOT_TOKEN not set'); process.exit(1); }
if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY not set'); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });
setBot(bot);
setOpenAI(openai);
const ALLOWED_ID = 1125665706;

// ── State ──────────────────────────────────────────────────────────────────────

const histories = new Map();
function getHistory(chatId) {
  if (!histories.has(chatId)) histories.set(chatId, []);
  return histories.get(chatId);
}

// Content creation sessions: chatId -> { topic, dir, images: [], state }
// states: 'awaiting_choice' | 'awaiting_images' | 'generating'
const contentSessions = new Map();

// Pending YouTube uploads: shortId -> { videoPath, title }
const pendingUploads = new Map();
let uploadIdCounter = 0;
function storeUpload(videoPath, title) {
  const id = (++uploadIdCounter).toString();
  pendingUploads.set(id, { videoPath, title });
  return id;
}

// chatIds that tapped 🧠 Multi-Agent and are waiting to provide a task
const orchestratorPending = new Set();


// ── Group registry ─────────────────────────────────────────────────────────────

const GROUPS_FILE = path.join(process.cwd(), 'workspace', 'groups.json');
function loadGroups() { try { return JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf-8')); } catch { return {}; } }
function saveGroups(g) { fs.mkdirSync(path.dirname(GROUPS_FILE), { recursive: true }); fs.writeFileSync(GROUPS_FILE, JSON.stringify(g, null, 2)); }
function registerGroup(id, title) {
  const g = loadGroups();
  if (!g[title]) { g[title] = id; saveGroups(g); console.log(`[GROUP] "${title}" (${id})`); }
}
function resolveGroup(name) {
  const g = loadGroups();
  const m = Object.entries(g).find(([k]) => k.toLowerCase().includes(name.toLowerCase()));
  if (!m) return { error: `Group not found. Known: ${Object.keys(g).join(', ') || 'none'}` };
  return { name: m[0], chatId: m[1] };
}

bot.on('my_chat_member', (upd) => {
  if ((upd.chat.type === 'group' || upd.chat.type === 'supergroup') && upd.new_chat_member?.status === 'member')
    registerGroup(upd.chat.id, upd.chat.title);
});
bot.on('message', (msg) => {
  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') registerGroup(msg.chat.id, msg.chat.title);
});

// ── Custom agent tools ─────────────────────────────────────────────────────────

const groupTools = {
  create_content: async ({ topic }) => `__CONTENT__:${topic}`,

  send_to_group: async ({ group, message }) => {
    const g = resolveGroup(group);
    if (g.error) return g.error;
    await bot.sendMessage(g.chatId, message);
    return `Sent to "${g.name}"`;
  },

  send_voice_to_group: async ({ group, text, voice = 'alloy' }) => {
    const g = resolveGroup(group);
    if (g.error) return g.error;
    const tmp = path.join(process.cwd(), 'workspace', `tts_${Date.now()}.mp3`);
    const mp3 = await openai.audio.speech.create({ model: 'tts-1', voice, input: text });
    fs.writeFileSync(tmp, Buffer.from(await mp3.arrayBuffer()));
    await bot.sendVoice(g.chatId, tmp);
    fs.unlinkSync(tmp);
    return `Voice sent to "${g.name}"`;
  },

  list_groups: async () => {
    const e = Object.entries(loadGroups());
    return e.length ? e.map(([n, id]) => `• ${n} (${id})`).join('\n') : 'No groups yet.';
  }
};

// ── Bot command menu ───────────────────────────────────────────────────────────

bot.setMyCommands([
  { command: 'start',   description: 'Start the assistant' },
  { command: 'clear',   description: 'Reset conversation history' },
  { command: 'help',    description: 'Show available tools' },
  { command: 'groups',  description: 'List connected Telegram groups' },
  { command: 'content', description: 'Create a reel — /content [topic]' },
]);

// ── Keyboards ──────────────────────────────────────────────────────────────────

const replyKeyboard = {
  keyboard: [
    [{ text: '🗑 Clear history' }, { text: '🛠 Tools' }],
    [{ text: '❓ Who are you?' },  { text: '👥 My groups' }],
    [{ text: '🎬 Create Reel' }, { text: '🧠 Multi-Agent' }],
  ],
  resize_keyboard: true,
  persistent: true,
};

// ── UI helpers ─────────────────────────────────────────────────────────────────

function sendStart(chatId) {
  bot.sendMessage(chatId,
    `👋 *AI Agent for Mardriddin — online*\n\n` +
    `• Chat with me naturally\n` +
    `• Send voice messages\n` +
    `• Create reels with AI images\n` +
    `• Send messages to your groups`,
    { parse_mode: 'Markdown', reply_markup: replyKeyboard }
  );
}

function sendHelp(chatId) {
  bot.sendMessage(chatId,
    `*Tools*\n\n📂 files · ⚡ run JS · 🌐 fetch URL · 📝 notes\n👥 groups · 🎬 reel factory · 🎙 voice`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🏠 Back', callback_data: 'start' }]] } }
  );
}

function sendCleared(chatId) {
  bot.sendMessage(chatId, '🗑 Cleared.', { reply_markup: replyKeyboard });
}

function sendGroupsList(chatId) {
  const e = Object.entries(loadGroups());
  bot.sendMessage(chatId,
    e.length ? `*Groups:*\n` + e.map(([n]) => `• ${n}`).join('\n') : 'No groups yet.',
    { parse_mode: 'Markdown', reply_markup: replyKeyboard }
  );
}

// ── Commands ───────────────────────────────────────────────────────────────────

bot.onText(/\/start/,         (msg) => { if (msg.from?.id !== ALLOWED_ID) return; sendStart(msg.chat.id); });
bot.onText(/\/clear/,         (msg) => { if (msg.from?.id !== ALLOWED_ID) return; histories.delete(msg.chat.id); sendCleared(msg.chat.id); });
bot.onText(/\/help/,          (msg) => { if (msg.from?.id !== ALLOWED_ID) return; sendHelp(msg.chat.id); });
bot.onText(/\/groups/,        (msg) => { if (msg.from?.id !== ALLOWED_ID) return; sendGroupsList(msg.chat.id); });
bot.onText(/\/content (.+)/,  (msg, match) => {
  if (msg.from?.id !== ALLOWED_ID) return;
  const full = match[1].trim();
  // Extract "send to [group]" / "then send [to] [group]" from the instruction
  const sendMatch = full.match(/(?:then\s+)?send\s+(?:the\s+)?(?:video|vedio|reel)?\s*(?:to\s+)?(?:the\s+)?(.+?)(?:\s+group)?$/i);
  const topic = full.replace(/[,.]?\s*(?:then\s+)?(?:and\s+)?send\s+(?:the\s+)?(?:video|vedio|reel)?\s*(?:to\s+)?(?:the\s+)?.+$/i, '').trim();
  const sendToGroup = sendMatch ? sendMatch[1].trim() : null;
  askImageChoice(msg.chat.id, topic || full, sendToGroup);
});
bot.onText(/^\/content$/,     (msg) => { if (msg.from?.id !== ALLOWED_ID) return; bot.sendMessage(msg.chat.id, 'Usage: /content [topic]'); });

// ── Content Factory — step 1: ask image source ────────────────────────────────

function askImageChoice(chatId, topic, sendToGroup = null) {
  contentSessions.set(chatId, { topic, dir: outDir(topic), images: [], state: 'awaiting_choice', sendToGroup });
  bot.sendMessage(chatId,
    `🎬 *Reel topic:* _${topic}_\n\nBackground images:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🤖 Generate with AI', callback_data: 'reel_ai' },
          { text: '📸 Send my own photos', callback_data: 'reel_own' },
        ]]
      }
    }
  );
}

// ── Content Factory — step 2: generate or collect images ─────────────────────

async function startWithAI(chatId) {
  const session = contentSessions.get(chatId);
  if (!session) return;
  session.state = 'generating';

  const statusMsg = await bot.sendMessage(chatId, '🤖 Generating AI images...');

  try {
    const images = await generateAIImages(session.topic, session.dir, 4, async (msg) => {
      await bot.editMessageText(msg, { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => {});
    });
    session.images = images;

    // Preview the images
    const media = images.map((p, i) => ({ type: 'photo', media: p, caption: i === 0 ? `🎨 AI images for: ${session.topic}` : '' }));
    await bot.sendMediaGroup(chatId, media);

    await runReel(chatId, session);
  } catch (err) {
    bot.sendMessage(chatId, `⚠️ ${err.message}`);
    console.error('[REEL AI]', err.message);
  }
}

function askForImages(chatId) {
  const session = contentSessions.get(chatId);
  if (!session) return;
  session.state = 'awaiting_images';
  bot.sendMessage(chatId,
    `📸 Send your photos now (one by one or as an album).\nTap *Done* when finished.`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '✅ Done — create reel', callback_data: 'reel_done' }]] }
    }
  );
}

// ── Content Factory — step 3: run pipeline ────────────────────────────────────

async function runReel(chatId, session) {
  session.state = 'generating';
  log('reel', `Starting: ${session.topic}`);
  const statusMsg = await bot.sendMessage(chatId, '⚙️ Starting reel pipeline...');

  try {
    // Filter out any null placeholders (failed downloads) and pass the session dir
    const validImages = session.images.filter(Boolean);
    const result = await runReelFactory(session.topic, validImages, async (msg) => {
      await bot.editMessageText(msg, { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => {});
    }, session.dir);

    const sendToGroup = session.sendToGroup;
    contentSessions.delete(chatId);

    await bot.sendAudio(chatId, result.audio, { caption: '🎙 Voiceover' });
    await bot.sendVideo(chatId, result.video, { caption: `🎬 *${session.topic}*`, parse_mode: 'Markdown' });

    // Send to Telegram group if requested
    if (sendToGroup) {
      const g = resolveGroup(sendToGroup);
      if (g.error) {
        await bot.sendMessage(chatId, `⚠️ Could not find group "${sendToGroup}": ${g.error}`);
      } else {
        await bot.sendVideo(g.chatId, result.video, { caption: `🎬 ${session.topic}` });
        await bot.sendMessage(chatId, `✅ Reel sent to *${g.name}*`, { parse_mode: 'Markdown' });
        log('reel', `Sent to group: ${g.name}`);
      }
    }

    // Ask about YouTube — don't auto-upload
    const upId = storeUpload(result.video, session.topic);
    await bot.sendMessage(chatId, `✅ Reel ready! Upload to YouTube?`, {
      reply_markup: {
        inline_keyboard: [[
          { text: '📺 Yes, upload to YouTube', callback_data: `yt_upload:${upId}` },
          { text: '✖ No thanks', callback_data: 'yt_skip' }
        ]]
      }
    });
  } catch (err) {
    contentSessions.delete(chatId);
    bot.sendMessage(chatId, `⚠️ Render error: ${err.message}`);
    console.error('[REEL]', err.message);
  }
}

// ── Photo handler (for user-provided images) ───────────────────────────────────

bot.on('photo', async (msg) => {
  if (msg.chat.type !== 'private' || msg.from?.id !== ALLOWED_ID) return;
  const session = contentSessions.get(msg.chat.id);
  if (!session || session.state !== 'awaiting_images') return;

  const chatId = msg.chat.id;

  // Reserve index immediately to avoid race condition with album uploads
  const idx = session.images.length;
  session.images.push(null);

  const fileId = msg.photo[msg.photo.length - 1].file_id;
  const fileInfo = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;
  const imgPath = path.join(session.dir, `user_${idx}.jpg`);

  await downloadFile(fileUrl, imgPath);
  session.images[idx] = imgPath;

  const photoCount = session.images.filter(Boolean).length;
  bot.sendMessage(chatId,
    `✅ Photo ${photoCount} received. Send more or tap *Done*.`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Done — create reel', callback_data: 'reel_done' }]] } }
  );
});

// ── Callback query handler ─────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  await bot.answerCallbackQuery(query.id);

  // Forward voice to group
  if (query.data.startsWith('fwd_voice:')) {
    const parts = query.data.split(':');
    const groupName = parts[parts.length - 1];
    const filePath = parts.slice(1, -1).join(':');
    const g = resolveGroup(groupName);
    if (g.error) return bot.sendMessage(chatId, `⚠️ ${g.error}`);
    const tmpPath = path.join(process.cwd(), 'workspace', `fwd_${Date.now()}.oga`);
    await downloadFile(`https://api.telegram.org/file/bot${TOKEN}/${filePath}`, tmpPath);
    await bot.sendVoice(g.chatId, tmpPath);
    fs.unlinkSync(tmpPath);
    return bot.sendMessage(chatId, `✅ Voice forwarded to "${g.name}"`);
  }

  // Content factory buttons
  if (query.data === 'reel_ai') return startWithAI(chatId);

  if (query.data === 'reel_own') return askForImages(chatId);

  if (query.data === 'reel_done') {
    const session = contentSessions.get(chatId);
    if (!session) return bot.sendMessage(chatId, '⚠️ No active session. Use /content [topic]');
    if (session.state === 'generating') return; // already running — ignore duplicate tap

    const validImages = session.images.filter(Boolean);
    const pending = session.images.length - validImages.length;

    if (session.images.length === 0) {
      return bot.sendMessage(chatId, '⚠️ No photos received yet. Send at least one photo.');
    }
    if (pending > 0) {
      return bot.sendMessage(chatId, `⏳ Still uploading ${pending} photo(s)… tap Done again in a moment.`);
    }

    session.state = 'generating'; // lock before async work to prevent double-trigger
    return runReel(chatId, session);
  }

  if (query.data.startsWith('yt_upload:')) {
    const upId = query.data.split(':')[1];
    const upload = pendingUploads.get(upId);
    if (!upload) return bot.sendMessage(chatId, '⚠️ Upload session expired. Re-run /content.');
    pendingUploads.delete(upId);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
    const uploading = await bot.sendMessage(chatId, '📤 Uploading to YouTube…');
    try {
      const { url } = await uploadToYouTube({ videoPath: upload.videoPath, title: upload.title, privacyStatus: 'public' });
      log('youtube', `Published: ${url}`);
      await bot.editMessageText(`📺 Published!\n${url}`, { chat_id: chatId, message_id: uploading.message_id });
    } catch (ytErr) {
      await bot.editMessageText(`⚠️ YouTube upload failed: ${ytErr.message}`, { chat_id: chatId, message_id: uploading.message_id });
      console.error('[YT]', ytErr.message);
    }
    return;
  }

  if (query.data === 'yt_skip') {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
    return;
  }

  switch (query.data) {
    case 'start': sendStart(chatId); break;
    case 'clear': histories.delete(chatId); sendCleared(chatId); break;
    case 'help':  sendHelp(chatId); break;
  }
});

// ── Text message handler ───────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  if (msg.chat.type !== 'private') return;
  if (!msg.text || msg.text.startsWith('/')) return;
  if (msg.from?.id !== ALLOWED_ID) return;

  const chatId = msg.chat.id;

  // Keyboard buttons
  if (msg.text === '🗑 Clear history') { histories.delete(chatId); return sendCleared(chatId); }
  if (msg.text === '🛠 Tools')         return sendHelp(chatId);
  if (msg.text === '👥 My groups')     return sendGroupsList(chatId);
  if (msg.text === '🎬 Create Reel')   return bot.sendMessage(chatId, 'Send me the topic:\n/content [topic]');
  if (msg.text === '🧠 Multi-Agent') {
    orchestratorPending.add(chatId);
    return bot.sendMessage(chatId, '🧠 Describe your task — I will coordinate specialists to handle it:', { reply_markup: replyKeyboard });
  }

  log('message', msg.text.slice(0, 80));
  const history = getHistory(chatId);
  const typingInterval = setInterval(() => bot.sendChatAction(chatId, 'typing'), 4000);
  bot.sendChatAction(chatId, 'typing');

  try {
    let reply;
    if (orchestratorPending.has(chatId)) {
      orchestratorPending.delete(chatId);
      const statusMsg = await bot.sendMessage(chatId, '🧠 Coordinating specialists...');
      reply = await runOrchestrator(msg.text, async (update) => {
        await bot.editMessageText(update, { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => {});
      });
    } else {
      reply = await chat(msg.text, history, () => bot.sendChatAction(chatId, 'typing'), groupTools);
    }
    clearInterval(typingInterval);
    log('reply', reply.slice(0, 80));

    if (reply.startsWith('__CONTENT__:')) {
      return askImageChoice(chatId, reply.replace('__CONTENT__:', '').trim());
    }

    for (const chunk of splitMessage(reply)) {
      try { await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' }); }
      catch { await bot.sendMessage(chatId, chunk); }
    }
  } catch (err) {
    clearInterval(typingInterval);
    await bot.sendMessage(chatId, `⚠️ ${err.message}`);
    console.error(`[MSG]`, err.message);
  }
});

// ── Voice message handler ──────────────────────────────────────────────────────

bot.on('voice', async (msg) => {
  if (msg.chat.type !== 'private' || msg.from?.id !== ALLOWED_ID) return;
  const chatId = msg.chat.id;
  bot.sendChatAction(chatId, 'typing');

  try {
    const fileInfo = await bot.getFile(msg.voice.file_id);
    const tmpPath = path.join(process.cwd(), 'workspace', `voice_${Date.now()}.oga`);
    await downloadFile(`https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`, tmpPath);

    const transcription = await openai.audio.transcriptions.create({ file: fs.createReadStream(tmpPath), model: 'whisper-1' });
    fs.unlinkSync(tmpPath);

    const text = transcription.text?.trim();
    if (!text) return bot.sendMessage(chatId, '⚠️ Could not transcribe.');

    const groups = loadGroups();
    const fwdButtons = Object.keys(groups).map(name => ([{
      text: `📤 Forward to ${name}`,
      callback_data: `fwd_voice:${fileInfo.file_path}:${name}`
    }]));

    await bot.sendMessage(chatId, `🎙 _"${text}"_`, {
      parse_mode: 'Markdown',
      reply_markup: fwdButtons.length ? { inline_keyboard: fwdButtons } : undefined
    });

    const history = getHistory(chatId);
    const typingInterval = setInterval(() => bot.sendChatAction(chatId, 'typing'), 4000);
    const reply = await chat(text, history, () => bot.sendChatAction(chatId, 'typing'), groupTools);
    clearInterval(typingInterval);

    for (const chunk of splitMessage(reply)) {
      try { await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' }); }
      catch { await bot.sendMessage(chatId, chunk); }
    }
  } catch (err) {
    bot.sendMessage(chatId, `⚠️ Voice error: ${err.message}`);
    console.error('[VOICE]', err.message);
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

function splitMessage(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let r = text;
  while (r.length > 0) {
    let cut = maxLen;
    const nl = r.lastIndexOf('\n', maxLen);
    if (nl > maxLen * 0.7) cut = nl + 1;
    chunks.push(r.slice(0, cut));
    r = r.slice(cut);
  }
  return chunks;
}

// ── Startup ────────────────────────────────────────────────────────────────────

console.log(`[${new Date().toISOString()}] Bot started — polling Telegram...`);
console.log(`Model: ${process.env.OPENAI_MODEL || 'gpt-4o'} | Groups: ${Object.keys(loadGroups()).length}`);
global.botStarted = true;
log('system', `Telegram bot online — model: ${process.env.OPENAI_MODEL || 'gpt-4o'}`);
bot.on('polling_error', err => console.error('Polling error:', err.message));
