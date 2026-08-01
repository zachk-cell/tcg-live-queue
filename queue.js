// Core queue engine.
//
// Behaviour (per seller's rules):
//  - Orders are grouped into one SLOT per buyer while that buyer still has an
//    unfulfilled slot. A buyer who orders again before being fulfilled is
//    merged into their existing slot (items + total combined), NOT re-queued.
//    Once a slot is fulfilled, a later order from that buyer opens a fresh slot.
//  - PRIORITY is item-driven: if a slot contains any configured "priority item",
//    the whole slot jumps to the top. Multiple priority slots from different
//    buyers all sit at the top, ordered by who ordered (the priority item) first.
//  - A slot can also be manually bumped to the very top.
//  - "Mark fulfilled" closes a slot (the whole buyer batch).
//  - State persists to disk so a crash/restart mid-live never loses the queue.

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'queue-state.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const MAX_HISTORY = 5; // keep the last N streams for the admin history view

/**
 * Order record:
 * {
 *   id, buyerId, buyer,
 *   items: [{ name, qty }], total, createdAt,
 *   status: 'queued'|'fulfilled',
 *   batchKey,            // slot this order belongs to
 *   hasPriority          // does this order contain a priority item
 * }
 */

export class QueueEngine extends EventEmitter {
  constructor() {
    super();
    this.orders = new Map(); // orderId -> order
    this.openBatch = new Map(); // buyerId -> current open batchKey (or absent)
    this.batchCounter = 0;
    this.priorityItems = []; // array of lowercased substrings that trigger priority
    this.live = false; // when false, incoming orders are ignored (not queued)
    this.sessionStartedAt = null; // when the current live started
    this.history = []; // archived past streams (most recent first)
    this._ensureDataDir();
    this._load();
  }

