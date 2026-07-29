# TCG Live Queue

An automated running-order queue for selling trading cards on TikTok Shop lives.
Orders are pulled in automatically (no typing), grouped and prioritized by your
rules, and shown as a self-updating live feed on a **web dashboard** and mirrored
into **Discord**. Built to handle a busy 6-hour live (hundreds of orders).

## What it does

- **Auto-ingest** — a TikTok Shop webhook fires on each new/paid order; the app
  fetches the order detail and drops it into the queue. Nothing is typed by hand.
- **Item-driven priority** — if an order contains one of your configured
  *priority items* (e.g. "break", "slab", "PSA 10"), that buyer jumps to the top.
  Multiple priority buyers all sit at the top, ordered by who bought first.
- **Buyer slot-merging** — if a buyer orders again *before* their slot is
  fulfilled, the new order is merged into their existing slot (items + total
  combined). They are **not** added to the queue a second time. After a slot is
  fulfilled, a later order from that buyer opens a fresh slot.
- **One-tap fulfill** — mark a slot done from the dashboard or Discord; it drops
  off the active queue into "recently fulfilled".
- **Manual bump** — force any buyer to the very top when you need to.
- **Crash-safe** — the queue is saved to disk, so a restart mid-live restores it.

## Try it right now (simulator — no accounts needed)

```bash
npm install
npm run demo
```

Open **http://localhost:3000**. Fake orders start flowing every ~2.5s. The
simulator intentionally creates repeat buyers (watch slots merge) and priority
items (watch them jump to the top). Default priority triggers are `break` and
`slab` — click **⭐ Priority items** to change them.

## How the queue orders slots

Top of the queue = next to handle:

1. A manually **bumped** slot.
2. **Priority** slots (contain a priority item) before normal slots.
3. Within priority: earliest priority-item purchase first.
   Within normal: earliest order first.

## Going live with real TikTok Shop orders

1. **Register a developer app** in the [TikTok Shop Partner Center](https://partner.tiktokshop.com/).
   Create your app, request the **Order** scope, and authorize it against your
   shop. Approval typically takes ~2–3 business days. (The region you pick in
   Partner Center is permanent, so choose your shop's region.)
2. **Host this app** somewhere with a public HTTPS URL (Railway, Render, Fly.io,
   a small VPS — anything that stays online during your lives). You need a public
   URL because TikTok has to reach your webhook.
3. In Partner Center, set the **webhook URL** to `https://YOUR-DOMAIN/webhook/tiktok`
   and subscribe to the **Order status change** event.
4. Copy `.env.example` to `.env` and fill in:
   - `TIKTOK_ENABLED=true`
   - `TIKTOK_APP_KEY`, `TIKTOK_APP_SECRET` (from your app)
   - `TIKTOK_SHOP_CIPHER`, `TIKTOK_ACCESS_TOKEN` (from authorizing your shop)
   - set `SIMULATE=false`
5. Restart. Real orders now flow into the queue automatically.

> The TikTok field names can vary slightly by API version. If a live order shows
> the wrong buyer/total, adjust the mapping in `lib/tiktok.js` → `normalizeOrder()`.
> Everything else stays the same.

## Adding the Discord mirror (optional)

1. Create a bot at the [Discord Developer Portal](https://discord.com/developers/applications),
   copy its **token**, and invite it to your server with permission to read/send
   messages in one channel.
2. In `.env` set `DISCORD_ENABLED=true`, `DISCORD_BOT_TOKEN=...`,
   `DISCORD_CHANNEL_ID=...` (right-click the channel → Copy ID; enable Developer
   Mode in Discord settings first).
3. Restart. The bot posts and pins a live-updating queue message and adds
   `/queue`, `/fulfill`, and `/bump` commands for your mods.

## Project layout

```
server.js          wiring: web + API + webhook + discord + simulator
lib/queue.js       the queue engine (grouping, priority, fulfill, persistence)
lib/tiktok.js      TikTok Shop webhook receiver + Order Detail API
lib/discord.js     Discord live-mirror bot
lib/simulator.js   fake order feed for the demo
public/index.html  the real-time web dashboard
data/              auto-saved queue state (created on first run)
```

## Notes on scale

At ~400 orders / 6 hours you're near one order per minute — far under TikTok's
API limits (~50 req/s, ~1,000/day per endpoint) and trivial for the dashboard.
The Discord mirror batches its edits every few seconds to stay clear of Discord's
rate limits during busy stretches.
