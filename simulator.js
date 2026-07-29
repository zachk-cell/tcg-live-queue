// Order simulator.
//
// Generates fake TikTok Shop orders so you can watch the whole system work
// (web dashboard + Discord + queue rules) before your real TikTok app is live.
// It deliberately produces: repeat buyers (to show slot-merging) and priority
// items (to show top-of-queue bumping).
//
// Enable with SIMULATE=true. Rate roughly matches a busy live (~1 order/min),
// but sped up here so you see movement immediately (default every ~2.5s).

const BUYERS = [
  'cardfiend', 'ripnship', 'mtg_maria', 'pokedad', 'slabqueen',
  'vintage_vince', 'gradedgoblin', 'holo_hunter', 'binderbabe', 'topdeck_tom',
  'chaserchloe', 'raredude', 'pullpalace', 'fatpackfrank', 'shinysam',
];

const NORMAL_ITEMS = [
  'Single: Charizard base set',
  'Single: Black Lotus (played)',
  'Pokemon 151 pack',
  'Lorcana booster',
  'Bulk common lot',
  'One Piece OP-05 pack',
  'Sports card mystery pack',
];

// These names contain the default priority trigger substrings ("break", "slab").
const PRIORITY_ITEMS = [
  'BREAK slot: PSA 10 break',
  'BREAK slot: Vintage box break',
  'Graded SLAB: PSA 9 Pikachu',
];

let seq = 1000;

function pick(arr) {
  // Deterministic-ish spread without Math.random (not available): rotate by seq.
  return arr[seq % arr.length];
}

export function startSimulator(queue, opts = {}) {
  const intervalMs = opts.intervalMs || 2500;

  function makeOrder() {
    seq++;
    // Every ~4th order reuses a recent buyer -> demonstrates slot merging.
    const buyerIdx = seq % 4 === 0 ? (seq - 1) % BUYERS.length : seq % BUYERS.length;
    const buyer = BUYERS[buyerIdx];
    // Every ~5th order includes a priority item.
    const isPriority = seq % 5 === 0;
    const itemPool = isPriority ? PRIORITY_ITEMS : NORMAL_ITEMS;
    const name = itemPool[seq % itemPool.length];
    const qty = (seq % 3) + 1;
    const price = isPriority ? 45 + (seq % 40) : 5 + (seq % 30);
    return {
      id: `SIM-${seq}`,
      buyerId: `buyer-${buyerIdx}`,
      buyer,
      items: [{ name, qty }],
      total: price * qty,
      createdAt: Date.now(),
    };
  }

  const timer = setInterval(() => {
    queue.upsertOrder(makeOrder());
  }, intervalMs);
  timer.unref?.();

  console.log(`[sim] simulator running — new order every ${intervalMs}ms`);
  console.log('[sim] priority trigger words for the demo: "break", "slab"');
  return timer;
}
