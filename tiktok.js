// TikTok Shop integration.
//
// - OAuth token management: exchange auth_code -> access/refresh tokens,
//   auto-refresh before/when they expire, persist to disk within a session.
// - Order ingest by POLLING: while the seller is live, poll for recently
//   created orders every few seconds and push them into the queue. Polling is
//   simpler and more reliable on ephemeral/free hosting than inbound webhooks,
//   and it naturally respects the "only while live" rule.
//
// Endpoints (TikTok Shop Open API):
//   Auth:   https://auth.tiktok-shops.com/api/v2/token/get   (grant_type=authorized_code)
//           https://auth.tiktok-shops.com/api/v2/token/refresh (grant_type=refresh_token)
//   API:    https://open-api.tiktokglobalshop.com  (signed requests)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'tiktok-tokens.json');

const AUTH_BASE = process.env.TIKTOK_AUTH_BASE || 'https://auth.tiktok-shops.com';
const API_BASE = process.env.TIKTOK_API_BASE || 'https://open-api.tiktokglobalshop.com';
const API_VERSION = process.env.TIKTOK_API_VERSION || '202309';
const APP_KEY = process.env.TIKTOK_APP_KEY || '';
const APP_SECRET = process.env.TIKTOK_APP_SECRET || '';

// Token state — seeded from env, overlaid by persisted file, updated at runtime.
let tokens = {
  accessToken: process.env.TIKTOK_ACCESS_TOKEN || '',
  refreshToken: process.env.TIKTOK_REFRESH_TOKEN || '',
  shopCipher: process.env.TIKTOK_SHOP_CIPHER || '',
  shopId: process.env.TIKTOK_SHOP_ID || '',
  sellerName: '',
  accessExpireAt: 0,
  lastError: '',
};

export function tiktokEnabled() {
  return process.env.TIKTOK_ENABLED === 'true' && !!APP_KEY && !!APP_SECRET;
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens));
  } catch (e) { console.warn('[tiktok] token persist failed:', e.message); }
}
(function loadPersisted() {
  try {
    if (fs.existsSync(TOKEN_FILE)) tokens = { ...tokens, ...JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) };
  } catch { /* ignore */ }
})();

// ---------------- Token endpoints ----------------
function applyTokenData(d) {
  if (!d) return;
  if (d.access_token) tokens.accessToken = d.access_token;
  if (d.refresh_token) tokens.refreshToken = d.refresh_token;
  // TikTok returns access_token_expire_in as an ABSOLUTE unix epoch (seconds),
  // not a duration. Guard for both: a value > 1e9 is an absolute epoch, a small
  // value is a duration in seconds.
  if (d.access_token_expire_in) {
    const v = Number(d.access_token_expire_in);
    const absMs = v > 1e9 ? v * 1000 : Date.now() + v * 1000;
    tokens.accessExpireAt = absMs - 60000; // refresh a minute early
  }
  if (d.seller_name) tokens.sellerName = d.seller_name;
  tokens.lastError = '';
  persist();
}

async function tokenGet(authCode) {
  const url = `${AUTH_BASE}/api/v2/token/get?app_key=${APP_KEY}&app_secret=${APP_SECRET}` +
    `&auth_code=${encodeURIComponent(authCode)}&grant_type=authorized_code`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (body.code !== 0) throw new Error('token/get: ' + (body.message || JSON.stringify(body)));
  applyTokenData(body.data);
  return body.data;
}

async function tokenRefresh() {
  if (!tokens.refreshToken) throw new Error('no refresh token');
  const url = `${AUTH_BASE}/api/v2/token/refresh?app_key=${APP_KEY}&app_secret=${APP_SECRET}` +
    `&refresh_token=${encodeURIComponent(tokens.refreshToken)}&grant_type=refresh_token`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (body.code !== 0) throw new Error('token/refresh: ' + (body.message || JSON.stringify(body)));
  applyTokenData(body.data);
  console.log('[tiktok] access token refreshed');
  return body.data;
}

