// TikTok Shop ingest.
//
// Two parts:
//   1. mountWebhook(app, queue) — an HTTP endpoint TikTok Shop calls when an
//      order changes. We verify the signature, then fetch full order detail
//      and push it into the queue.
//   2. fetchOrderDetail(orderId) — calls the TikTok Shop Order Detail API.
//
// This is written against TikTok Shop's documented Open API (Partner Center).
// It stays DORMANT until you set the TikTok env vars (see .env.example) and
// TIKTOK_ENABLED=true. Until then the app runs on the simulator so you can
// see everything working before your Partner Center app is approved.
//
// Docs:
//   Auth:        https://partner.tiktokshop.com/docv2/page/authorization-overview-202407
//   Webhooks:    https://partner.tiktokshop.com/docv2/page/tts-webhooks-overview
//   Order status change event & Get Order Detail API — Partner Center Order docs.

import crypto from 'node:crypto';

const {
  TIKTOK_APP_KEY,
  TIKTOK_APP_SECRET,
  TIKTOK_SHOP_CIPHER,
  TIKTOK_ACCESS_TOKEN,
  TIKTOK_API_BASE = 'https://open-api.tiktokglobalshop.com',
  TIKTOK_API_VERSION = '202309',
} = process.env;

export const tiktokEnabled = () => process.env.TIKTOK_ENABLED === 'true';

/**
 * Verify the webhook came from TikTok. TikTok signs the request; the signature
 * is HMAC-SHA256 of (app_key + rawBody) keyed by app_secret. We compare against
 * the Authorization / x-tts-signature header. If secrets aren't set we skip
 * (dev only) and log loudly.
 */
function verifySignature(req, rawBody) {
  const provided =
    req.headers['authorization'] || req.headers['x-tts-signature'] || '';
  if (!TIKTOK_APP_SECRET || !TIKTOK_APP_KEY) {
    console.warn('[tiktok] signature check skipped — secrets not set');
    return true;
  }
  const base = TIKTOK_APP_KEY + rawBody;
  const digest = crypto
    .createHmac('sha256', TIKTOK_APP_SECRET)
    .update(base)
    .digest('hex');
  // Constant-time compare when lengths match.
  try {
    return (
      provided.length === digest.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(digest))
    );
  } catch {
    return false;
  }
}

/** Sign an outbound API request per TikTok Shop's rule (sorted params + path). */
function signRequest(pathName, params) {
  const sorted = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'access_token')
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join('');
  const base = `${pathName}${sorted}`;
  const withSecret = TIKTOK_APP_SECRET + base + TIKTOK_APP_SECRET;
  return crypto
    .createHmac('sha256', TIKTOK_APP_SECRET)
    .update(withSecret)
    .digest('hex');
}

/** Call Get Order Detail and normalise into our queue's order shape. */
export async function fetchOrderDetail(orderId) {
  if (!tiktokEnabled()) return null;
  const pathName = `/order/${TIKTOK_API_VERSION}/orders`;
  const params = {
    app_key: TIKTOK_APP_KEY,
    shop_cipher: TIKTOK_SHOP_CIPHER,
    timestamp: Math.floor(Date.now() / 1000),
    ids: orderId,
  };
  params.sign = signRequest(pathName, params);
  const qs = new URLSearchParams(params).toString();
  const url = `${TIKTOK_API_BASE}${pathName}?${qs}`;

  const res = await fetch(url, {
    headers: {
      'x-tts-access-token': TIKTOK_ACCESS_TOKEN,
      'content-type': 'application/json',
    },
  });
  if (!res.ok) {
    console.error('[tiktok] order detail HTTP', res.status, await res.text());
    return null;
  }
  const body = await res.json();
  const order = body?.data?.orders?.[0];
  if (!order) {
    console.error('[tiktok] no order in response', JSON.stringify(body).slice(0, 300));
    return null;
  }
  return normalizeOrder(order);
}

/** Map TikTok's order object onto our internal shape. */
export function normalizeOrder(o) {
  const lineItems = o.line_items || o.item_list || [];
  const items = lineItems.map((li) => ({
    name: li.product_name || li.sku_name || 'Item',
    qty: li.quantity || 1,
  }));
  return {
    id: o.id || o.order_id,
    buyerId: o.buyer_uid || o.user_id || o.buyer_email || o.id,
    buyer: o.buyer_username || o.recipient_address?.name || o.buyer_uid || 'Buyer',
    items,
    total: Number(o.payment?.total_amount || o.total_amount || 0),
    createdAt: (o.create_time ? o.create_time * 1000 : Date.now()),
  };
}

/**
 * Mount the webhook receiver. TikTok POSTs a small event telling us WHICH order
 * changed and its new status; we only enqueue orders that are paid/awaiting
 * shipment (i.e. real, actionable orders for the live), then fetch full detail.
 */
export function mountWebhook(app, queue) {
  // We need the raw body for signature verification.
  app.post(
    '/webhook/tiktok',
    (req, res, next) => {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        req.rawBody = data;
        try {
          req.body = data ? JSON.parse(data) : {};
        } catch {
          req.body = {};
        }
        next();
      });
    },
    async (req, res) => {
      if (!verifySignature(req, req.rawBody || '')) {
        console.warn('[tiktok] bad webhook signature — rejected');
        return res.status(401).send('bad signature');
      }
      // Ack fast; TikTok retries on non-2xx, so never block the response.
      res.status(200).send('ok');

      try {
        const evt = req.body || {};
        // Event shape (order status change): { type, shop_id, data: { order_id, order_status } }
        const type = evt.type || evt.event_type;
        const orderId = evt.data?.order_id || evt.data?.orderId;
        const status = evt.data?.order_status || evt.data?.status;
        if (!orderId) return;

        // Only queue actionable orders. Adjust this set to taste.
        const ACTIONABLE = new Set([
          'AWAITING_SHIPMENT',
          'AWAITING_COLLECTION',
          'PAID',
          100, 111, 112,
        ]);
        const detail = await fetchOrderDetail(orderId);
        if (!detail) return;

        if (status && !ACTIONABLE.has(status)) {
          // Terminal / non-actionable states auto-clear from active queue.
          if (['COMPLETED', 'DELIVERED', 'CANCELLED', 130, 140].includes(status)) {
            queue.markFulfilled(orderId);
            return;
          }
        }
        queue.upsertOrder(detail);
      } catch (e) {
        console.error('[tiktok] webhook handling error:', e.message);
      }
    }
  );

  console.log('[tiktok] webhook mounted at POST /webhook/tiktok');
}
