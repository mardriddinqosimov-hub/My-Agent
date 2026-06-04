import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { emitter, getRecent, log } from './events.js';
import { runOrchestrator } from './agents/orchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || process.env.DASHBOARD_PORT || 4000;

const app = express();
app.use(express.json());

// Serve dashboard
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'dashboard', 'index.html')));

// ── REST API ───────────────────────────────────────────────────────────────────

app.get('/api/status', (_req, res) => {
  let groups = 0;
  try { groups = Object.keys(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'workspace', 'groups.json'), 'utf-8'))).length; } catch {}
  res.json({ bot: global.botStarted ? 'online' : 'starting', groups, uptime: process.uptime() });
});

app.get('/api/groups', (_req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'workspace', 'groups.json'), 'utf-8'))); }
  catch { res.json({}); }
});

app.get('/api/content', (_req, res) => {
  const contentDir = path.join(process.cwd(), 'workspace', 'content');
  if (!fs.existsSync(contentDir)) return res.json([]);
  const items = [];
  for (const date of fs.readdirSync(contentDir)) {
    const dateDir = path.join(contentDir, date);
    if (!fs.statSync(dateDir).isDirectory()) continue;
    for (const topic of fs.readdirSync(dateDir)) {
      const dir = path.join(dateDir, topic);
      if (!fs.statSync(dir).isDirectory()) continue;
      const hasVideo  = fs.existsSync(path.join(dir, 'reel.mp4'));
      const hasScript = fs.existsSync(path.join(dir, 'script.txt'));
      items.push({
        date,
        topic: topic.replace(/_/g, ' '),
        hasVideo,
        hasScript,
        script: hasScript ? fs.readFileSync(path.join(dir, 'script.txt'), 'utf-8').slice(0, 180) : null
      });
    }
  }
  res.json(items.reverse());
});

app.get('/api/logs', (_req, res) => res.json(getRecent()));

app.post('/api/orchestrate', async (req, res) => {
  const { task } = req.body;
  if (!task?.trim()) return res.status(400).json({ error: 'task required' });
  res.json({ status: 'started' });
  runOrchestrator(task, (update) => log('agent', update))
    .then(result => log('orchestrator', `✅ Done: ${result}`))
    .catch(err  => log('error', `Orchestrator failed: ${err.message}`));
});

// ── WebSocket ──────────────────────────────────────────────────────────────────

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  // Send history to new client
  for (const e of getRecent()) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
  }
  const relay = (e) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e)); };
  emitter.on('event', relay);
  ws.on('close', () => emitter.off('event', relay));
});

server.listen(PORT, () => {
  log('system', `Dashboard running — http://localhost:${PORT}`);
  console.log(`[Dashboard] http://localhost:${PORT}`);
});
