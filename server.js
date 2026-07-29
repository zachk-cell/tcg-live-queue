// Entry point. Wires the queue engine to:
//   - a real-time web dashboard (Socket.IO)
//   - a REST control API (fulfill / bump / priority config / reset)
//   - the TikTok Shop webhook ingest (dormant until enabled)
//   - the Discord mirror (dormant until enabled)
//   - the order simulator (when SIMULATE=true)

import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as IOServer } from 'socket.io';

import { QueueEngine } from './queue.js';
import { mountWebhook, tiktokEnabled } from './tiktok.js';
import { startDiscord, discordEnabled } from './discord.js';
import { startSimulator } from './simulator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const queue = new QueueEngine();
const app = express();
const server = http.createServer(app);
const io = new IOServer(server);

// TikTok webhook needs the raw body, so mount it BEFORE any json body parser.
mountWebhook(app, queue);

app.use(express.json());

// Serve the dashboard (single file in project root).
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// --- REST control API (used by the dashboard buttons) ---
app.get('/api/state', (_req, res) => res.json(queue.snapshot()));

app.post('/api/fulfill/:key', (req, res) => {
  const r = queue.markFulfilled(req.params.key);
  res.json({ ok: !!r });
});

app.post('/api/reopen/:key', (req, res) => {
  const r = queue.reopen(req.params.key);
  res.json({ ok: !!r });
});

app.post('/api/bump/:key', (req, res) => {
  const r = queue.bump(req.params.key);
  res.json({ ok: !!r });
});

app.post('/api/priority-items', (req, res) => {
  queue.setPriorityItems(req.body.items || []);
  res.json({ ok: true, priorityItems: queue.priorityItems });
});

app.post('/api/reset', (_req, res) => {
  queue.reset();
  res.json({ ok: true });
});

// --- Real-time push to all connected dashboards ---
function broadcast() {
  io.emit('state', queue.snapshot());
}
queue.on('change', broadcast);

io.on('connection', (socket) => {
  socket.emit('state', queue.snapshot());
});

// --- Start integrations ---
if (discordEnabled()) {
  startDiscord(queue).catch((e) => console.error('[discord] failed to start:', e.message));
}

if (process.env.SIMULATE === 'true') {
  // Seed sensible priority triggers so the demo shows priority working out of
  // the box. (In real use, set your own via the dashboard's "Priority items".)
  if (!queue.priorityItems.length) queue.setPriorityItems(['break', 'slab']);
  startSimulator(queue, { intervalMs: Number(process.env.SIM_INTERVAL_MS) || 2500 });
}

server.listen(PORT, () => {
  console.log(`\n  TCG Live Queue running -> http://localhost:${PORT}`);
  console.log(`  Mode: ${process.env.SIMULATE === 'true' ? 'SIMULATOR' : 'LIVE'}` +
    ` | TikTok ingest: ${tiktokEnabled() ? 'ON' : 'off'}` +
    ` | Discord: ${discordEnabled() ? 'ON' : 'off'}\n`);
});
