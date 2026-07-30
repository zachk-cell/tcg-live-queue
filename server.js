// Entry point. Wires the queue engine to:
//   - a PASSWORD-PROTECTED real-time control panel (Socket.IO /panel namespace)
//   - a PUBLIC buyer-facing view with no sensitive data (Socket.IO /public)
//   - a REST control API (auth-gated): fulfill / bump / priority / reset
//   - the TikTok Shop webhook ingest (dormant until enabled)
//   - the Discord mirror (dormant until enabled)
//   - the order simulator (when SIMULATE=true)

import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as IOServer } from 'socket.io';
import { authenticator } from 'otplib';

import { QueueEngine } from './queue.js';
import { tiktokEnabled, mountAuth, startPolling, tiktokBoot, tiktokStatus, debugShops, refetchShopCipher } from './tiktok.js';
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

// --- Two-factor (TOTP) config ---
// MFA turns on automatically once TOTP_SECRET is set. To disable / recover from
// a lost authenticator, clear TOTP_SECRET in the host env.
const TOTP_SECRET = process.env.TOTP_SECRET || '';
const MFA_ENABLED = !!TOTP_SECRET;
authenticator.options = { window: 1 }; // tolerate ~30s clock drift each way
const BACKUP_HASHES = (process.env.BACKUP_CODES || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const MFA_STATE_FILE = path.join(process.cwd(), 'data', 'mfa-used.json');

function usedBackupCodes() {
  try { return new Set(JSON.parse(fs.readFileSync(MFA_STATE_FILE, 'utf8'))); }
  catch { return new Set(); }
}
function consumeBackupCode(hash) {
  const used = usedBackupCodes();
  used.add(hash);
  try {
    fs.mkdirSync(path.dirname(MFA_STATE_FILE), { recursive: true });
    fs.writeFileSync(MFA_STATE_FILE, JSON.stringify([...used]));
  } catch (e) { console.warn('[mfa] could not persist used backup code:', e.message); }
}

// Verify the second factor: a 6-digit TOTP, or a one-time backup code.
function verifySecondFactor(input) {
  if (!MFA_ENABLED) return true;
  const raw = String(input || '').trim();
  if (!raw) return false;
  const digits = raw.replace(/[^0-9]/g, '');
  if (/^\d{6}$/.test(digits)) {
    try { return authenticator.verify({ token: digits, secret: TOTP_SECRET }); }
    catch { return false; }
  }
  // Backup code: strip separators, hash, check it exists and isn't used yet.
  const normalized = raw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  if (BACKUP_HASHES.includes(hash) && !usedBackupCodes().has(hash)) {
    consumeBackupCode(hash);
    return true;
  }
  return false;
}

const queue = new QueueEngine();
const app = express();
const server = http.createServer(app);
const io = new IOServer(server);

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
  return res.redirect('/');
}

// ---------- Public (sanitized) view of the queue ----------
// Buyers only see the queue while the seller is live. When not live the public
// page shows "closed" (the admin panel still shows the queue for fulfillment).
function publicView() {
  const snap = queue.snapshot();
  const live = snap.stats.live;
  return {
    live,
    queue: live
      ? snap.queue.map((e) => ({ position: e.position, buyer: e.buyer, isPriority: e.isPriority }))
      : [],
    stats: {
      activeCount: live ? snap.stats.activeCount : 0,
      priorityCount: live ? snap.stats.priorityCount : 0,
    },
  };
}

// ---------- Admin surface (secret path) ----------
// The public queue is the main site (/). The control panel + login live under
// a secret, unlinked path (ADMIN_PATH) so the admin surface is only reachable
// by someone who knows the exact URL. Password + 2FA still protect it.
const ADMIN = '/' + (process.env.ADMIN_PATH || 'admin').replace(/^\/+|\/+$/g, '');

function sendAdminPage(res, file) {
  // Inject the secret admin base path into the page's links/form actions.
  const html = fs.readFileSync(path.join(__dirname, file), 'utf8');
  res.type('html').send(html.split('{{ADMIN}}').join(ADMIN));
}

// ---------- Public pages (primary site, no auth) ----------
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public.html')));
app.get('/public', (_req, res) => res.redirect('/')); // keep old links working
app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));
app.get('/api/public-state', (_req, res) => res.json(publicView()));

// ---------- Admin pages (secret path) ----------
app.get(ADMIN, (req, res) =>
  sendAdminPage(res, isAuthed(req) ? 'index.html' : 'login.html'));
