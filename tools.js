import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import fetch from 'node-fetch';

const WORKSPACE = path.join(process.cwd(), 'workspace');
if (!fs.existsSync(WORKSPACE)) fs.mkdirSync(WORKSPACE, { recursive: true });

// ── Tool definitions (sent to OpenAI) ─────────────────────────────────────────

export const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Use relative paths inside the workspace/ folder or absolute paths.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file. Files are saved inside workspace/ by default.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to workspace/ or absolute)' },
          content: { type: 'string', description: 'Content to write' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in a directory.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Directory path (default: workspace/)' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_js',
      description: 'Execute a JavaScript snippet and return stdout. Useful for calculations, data transforms, quick scripts.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript code to execute with node -e' }
        },
        required: ['code']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch the text content of a URL (webpage or API).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
          max_chars: { type: 'number', description: 'Max characters to return (default 4000)' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_note',
      description: 'Save a note with a title to persistent storage (workspace/notes/).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Note title (used as filename)' },
          content: { type: 'string', description: 'Note content' }
        },
        required: ['title', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_content',
      description: 'Run the Content Factory: generates reels script, carousel, post caption, voiceover, subtitles, and 9:16 video for a given topic.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'The topic or idea to create content about' }
        },
        required: ['topic']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_voice_to_group',
      description: 'Generate a voice message using TTS and send it to a Telegram group.',
      parameters: {
        type: 'object',
        properties: {
          group:  { type: 'string', description: 'Group name to send to' },
          text:   { type: 'string', description: 'Text to speak' },
          voice:  { type: 'string', description: 'Voice: alloy, echo, fable, onyx, nova, shimmer (default: alloy)', enum: ['alloy','echo','fable','onyx','nova','shimmer'] }
        },
        required: ['group', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_to_group',
      description: 'Send a message to one of the Telegram groups the bot is a member of.',
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string', description: 'Group name (or part of it) to send to' },
          message: { type: 'string', description: 'Message text to send' }
        },
        required: ['group', 'message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_groups',
      description: 'List all Telegram groups the bot is currently a member of.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description: 'Search through saved notes for a keyword.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term' }
        },
        required: ['query']
      }
    }
  }
];

// ── Tool handlers ──────────────────────────────────────────────────────────────

function resolvePath(p) {
  if (path.isAbsolute(p)) return p;
  return path.join(WORKSPACE, p);
}

export async function runTool(name, args) {
  try {
    switch (name) {
      case 'read_file': {
        const fp = resolvePath(args.path);
        if (!fs.existsSync(fp)) return `Error: file not found: ${fp}`;
        return fs.readFileSync(fp, 'utf-8');
      }

      case 'write_file': {
        const fp = resolvePath(args.path);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, args.content, 'utf-8');
        return `Written ${args.content.length} chars to ${fp}`;
      }

      case 'list_files': {
        const dir = args.dir ? resolvePath(args.dir) : WORKSPACE;
        if (!fs.existsSync(dir)) return `Directory not found: ${dir}`;
        const items = fs.readdirSync(dir, { withFileTypes: true });
        return items.map(i => `${i.isDirectory() ? '[dir]' : '[file]'} ${i.name}`).join('\n') || '(empty)';
      }

      case 'run_js': {
        try {
          const result = execSync(`node -e "${args.code.replace(/"/g, '\\"')}"`, {
            timeout: 10000,
            encoding: 'utf-8',
            windowsHide: true
          });
          return result || '(no output)';
        } catch (e) {
          return `Error: ${e.stderr || e.message}`;
        }
      }

      case 'fetch_url': {
        const maxChars = args.max_chars || 4000;
        const res = await fetch(args.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const text = await res.text();
        const clean = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return clean.slice(0, maxChars) + (clean.length > maxChars ? '\n...[truncated]' : '');
      }

      case 'save_note': {
        const notesDir = path.join(WORKSPACE, 'notes');
        fs.mkdirSync(notesDir, { recursive: true });
        const filename = args.title.replace(/[^a-z0-9_-]/gi, '_') + '.md';
        const fp = path.join(notesDir, filename);
        const content = `# ${args.title}\n\n${args.content}\n\n_Saved: ${new Date().toISOString()}_`;
        fs.writeFileSync(fp, content, 'utf-8');
        return `Note saved: ${fp}`;
      }

      case 'search_notes': {
        const notesDir = path.join(WORKSPACE, 'notes');
        if (!fs.existsSync(notesDir)) return 'No notes found.';
        const files = fs.readdirSync(notesDir).filter(f => f.endsWith('.md'));
        const matches = [];
        for (const f of files) {
          const text = fs.readFileSync(path.join(notesDir, f), 'utf-8');
          if (text.toLowerCase().includes(args.query.toLowerCase())) {
            matches.push(`--- ${f} ---\n${text.slice(0, 300)}`);
          }
        }
        return matches.length ? matches.join('\n\n') : 'No matching notes.';
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool error: ${err.message}`;
  }
}