// ---------------- Signed API calls ----------------
function sign(pathName, params, body = '') {
  const keys = Object.keys(params).filter((k) => k !== 'sign' && k !== 'access_token').sort();
  let base = pathName;
  for (const k of keys) base += k + params[k];
  base += body || '';
  base = APP_SECRET + base + APP_SECRET;
  return crypto.createHmac('sha256', APP_SECRET).update(base).digest('hex');
}

async function apiCall(method, pathName, extraParams = {}, jsonBody = null, retry = true, includeShopCipher = true) {
  const params = {
    app_key: APP_KEY,
    timestamp: String(Math.floor(Date.now() / 1000)),
    // The authorization/shops endpoint rejects shop_cipher; other endpoints need it.
    ...((includeShopCipher && tokens.shopCipher) ? { shop_cipher: tokens.shopCipher } : {}),
    ...extraParams,
  };
  const bodyStr = jsonBody ? JSON.stringify(jsonBody) : '';
  params.sign = sign(pathName, params, bodyStr);
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}${pathName}?${qs}`, {
    method,
    headers: { 'x-tts-access-token': tokens.accessToken, 'content-type': 'application/json' },
    ...(jsonBody ? { body: bodyStr } : {}),
  });
  const body = await res.json().catch(() => ({}));
  // Refresh + retry once on any token-related error.
  if (retry && tokens.refreshToken && body && body.code && /token|auth|expire/i.test(JSON.stringify(body))) {
    try { await tokenRefresh(); } catch (e) { tokens.lastError = e.message; persist(); return body; }
    return apiCall(method, pathName, extraParams, jsonBody, false, includeShopCipher);
  }
  return body;
}

async function getShopCipher() {
  const pathName = `/authorization/${API_VERSION}/shops`;
  const body = await apiCall('GET', pathName, {}, null, true, false);
  const shop = body?.data?.shops?.[0];
  if (shop && shop.cipher) {
    tokens.shopCipher = shop.cipher;
    tokens.shopId = shop.id;
    if (shop.name) tokens.sellerName = tokens.sellerName || shop.name;
    tokens.lastError = '';
    persist();
    console.log('[tiktok] shop cipher acquired for', tokens.sellerName || tokens.shopId);
  } else {
    // Record why so the panel / debug route can surface it.
    tokens.lastError = 'get-shops: ' + JSON.stringify(body).slice(0, 300);
    persist();
    console.warn('[tiktok] get-shops returned no usable cipher:', JSON.stringify(body).slice(0, 500));
  }
  return shop;
}

// Debug helper: return the raw shops-endpoint response (used by an admin route).
export async function debugShops() {
  const pathName = `/authorization/${API_VERSION}/shops`;
  const raw = await apiCall('GET', pathName, {}, null, true, false);
  return {
    tokenState: {
      hasAccess: !!tokens.accessToken,
      hasRefresh: !!tokens.refreshToken,
      hasCipher: !!tokens.shopCipher,
      accessExpireAt: tokens.accessExpireAt,
      sellerName: tokens.sellerName,
      shopId: tokens.shopId,
    },
    apiBase: API_BASE,
    apiVersion: API_VERSION,
    shopsResponse: raw,
  };
}

// Debug helper: force a fresh getShopCipher using current access token.
export async function refetchShopCipher() {
  await getShopCipher();
  return tiktokStatus();
}

// ---------------- Orders ----------------
export function normalizeOrder(o) {
  const lineItems = o.line_items || o.item_list || [];
  const items = lineItems.map((li) => ({
    name: li.product_name || li.sku_name || 'Item',
    sku: li.seller_sku || li.sku_id || '',
    qty: li.quantity || 1,
  }));
  return {
    id: o.id || o.order_id,
    buyerId: o.buyer_uid || o.user_id || o.buyer_email || o.id,
    buyer: o.buyer_username || o.recipient_address?.name || o.buyer_uid || 'Buyer',
    items,
    total: Number(o.payment?.total_amount || o.total_amount || 0),
    createdAt: o.create_time ? o.create_time * 1000 : Date.now(),
  };
}

async function fetchOrderDetail(orderId) {
  const body = await apiCall('GET', `/order/${API_VERSION}/orders`, { ids: orderId });
  const order = body?.data?.orders?.[0];
  if (!order) { console.warn('[tiktok] order detail empty for', orderId, JSON.stringify(body).slice(0, 200)); return null; }
  return normalizeOrder(order);
}

// Search for order IDs created since `sinceEpoch` (actionable statuses only).
async function searchRecentOrderIds(sinceEpoch) {
  const pathName = `/order/${API_VERSION}/orders/search`;
  const ids = [];
  let pageToken = '';
  for (let page = 0; page < 5; page++) {
    const extra = { page_size: 50, ...(pageToken ? { page_token: pageToken } : {}) };
    const bodyReq = { create_time_ge: sinceEpoch, order_status: 'AWAITING_SHIPMENT' };
    const body = await apiCall('POST', pathName, extra, bodyReq);
    const orders = body?.data?.orders || [];
    for (const o of orders) ids.push(o.id || o.order_id);
    pageToken = body?.data?.next_page_token || '';
    if (!pageToken) break;
  }
  return ids;
}

// ---------------- Poller ----------------
export function startPolling(queue) {
  const interval = Number(process.env.TIKTOK_POLL_MS) || 10000;
  let sinceEpoch = Math.floor(Date.now() / 1000);
  const seen = new Set();

  // Each new live starts a fresh window: only orders placed after Go Live count.
  queue.on('change', (e) => {
    if (e && e.reason === 'go-live') { sinceEpoch = Math.floor(Date.now() / 1000); seen.clear(); }
  });

  async function poll() {
    if (!tiktokEnabled() || !queue.live || !tokens.accessToken || !tokens.shopCipher) return;
    try {
      const ids = await searchRecentOrderIds(sinceEpoch - 30); // small overlap for safety
      for (const id of ids) {
        if (!id || seen.has(id)) continue;
        const detail = await fetchOrderDetail(id);
        if (detail) { seen.add(id); queue.upsertOrder(detail); }
      }
    } catch (e) { console.error('[tiktok] poll error:', e.message); }
  }
  const timer = setInterval(poll, interval);
  timer.unref?.();
  console.log(`[tiktok] polling every ${interval}ms while live`);
}

// ---------------- Auth routes ----------------
export function mountAuth(app, adminPath) {
  // TikTok redirects here (Redirect URL) with an auth code after the seller approves.
  app.get('/auth/tiktok/callback', async (req, res) => {
    const code = req.query.code || req.query.auth_code;
    if (!code) return res.status(400).send('Missing authorization code.');
    try {
      await tokenGet(code);
      await getShopCipher();
      res.redirect((adminPath || '/') + '?tiktok=connected');
    } catch (e) {
      console.error('[tiktok] auth callback error:', e.message);
      res.status(500).send('TikTok authorization failed: ' + e.message + ' — you can close this and try again.');
    }
  });
}

export function tiktokStatus() {
  return {
    enabled: tiktokEnabled(),
    connected: !!(tokens.accessToken && tokens.shopCipher),
    shop: tokens.sellerName || tokens.shopId || '',
    lastError: tokens.lastError || '',
    authUrl: process.env.TIKTOK_AUTH_URL || '',
  };
}

// On boot: if enabled and we have a refresh token but no/expired access token, refresh.
export async function tiktokBoot() {
  if (!tiktokEnabled()) { console.log('[tiktok] ingest disabled'); return; }
  try {
    if (tokens.refreshToken && (!tokens.accessToken || Date.now() > tokens.accessExpireAt)) {
      await tokenRefresh();
    }
    if (tokens.accessToken && !tokens.shopCipher) await getShopCipher();
  } catch (e) {
    tokens.lastError = e.message; persist();
    console.warn('[tiktok] boot token setup failed:', e.message);
  }
  console.log('[tiktok] status:', JSON.stringify(tiktokStatus()));
}
