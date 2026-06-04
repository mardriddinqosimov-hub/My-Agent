import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import fetch from 'node-fetch';
import { getBot, getOpenAI } from '../telegram/client.js';

const SHARED = path.join(process.cwd(), 'workspace', 'shared');

export function ensureShared() { fs.mkdirSync(SHARED, { recursive: true }); }
export function sharedPath(f)  { ensureShared(); return path.join(SHARED, f); }

// ── Tool definitions (sent to OpenAI) ─────────────────────────────────────────

const DEF = {
  fetch_url: {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch the text content of a URL.',
      parameters: {
        type: 'object',
        properties: {
          url:       { type: 'string' },
          max_chars: { type: 'number', description: 'Max chars to return (default 4000)' }
        },
        required: ['url']
      }
    }
  },
  write_shared: {
    type: 'function',
    function: {
      name: 'write_shared',
      description: 'Save output to a shared file so other agents can read it.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Filename inside workspace/shared/' },
          content:  { type: 'string' }
        },
        required: ['filename', 'content']
      }
    }
  },
  read_shared: {
    type: 'function',
    function: {
      name: 'read_shared',
      description: 'Read a file from the shared folder written by another agent.',
      parameters: {
        type: 'object',
        properties: { filename: { type: 'string' } },
        required: ['filename']
      }
    }
  },
  list_shared: {
    type: 'function',
    function: {
      name: 'list_shared',
      description: 'List all files currently in the shared folder.',
      parameters: { type: 'object', properties: {} }
    }
  },
  run_js: {
    type: 'function',
    function: {
      name: 'run_js',
      description: 'Execute a JavaScript snippet and return stdout.',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string' } },
        required: ['code']
      }
    }
  },

  send_to_group: {
    type: 'function',
    function: {
      name: 'send_to_group',
      description: 'Send a text message to a Telegram group.',
      parameters: {
        type: 'object',
        properties: {
          group:   { type: 'string', description: 'Group name (partial match is fine)' },
          message: { type: 'string' }
        },
        required: ['group', 'message']
      }
    }
  },

  send_voice_to_group: {
    type: 'function',
    function: {
      name: 'send_voice_to_group',
      description: 'Generate a TTS voice message and send it to a Telegram group.',
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string', description: 'Group name (partial match is fine)' },
          text:  { type: 'string', description: 'Text to speak' },
          voice: { type: 'string', enum: ['alloy','echo','fable','onyx','nova','shimmer'], description: 'TTS voice (default: onyx)' }
        },
        required: ['group', 'text']
      }
    }
  }
};

// ── Tool handlers ──────────────────────────────────────────────────────────────

const HANDLERS = {
  fetch_url: async ({ url, max_chars = 4000 }) => {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = await res.text();
    const clean = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return clean.slice(0, max_chars) + (clean.length > max_chars ? '\n...[truncated]' : '');
  },

  write_shared: ({ filename, content }) => {
    fs.writeFileSync(sharedPath(filename), content, 'utf-8');
    return `Saved to shared/${filename}`;
  },

  read_shared: ({ filename }) => {
    const p = sharedPath(filename);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : `File not found: ${filename}`;
  },

  list_shared: () => {
    ensureShared();
    const files = fs.readdirSync(SHARED);
    return files.length ? files.join('\n') : '(empty)';
  },

  run_js: ({ code }) => {
    try {
      return execSync(`node -e "${code.replace(/"/g, '\\"')}"`, { timeout: 10000, encoding: 'utf-8' }) || '(no output)';
    } catch (e) {
      return `Error: ${e.stderr || e.message}`;
    }
  },

  send_to_group: async ({ group, message }) => {
    const bot = getBot();
    if (!bot) return 'Telegram bot not available';
    const gFile = path.join(process.cwd(), 'workspace', 'groups.json');
    const groups = JSON.parse(fs.readFileSync(gFile, 'utf-8'));
    const match = Object.entries(groups).find(([k]) => k.toLowerCase().includes(group.toLowerCase()));
    if (!match) return `Group not found. Known: ${Object.keys(groups).join(', ')}`;
    await bot.sendMessage(match[1], message);
    return `Message sent to "${match[0]}"`;
  },

  send_voice_to_group: async ({ group, text, voice = 'onyx' }) => {
    const bot    = getBot();
    const openai = getOpenAI();
    if (!bot || !openai) return 'Bot or OpenAI not available';
    const gFile = path.join(process.cwd(), 'workspace', 'groups.json');
    const groups = JSON.parse(fs.readFileSync(gFile, 'utf-8'));
    const match = Object.entries(groups).find(([k]) => k.toLowerCase().includes(group.toLowerCase()));
    if (!match) return `Group not found. Known: ${Object.keys(groups).join(', ')}`;
    const tmp = path.join(process.cwd(), 'workspace', `orch_tts_${Date.now()}.mp3`);
    const mp3 = await openai.audio.speech.create({ model: 'tts-1', voice, input: text });
    fs.writeFileSync(tmp, Buffer.from(await mp3.arrayBuffer()));
    await bot.sendVoice(match[1], tmp);
    fs.unlinkSync(tmp);
    return `Voice message sent to "${match[0]}"`;
  }
};

// ── Agent definitions ──────────────────────────────────────────────────────────

export const AGENTS = {
  researcher: {
    systemPrompt: `You are a research specialist. Your only job is to find accurate information.
Fetch URLs, gather facts, and save your findings to the shared folder using write_shared.
Be thorough. Organize findings clearly. Do not write creative content — only facts.`,
    toolDefs: [DEF.fetch_url, DEF.write_shared],
    handlers: {
      fetch_url:    HANDLERS.fetch_url,
      write_shared: HANDLERS.write_shared
    }
  },

  writer: {
    systemPrompt: `You are a content writing specialist. Write clear, engaging, polished content.
Always read available research files first using list_shared and read_shared.
Save your finished draft using write_shared. Match the exact format requested.`,
    toolDefs: [DEF.list_shared, DEF.read_shared, DEF.write_shared],
    handlers: {
      list_shared:  HANDLERS.list_shared,
      read_shared:  HANDLERS.read_shared,
      write_shared: HANDLERS.write_shared
    }
  },

  coder: {
    systemPrompt: `You are a code and data specialist. Run JavaScript to calculate, transform, or process data.
Read inputs from shared files if needed. Save results back using write_shared.`,
    toolDefs: [DEF.run_js, DEF.read_shared, DEF.write_shared],
    handlers: {
      run_js:       HANDLERS.run_js,
      read_shared:  HANDLERS.read_shared,
      write_shared: HANDLERS.write_shared
    }
  },

  communicator: {
    systemPrompt: `You are a Telegram communication specialist. Send text or voice messages to Telegram groups.
Use the exact group name provided. For voice messages, default to the "onyx" voice unless specified.
Always confirm after sending.`,
    toolDefs: [DEF.send_to_group, DEF.send_voice_to_group],
    handlers: {
      send_to_group:       HANDLERS.send_to_group,
      send_voice_to_group: HANDLERS.send_voice_to_group
    }
  }
};
