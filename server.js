// Entry point. Wires the queue engine to:
//   - a PASSWORD-PROTECTED real-time control panel (Socket.IO /panel namespace)
//   - a PUBLIC buyer-facing view with no sensitive data (Socket.IO /public)
//   - a REST control API (auth-gated): fulfill / bump / priority / reset
//   - the TikTok Shop webhook ingest (dormant until enabled)
//   - the Discord mirror (dormant until enabled)
//   - the order simulator (when SIMULATE=true)

import 'dotenv/config';
import crypto from 'node:crypto';
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

// --- Auth config ---
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(24).toString('hex');
if (PANEL_PASSWORD === 'changeme') {
  console.warn('[auth] PANEL_PASSWORD not set — using insecure default "changeme". Set it in your host env!');
}

const queue = new QueueEngine();
const app = express();
const server = http.createServer(app);
const io = new IOServer(server);

// TikTok webhook needs the raw body, so mount it BEFORE any body parser.
mountWebhook(app, queue);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---------- Auth helpers (signed cookie, no extra deps) ----------
function makeToken() {
  const payload = String(Date.now());
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function validToken(token) {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  } catch { return false; }
  // 30-day expiry
  return Date.now() - Number(payload) < 30 * 24 * 3600 * 1000;
}
function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0])
  );
}
function isAuthed(req) {
  return validToken(parseCookies(req.headers.cookie).tcgauth);
}
function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/login');
}

// ---------- Public (sanitized) view of the queue ----------
function publicView() {
  const snap = queue.snapshot();
  return {
    queue: snap.queue.map((e) => ({
      position: e.position,
      buyer: e.buyer,
      isPriority: e.isPriority,
    })),
    stats: { activeCount: snap.stats.activeCount, priorityCount: snap.stats.priorityCount },
  };
}

// ---------- Pages ----------
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.post('/login', (req, res) => {
  const pw = (req.body && req.body.password) || '';
  const ok = pw.length === PANEL_PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(PANEL_PASSWORD));
  if (!ok) return res.redirect('/login?e=1');
  res.setHeader('Set-Cookie',
    `tcgauth=${makeToken()}; HttpOnly; Secure; Path=/; Max-Age=2592000; SameSite=Lax`);
  res.redirect('/');
});
app.get('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'tcgauth=; HttpOnly; Secure; Path=/; Max-Age=0; SameSite=Lax');
  res.redirect('/login');
});

// Public buyer-facing view + privacy policy (no auth).
app.get('/public', (_req, res) => res.sendFile(path.join(__dirname, 'public.html')));
app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));
app.get('/api/public-state', (_req, res) => res.json(publicView()));

// Control panel (auth required).
app.get('/', requireAuth, (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ---------- Control API (auth required) ----------
app.get('/api/state', requireAuth, (_req, res) => res.json(queue.snapshot()));
app.post('/api/fulfill/:key', requireAuth, (req, res) => res.json({ ok: !!queue.markFulfilled(req.params.key) }));
app.post('/api/reopen/:key', requireAuth, (req, res) => res.json({ ok: !!queue.reopen(req.params.key) }));
app.post('/api/bump/:key', requireAuth, (req, res) => res.json({ ok: !!queue.bump(req.params.key) }));
app.post('/api/priority-items', requireAuth, (req, res) => {
  queue.setPriorityItems(req.body.items || []);
  res.json({ ok: true, priorityItems: queue.priorityItems });
});
app.post('/api/reset', requireAuth, (_req, res) => { queue.reset(); res.json({ ok: true }); });

// ---------- Real-time: two namespaces ----------
const panelNs = io.of('/panel');
panelNs.use((socket, next) => {
  const token = parseCookies(socket.handshake.headers.cookie).tcgauth;
  return validToken(token) ? next() : next(new Error('unauthorized'));
});
panelNs.on('connection', (socket) => socket.emit('state', queue.snapshot()));

const publicNs = io.of('/public');
publicNs.on('connection', (socket) => socket.emit('state', publicView()));

queue.on('change', () => {
  panelNs.emit('state', queue.snapshot());
  publicNs.emit('state', publicView());
});

// ---------- Integrations ----------
if (discordEnabled()) {
  startDiscord(queue).catch((e) => console.error('[discord] failed to start:', e.message));
}
if (process.env.SIMULATE === 'true') {
  if (!queue.priorityItems.length) queue.setPriorityItems(['break', 'slab']);
  startSimulator(queue, { intervalMs: Number(process.env.SIM_INTERVAL_MS) || 2500 });
}

server.listen(PORT, () => {
  console.log(`\n  TCG Live Queue running -> http://localhost:${PORT}`);
  console.log(`  Panel: /  (password protected)  |  Public view: /public  |  Privacy: /privacy`);
  console.log(`  Mode: ${process.env.SIMULATE === 'true' ? 'SIMULATOR' : 'LIVE'}` +
    ` | TikTok ingest: ${tiktokEnabled() ? 'ON' : 'off'}` +
    ` | Discord: ${discordEnabled() ? 'ON' : 'off'}\n`);
});