  _ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  _load() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        this.priorityItems = (cfg.priorityItems || []).map((s) => s.toLowerCase());
        this.batchCounter = cfg.batchCounter || 0;
        this.live = !!cfg.live;
        this.sessionStartedAt = cfg.sessionStartedAt || null;
      }
    } catch (e) {
      console.warn('[queue] could not load config:', e.message);
    }
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        this.history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) || [];
      }
    } catch (e) {
      console.warn('[queue] could not load history:', e.message);
    }
    try {
      if (fs.existsSync(STATE_FILE)) {
        const arr = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        for (const o of arr) this.orders.set(o.id, o);
        // Rebuild openBatch map from queued orders.
        for (const o of arr) {
          if (o.status === 'queued') this.openBatch.set(o.buyerId, o.batchKey);
        }
        console.log(`[queue] restored ${this.orders.size} orders from disk`);
      }
    } catch (e) {
      console.warn('[queue] could not load state:', e.message);
    }
  }

  _persist() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify([...this.orders.values()]));
      fs.writeFileSync(
        CONFIG_FILE,
        JSON.stringify({
          priorityItems: this.priorityItems,
          batchCounter: this.batchCounter,
          live: this.live,
          sessionStartedAt: this.sessionStartedAt,
        })
      );
    } catch (e) {
      console.warn('[queue] persist failed:', e.message);
    }
  }

  _persistHistory() {
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(this.history));
    } catch (e) {
      console.warn('[queue] history persist failed:', e.message);
    }
  }

  /** Detailed per-order records of everything fulfilled this session. */
  fulfilledRecords() {
    return [...this.orders.values()]
      .filter((o) => o.status === 'fulfilled')
      .sort((a, b) => (b.fulfilledAt || 0) - (a.fulfilledAt || 0))
      .map((o) => ({
        orderId: o.id,
        buyerId: o.buyerId,
        buyer: o.buyer,
        items: o.items,
        total: o.total,
        fulfilledAt: o.fulfilledAt,
      }));
  }

  /** Detailed per-order records of everything cancelled this session. */
  cancelledRecords() {
    return [...this.orders.values()]
      .filter((o) => o.status === 'cancelled')
      .sort((a, b) => (b.cancelledAt || 0) - (a.cancelledAt || 0))
      .map((o) => ({
        orderId: o.id,
        buyerId: o.buyerId,
        buyer: o.buyer,
        items: o.items,
        total: o.total,
        cancelledAt: o.cancelledAt,
      }));
  }

  _isPriorityOrder(items) {
    if (!this.priorityItems.length) return false;
    return (items || []).some((it) => {
      const name = (it.name || '').toLowerCase();
      const sku = (it.sku || '').toLowerCase();
      return this.priorityItems.some((p) => p && (name.includes(p) || sku.includes(p)));
    });
  }

  /** Ingest an order. Merges into the buyer's open slot if one exists. */
  upsertOrder(raw) {
    const id = String(raw.id);
    if (this.orders.has(id)) return this.orders.get(id); // idempotent on order id

    // Off-air: when not live, incoming orders are ignored entirely.
    if (!this.live) return null;

    const buyerId = String(raw.buyerId);
    const items = raw.items || [];
    const hasPriority = this._isPriorityOrder(items);

    // Find (or open) the buyer's active slot.
    let batchKey = this.openBatch.get(buyerId);
    let mergedInto = false;
    if (batchKey) {
      mergedInto = true;
    } else {
      batchKey = `${buyerId}#${++this.batchCounter}`;
      this.openBatch.set(buyerId, batchKey);
    }

    const order = {
      id,
      buyerId,
      buyer: raw.buyer || 'Buyer',
      items,
      total: Number(raw.total || 0),
      createdAt: raw.createdAt || Date.now(),
      receivedAt: Date.now(),
      status: 'queued',
      batchKey,
      hasPriority,
    };
    this.orders.set(id, order);
    this._persist();

    const entry = this._entryFor(batchKey);
    this.emit('change', { reason: mergedInto ? 'merged' : 'new-slot', entry, order });
    if (!mergedInto) this.emit('new-slot', entry);
    else this.emit('merged', { entry, order });
    return order;
  }

  /** Build an aggregated slot entry from all queued orders sharing a batchKey. */
  _entryFor(batchKey) {
    const orders = [...this.orders.values()].filter(
      (o) => o.batchKey === batchKey && o.status === 'queued'
    );
    if (!orders.length) return null;
    const first = orders.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
    // How many orders from this same buyer were already fulfilled earlier this
    // stream — powers the "ordered earlier today" heads-up badge in the panel.
    const priorFulfilled = [...this.orders.values()].filter(
      (o) => o.buyerId === first.buyerId && o.status === 'fulfilled'
    ).length;
    const priorityOrders = orders.filter((o) => o.hasPriority);
    const isPriority = priorityOrders.length > 0;
    const priorityAt = isPriority
      ? Math.min(...priorityOrders.map((o) => o.createdAt))
      : Infinity;

    // Merge item lines (sum quantities of same-name items).
    const itemMap = new Map();
    for (const o of orders) {
      for (const it of o.items) {
        const key = it.name;
        itemMap.set(key, (itemMap.get(key) || 0) + (it.qty || 1));
      }
    }
    const items = [...itemMap.entries()].map(([name, qty]) => ({ name, qty }));

    return {
      key: batchKey,
      buyerId: first.buyerId,
      buyer: first.buyer,
      orderIds: orders.map((o) => o.id),
      orderCount: orders.length,
      items,
      itemCount: items.reduce((n, i) => n + i.qty, 0),
      total: orders.reduce((s, o) => s + o.total, 0),
      isPriority,
      priorityItems: [...new Set(
        orders.flatMap((o) => o.items.filter((it) => this._isPriorityOrder([it])).map((it) => it.name))
      )],
      firstOrderAt: first.createdAt,
      priorityAt,
      bumped: !!first.bumped,
      priorFulfilled,
      _bumpKey: batchKey,
    };
  }

  markFulfilled(batchKey) {
    const orders = [...this.orders.values()].filter(
      (o) => o.batchKey === batchKey && o.status === 'queued'
    );
    if (!orders.length) return null;
    const buyerId = orders[0].buyerId;
    const now = Date.now();
    for (const o of orders) {
      o.status = 'fulfilled';
      o.fulfilledAt = now;
      o.bumped = false;
    }
    if (this.openBatch.get(buyerId) === batchKey) this.openBatch.delete(buyerId);
    this._persist();
    this.emit('change', { reason: 'fulfilled', batchKey, buyerId });
    return { batchKey, buyerId };
  }

  reopen(batchKey) {
    const orders = [...this.orders.values()].filter((o) => o.batchKey === batchKey);
    if (!orders.length) return null;
    const buyerId = orders[0].buyerId;
    // Only reopen if the buyer has no other open slot.
    if (this.openBatch.has(buyerId)) return null;
    for (const o of orders) {
      o.status = 'queued';
      o.fulfilledAt = null;
    }
    this.openBatch.set(buyerId, batchKey);
    this._persist();
    this.emit('change', { reason: 'reopened', batchKey });
    return { batchKey };
  }

  /** Force a slot to the very top. Only one slot can be bumped at a time. */
  bump(batchKey) {
    let found = false;
    for (const o of this.orders.values()) {
      if (o.batchKey === batchKey && o.status === 'queued') {
        o.bumped = true;
        found = true;
      } else if (o.bumped) {
        o.bumped = false;
      }
    }
    if (!found) return null;
    this._persist();
    this.emit('change', { reason: 'bumped', batchKey });
    return { batchKey };
  }

  /** Configure which item names/SKUs trigger priority. Recomputes existing orders. */
  setPriorityItems(list) {
    this.priorityItems = (list || [])
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean);
    for (const o of this.orders.values()) {
      o.hasPriority = this._isPriorityOrder(o.items);
    }
    this._persist();
    this.emit('change', { reason: 'priority-config', priorityItems: this.priorityItems });
  }

  /** Start a live: archives the finished stream, clears the queue, and begins
   *  accepting orders. */
  goLive() {
    // Archive the stream that just finished (if it had any activity).
    const records = this.fulfilledRecords();
    const cancelledRecs = this.cancelledRecords();
    if (records.length || cancelledRecs.length) {
      this.history.unshift({
        id: String(this.sessionStartedAt || Date.now()),
        startedAt: this.sessionStartedAt || null,
        endedAt: Date.now(),
        count: records.length,
        value: records.reduce((s, r) => s + r.total, 0),
        fulfilled: records,
        cancelled: cancelledRecs,
      });
      this.history = this.history.slice(0, MAX_HISTORY);
      this._persistHistory();
    }
    this.orders.clear();
    this.openBatch.clear();
    this.sessionStartedAt = Date.now();
    this.live = true;
    this._persist();
    this.emit('change', { reason: 'go-live' });
  }

  /** End a live: stop accepting new orders. The current queue stays so any
   *  remaining orders can still be fulfilled from the panel. */
  endLive() {
    this.live = false;
    this._persist();
    this.emit('change', { reason: 'end-live' });
  }

  /**
   * Active queue, top = next to handle:
   *   1. Manually bumped slot.
   *   2. Priority slots before normal slots.
   *   3. Priority tier: earliest priority-item purchase first.
   *      Normal tier: earliest order first.
   */
  activeQueue() {
    const keys = new Set(
      [...this.orders.values()].filter((o) => o.status === 'queued').map((o) => o.batchKey)
    );
    const entries = [...keys].map((k) => this._entryFor(k)).filter(Boolean);
    entries.sort((a, b) => {
      if (a.bumped !== b.bumped) return a.bumped ? -1 : 1;
      if (a.isPriority !== b.isPriority) return a.isPriority ? -1 : 1;
      if (a.isPriority) return a.priorityAt - b.priorityAt;
      return a.firstOrderAt - b.firstOrderAt;
    });
    return entries.map((e, i) => ({ ...e, position: i + 1 }));
  }

  fulfilledSlots() {
    const byBatch = new Map();
    for (const o of this.orders.values()) {
      if (o.status !== 'fulfilled') continue;
      if (!byBatch.has(o.batchKey)) byBatch.set(o.batchKey, []);
      byBatch.get(o.batchKey).push(o);
    }
    const slots = [...byBatch.entries()].map(([key, orders]) => {
      const first = orders[0];
      return {
        key,
        buyer: first.buyer,
        buyerId: first.buyerId,
        orderIds: orders.map((o) => o.id),
        itemCount: orders.reduce((n, o) => n + o.items.reduce((m, i) => m + (i.qty || 1), 0), 0),
        total: orders.reduce((s, o) => s + o.total, 0),
        fulfilledAt: Math.max(...orders.map((o) => o.fulfilledAt || 0)),
      };
    });
    slots.sort((a, b) => b.fulfilledAt - a.fulfilledAt);
    return slots;
  }

  stats() {
    const active = this.activeQueue();
    return {
      activeCount: active.length,
      priorityCount: active.filter((e) => e.isPriority).length,
      fulfilledCount: this.fulfilledSlots().length,
      activeValue: active.reduce((s, e) => s + e.total, 0),
      priorityItems: this.priorityItems,
      live: this.live,
    };
  }

  snapshot() {
    return {
      queue: this.activeQueue(),
      fulfilled: this.fulfilledSlots().slice(0, 50),
      cancelled: this.cancelledSlots().slice(0, 50),
      stats: this.stats(),
      config: { priorityItems: this.priorityItems },
      history: this.history.map((s) => ({
        id: s.id,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        count: s.count,
        value: s.value,
      })),
    };
  }

  reset() {
    this.orders.clear();
    this.openBatch.clear();
    this._persist();
    this.emit('change', { reason: 'reset' });
  }

  /** Remove a whole slot from the queue WITHOUT fulfilling it (e.g. the buyer
   *  cancelled). Marked 'cancelled' so it drops out of the active queue and the
   *  fulfilled list, and shows in the Cancelled section for tracking. */
  removeSlot(batchKey) {
    const orders = [...this.orders.values()].filter(
      (o) => o.batchKey === batchKey && o.status === 'queued'
    );
    if (!orders.length) return null;
    const buyerId = orders[0].buyerId;
    const now = Date.now();
    for (const o of orders) { o.status = 'cancelled'; o.cancelledAt = now; o.bumped = false; }
    if (this.openBatch.get(buyerId) === batchKey) this.openBatch.delete(buyerId);
    this._persist();
    this.emit('change', { reason: 'cancelled', batchKey });
    return { batchKey };
  }

  /** Cancel a SINGLE order by its order id (used by the auto re-check when an
   *  order flips to CANCELLED on TikTok). Leaves any other orders in the same
   *  buyer's slot untouched. */
  cancelOrder(orderId) {
    const o = this.orders.get(String(orderId));
    if (!o || o.status !== 'queued') return null;
    o.status = 'cancelled';
    o.cancelledAt = Date.now();
    o.bumped = false;
    // If the buyer's open slot has no queued orders left, close it.
    const stillOpen = [...this.orders.values()].some(
      (x) => x.batchKey === o.batchKey && x.status === 'queued'
    );
    if (!stillOpen && this.openBatch.get(o.buyerId) === o.batchKey) this.openBatch.delete(o.buyerId);
    this._persist();
    this.emit('change', { reason: 'cancelled', orderId: String(orderId) });
    return o;
  }

  /** Cancelled slots (grouped by buyer batch) for the admin Cancelled section. */
  cancelledSlots() {
    const byBatch = new Map();
    for (const o of this.orders.values()) {
      if (o.status !== 'cancelled') continue;
      if (!byBatch.has(o.batchKey)) byBatch.set(o.batchKey, []);
      byBatch.get(o.batchKey).push(o);
    }
    const slots = [...byBatch.entries()].map(([key, orders]) => {
      const first = orders[0];
      return {
        key,
        buyer: first.buyer,
        buyerId: first.buyerId,
        orderIds: orders.map((o) => o.id),
        itemCount: orders.reduce((n, o) => n + o.items.reduce((m, i) => m + (i.qty || 1), 0), 0),
        total: orders.reduce((s, o) => s + o.total, 0),
        cancelledAt: Math.max(...orders.map((o) => o.cancelledAt || 0)),
      };
    });
    slots.sort((a, b) => b.cancelledAt - a.cancelledAt);
    return slots;
  }

  /** Inject a synthetic order for testing (e.g. label printing) regardless of
   *  live state. Behaves like a real ingest otherwise (merges by buyer, etc.). */
  injectTestOrder(raw) {
    const wasLive = this.live;
    this.live = true;
    const order = this.upsertOrder(raw);
    this.live = wasLive;
    this._persist();
    this.emit('change', { reason: 'test-order' });
    return order;
  }
}