app.post(ADMIN + '/login', (req, res) => {
  const pw = (req.body && req.body.password) || '';
  const okPw = pw.length === PANEL_PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(PANEL_PASSWORD));
  const okMfa = verifySecondFactor(req.body && req.body.code);
  if (!okPw || !okMfa) return res.redirect(ADMIN + '?e=1');
  res.setHeader('Set-Cookie',
    `tcgauth=${makeToken()}; HttpOnly; Secure; Path=/; Max-Age=2592000; SameSite=Lax`);
  res.redirect(ADMIN);
});
app.get(ADMIN + '/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'tcgauth=; HttpOnly; Secure; Path=/; Max-Age=0; SameSite=Lax');
  res.redirect(ADMIN);
});
app.get(ADMIN + '/history', (req, res) =>
  sendAdminPage(res, isAuthed(req) ? 'history.html' : 'login.html'));

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

// Live session control: going live clears the previous queue and starts accepting
// orders; ending keeps the current queue for fulfillment but stops new orders.
app.post('/api/live/on', requireAuth, (_req, res) => { queue.goLive(); res.json({ ok: true, live: true }); });
app.post('/api/live/off', requireAuth, (_req, res) => { queue.endLive(); res.json({ ok: true, live: false }); });

// ---------- Fulfilled export (CSV) + stream history (admin only) ----------
function toCsv(records) {
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const header = ['Order #', 'Buyer', 'Items', 'Total qty', 'Order total', 'Fulfilled at'];
  const lines = [header.map(esc).join(',')];
  for (const r of records) {
    const items = (r.items || []).map((i) => `${i.qty}x ${i.name}`).join('; ');
    const qty = (r.items || []).reduce((n, i) => n + (i.qty || 1), 0);
    const when = r.fulfilledAt ? new Date(r.fulfilledAt).toISOString() : '';
    lines.push([r.orderId, r.buyer, items, qty, Number(r.total || 0).toFixed(2), when].map(esc).join(','));
  }
  return lines.join('\r\n');
}
function sendCsv(res, filename, records) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(toCsv(records));
}
// Past-stream summaries for the history page.
app.get('/api/history', requireAuth, (_req, res) => res.json({ history: queue.snapshot().history }));
// Current stream's fulfilled orders.
app.get('/api/export', requireAuth, (_req, res) =>
  sendCsv(res, 'fulfilled-current.csv', queue.fulfilledRecords()));
// A past stream by id.
app.get('/api/export/:id', requireAuth, (req, res) => {
  const s = queue.history.find((h) => String(h.id) === req.params.id);
  if (!s) return res.status(404).send('stream not found');
  sendCsv(res, `fulfilled-${req.params.id}.csv`, s.fulfilled || []);
});

// ---------- TikTok Shop ingest ----------
mountAuth(app, ADMIN); // /auth/tiktok/callback (Redirect URL target)
app.get('/api/tiktok-status', requireAuth, (_req, res) => res.json(tiktokStatus()));
// Debug: inspect the raw shops-endpoint response (admin only).
app.get('/api/tiktok-debug', requireAuth, async (_req, res) => {
  try { res.json(await debugShops()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Debug: force a fresh shop-cipher fetch with the current access token (admin only).
app.post('/api/tiktok-refetch', requireAuth, async (_req, res) => {
  try { res.json(await refetchShopCipher()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

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
  queue.live = true; // demo starts "live" so the simulated queue populates
  startSimulator(queue, { intervalMs: Number(process.env.SIM_INTERVAL_MS) || 2500 });
}
// Real TikTok order ingest (polls while live). Runs alongside/instead of the sim.
if (tiktokEnabled()) {
  tiktokBoot().catch((e) => console.error('[tiktok] boot error:', e.message));
  startPolling(queue);
}

server.listen(PORT, () => {
  console.log(`\n  PBCC Live Queue running -> http://localhost:${PORT}`);
  console.log(`  Public site: /  |  Admin (secret): ${ADMIN}  |  Privacy: /privacy`);
  console.log(`  Mode: ${process.env.SIMULATE === 'true' ? 'SIMULATOR' : 'LIVE'}` +
    ` | TikTok ingest: ${tiktokEnabled() ? 'ON' : 'off'}` +
    ` | Discord: ${discordEnabled() ? 'ON' : 'off'}\n`);
});
