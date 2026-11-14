// Radar scoring for token-radar-01.
//
// What this file does, in one paragraph: it takes the sealed snapshot of the
// protocol universe, keeps the protocols that have no token and are not a
// repackaged product of a token that already trades, and prices each of them
// with a small model built only from the snapshot's own numbers — how much
// value is locked, how fast that value moved in the last week, and how long
// the protocol has been running without launching a token. The result is a
// board ordered by that price, plus a six-step farming plan per row and the
// compact dataset the dashboard page renders.
//
// The price has three parts, and every protocol is priced the same way:
//
//   size factor   0.55 * (10_000_000 / tvl) ^ 0.15, held inside [0.06, 0.55]
//                 Small protocols are priced off a bigger slice of their
//                 locked value than giants are. The anchor is the snapshot
//                 itself: its live-token protocols trade at a median
//                 market-cap-to-TVL near 0.21, and this factor lives in that
//                 neighbourhood (about 0.43 at $50M of TVL, 0.30 at $500M,
//                 0.18 at $10B).
//   weekly push   1 + clamp(change_7d, -50, 100) / 100 * 0.6
//                 One hot week can lift a protocol, but never carry it.
//   seasoning     0.7 + 0.3 * min(age_days, 1460) / 1460
//                 Four years with no token earns the full weight; a fresh
//                 listing earns the floor. A missing listing date counts as
//                 365 days.
//   price         max(1, round(tvl * size factor * weekly push * seasoning))
//
// No name is ever treated specially. The watchlist is a floor, not a
// ceiling: all forty of its slugs must appear, and every other protocol the
// snapshot can price joins them.

// One protocol record, exactly as the snapshot carries it.
export type Proto = {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
};

// The whole snapshot document.
export type Snap = {
  as_of: string; source: string; floor_usd: number;
  protocols: Proto[]; watchlist: string[];
};

// The tuning the dashboard prints and re-runs. Field names are the
// dashboard's contract, so the page and this file must agree on them.
export type Tune = {
  baseMultiple: number; referenceTvl: number; exponent: number;
  floorMultiple: number; capMultiple: number; growthWeight: number;
  growthLow: number; growthHigh: number; maturityFloor: number;
  maturitySpan: number; maturityDays: number; defaultAgeDays: number;
};

export const TUNE: Tune = {
  baseMultiple: 0.55, referenceTvl: 10_000_000, exponent: 0.15,
  floorMultiple: 0.06, capMultiple: 0.55, growthWeight: 0.6,
  growthLow: -50, growthHigh: 100, maturityFloor: 0.7,
  maturitySpan: 0.3, maturityDays: 1460, defaultAgeDays: 365,
};

export const MODEL_LABEL = 'radar-2';
export const LIVE_SHOWN = 24;

export type Step = { action: string; cost: string; time: string };

export type BoardRow = {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
  token_status: 'pre-token'; age_days: number | null; implied_value_usd: number;
  model: {
    multiple: number; growth_pct: number; growth_mult: number;
    maturity_mult: number; age_days: number | null;
  };
  farm_steps: string[];
};

export type DashRow = {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; age_days: number | null; implied_value_usd: number;
  multiple: number; growth_mult: number; maturity_mult: number; farm_steps: string[];
};

export type LiveRow = {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; mcap_usd: number | null; change_7d: number | null;
};

export type DashData = {
  as_of: string; source: string; floor_usd: number; model: Tune; model_version: string;
  watchlist: string[]; watchlist_size: number; board_size: number;
  early_size: number; live_size: number; rows: DashRow[]; live: LiveRow[];
};

export class SnapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapError';
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const clampNum = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

const asNum = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const round4 = (v: number): number => Math.round(v * 10000) / 10000;

// Whole days from a listing date to the snapshot date, or null when either
// end is missing or unparseable. Negative spans count as zero days.
export const daysListed = (asOf: string, listedAt: string | null): number | null => {
  if (listedAt === null) return null;
  const end = Date.parse(asOf + 'T00:00:00Z');
  const start = Date.parse(listedAt + 'T00:00:00Z');
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / MS_PER_DAY));
};

// The size factor: smaller locked value, bigger slice of it.
export const sizeFactor = (tvl: number, tune: Tune): number => {
  if (!(tvl > 0) || !Number.isFinite(tvl)) return tune.floorMultiple;
  const raw = tune.baseMultiple * Math.pow(tune.referenceTvl / tvl, tune.exponent);
  return clampNum(raw, tune.floorMultiple, tune.capMultiple);
};

export type Score = {
  value: number; factor: number; growthPct: number;
  growthFactor: number; maturityFactor: number; age: number | null;
};

// One protocol, priced. The arithmetic here is the whole model; the
// dashboard page repeats it to check each row it shows.
export const scoreProtocol = (p: Proto, asOf: string, tune: Tune): Score => {
  const age = daysListed(asOf, p.listed_at);
  const growthPct = clampNum(asNum(p.change_7d, 0), tune.growthLow, tune.growthHigh);
  const growthFactor = 1 + (growthPct / 100) * tune.growthWeight;
  const aged = age === null ? tune.defaultAgeDays : age;
  const seasoned = clampNum(aged, 0, tune.maturityDays);
  const maturityFactor = tune.maturityFloor + (seasoned / tune.maturityDays) * tune.maturitySpan;
  const factor = sizeFactor(p.tvl_usd, tune);
  const value = Math.max(1, Math.round(p.tvl_usd * factor * growthFactor * maturityFactor));
  return { value, factor, growthPct, growthFactor, maturityFactor, age };
};

// Kinds that are a repackaged product of a token that already trades, not a
// protocol waiting for its own token.
const DERIVATIVE_KINDS = 'Bridge|Canonical Bridge|Liquid Staking|Liquid Restaking|Restaked BTC|CEX'.split('|');

// A name that ends in a release marker is a versioned pool of something else.
const VERSION_TAIL = /\s[vV]\d+(?:\.\d+)?$|\s\d+\.\d+$/;
// A whole word that says wrapped, staked or staking.
const WRAP_WORD = /\bwrapped\b|\bstaked\b|\bstaking\b/i;
// A name that opens with an exchange's name.
const HOUSES = 'Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini'.split('|');
const HOUSE_NAMED = new RegExp('^(?:' + HOUSES.join('|') + ')\\b');

// A protocol records no token at all: no market cap, no CoinGecko id, no symbol.
export const hasNoToken = (p: Proto): boolean =>
  p.mcap_usd === null && p.gecko_id === null && p.symbol === null;

// A protocol the board may rank: no token, and not a derivative product.
export const rankable = (p: Proto): boolean =>
  hasNoToken(p) &&
  (p.category === null || !DERIVATIVE_KINDS.includes(p.category)) &&
  !VERSION_TAIL.test(p.name) &&
  !WRAP_WORD.test(p.name) &&
  !HOUSE_NAMED.test(p.name);

// The chain a plan is written for: the first the protocol names.
const homeChain = (p: Proto): string => (p.chains.length > 0 ? p.chains[0]! : 'its main chain');

// The stake for one farming wallet, stepped by the protocol's own size:
// [minimum TVL for the tier, stake]. Below every tier the stake is $50.
const STAKE_TIERS: Array<[number, number]> = [
  [5_000_000_000, 250],
  [1_000_000_000, 150],
  [100_000_000, 100],
];
const stakeFor = (p: Proto): number => {
  for (const [floor, stake] of STAKE_TIERS) if (p.tvl_usd >= floor) return stake;
  return 50;
};

// How long to sit in the position: younger protocols get a longer window so
// the activity lands in more than one snapshot. [maximum age, hold days].
const HOLD_TIERS: Array<[number, number]> = [
  [180, 60],
  [365, 45],
];
const holdFor = (age: number | null): number => {
  if (age === null) return 30;
  for (const [cap, hold] of HOLD_TIERS) if (age < cap) return hold;
  return 30;
};

// The one thing to do with the stake, picked from the category's wording.
const coreMove = (p: Proto, stake: number, chain: string): string => {
  const kind = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (kind.includes('lend') || kind.includes('cdp') || kind.includes('collateral'))
    return `Put $${stake} of USDC to work as a loan on ${name} (${chain}) and let the deposit earn through the full hold.`;
  if (kind.includes('dex') || kind.includes('yield') || kind.includes('leveraged farm') || kind.includes('farm'))
    return `Supply $${stake} of liquidity to the busiest pool on ${name} (${chain}) and keep the LP tokens in the wallet.`;
  if (kind.includes('bridge') || kind.includes('cross chain'))
    return `Send $${stake} of USDC across to ${chain} with ${name}, then put the arrived funds to work inside its app.`;
  if (kind.includes('staking') || kind.includes('restak'))
    return `Lock $${stake} of the native asset with ${name} on ${chain} and keep the receipt token it issues.`;
  if (kind.includes('perpetual') || kind.includes('derivative') || kind.includes('options'))
    return `Fund ${name} (${chain}) with $${stake} of USDC margin and open one small hedged trade.`;
  if (kind.includes('prediction'))
    return `Load $${stake} onto ${name} (${chain}) and back one side of a live prediction market.`;
  if (kind.includes('curator') || kind.includes('allocator') || kind.includes('risk'))
    return `Place $${stake} in a ${name} vault on ${chain} and hold the vault shares it returns.`;
  if (kind.includes('stable'))
    return `Create or deposit $${stake} of the stable asset issued through ${name} on ${chain} and leave it parked.`;
  if (kind.includes('rwa'))
    return `Take $${stake} of the yield-bearing asset ${name} issues on ${chain} and hold it in the farm wallet.`;
  if (kind.includes('insurance'))
    return `Take out $${stake} of cover with ${name} on ${chain} and keep the policy in force.`;
  if (kind.includes('payment') || kind.includes('card'))
    return `Run $${stake} of spending through ${name} on ${chain}, split across two or three separate payments.`;
  if (kind.includes('chain'))
    return `Work $${stake} through ${name} itself: bridge in, make one swap, and leave the position on its own chain.`;
  return `Place $${stake} of USDC with ${name} on ${chain} and leave the position alone.`;
};

// One step as a single string: the move, then what it costs and how long it
// takes. The gate wants 20 to 600 characters, so overlong steps are cut and
// stubs are padded with a real instruction.
export const renderStep = (step: Step): string => {
  let line = [step.action, 'Cost: ' + step.cost + '.', 'Time: ' + step.time + '.'].join(' ');
  if (line.length > 600) line = line.slice(0, 597) + '...';
  if (line.length < 20) line = line + ' Keep the position open and check the protocol page weekly.';
  return line;
};

// Six steps, each derived from the protocol's own record (category, chains,
// size, age). Nothing here names a protocol.
export const farmPlan = (p: Proto, age: number | null): Step[] => {
  const chain = homeChain(p);
  const stake = stakeFor(p);
  const hold = holdFor(age);
  const bridgeFee = stake >= 150 ? 8 : 4;
  return [
    {
      action:
        'Open a fresh wallet that holds only the funds you mean to farm, and write its seed phrase on paper, never in a screenshot.',
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      action: `Move $${stake} of USDC onto ${chain} first, so the farm wallet is funded where ${p.name} actually operates.`,
      cost: `about $${bridgeFee} of gas to bridge`,
      time: '10 minutes',
    },
    {
      action: coreMove(p, stake, chain),
      cost: `$${stake} of capital and about $${bridgeFee} of gas`,
      time: '15 minutes to set up',
    },
    {
      action:
        'Do one qualifying action each week — a deposit, a borrow, a swap or a vote — so the wallet stays visibly active.',
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      action: `Leave the position untouched for ${hold} days at least, so it shows up across several snapshots instead of one.`,
      cost: `the $${stake} stays in the position`,
      time: `${hold} days`,
    },
    {
      action: `Before withdrawing, check ${p.name}'s own points or rewards page on its official site and claim only through the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
  ];
};

// Order helpers: price first, then TVL, then slug — the same tie-breaks
// everywhere, so two runs always agree.
const byPrice = (a: { s: Score; p: Proto }, b: { s: Score; p: Proto }): number =>
  b.s.value - a.s.value || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0);
const byTvl = (a: Proto, b: Proto): number =>
  b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
const byMcap = (a: Proto, b: Proto): number =>
  (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd;

// The ranked board: every watchlist slug the snapshot carries, plus every
// other rankable protocol, priced and ordered by price, ties broken by slug.
export const buildBoard = (snap: Snap, tune: Tune = TUNE): BoardRow[] => {
  const bySlug = new Map(snap.protocols.map((p) => [p.slug, p]));
  const picked = new Map<string, Proto>();
  for (const slug of snap.watchlist) {
    const found = bySlug.get(slug);
    if (found !== undefined) picked.set(slug, found);
  }
  const rest = snap.protocols.filter((p) => !picked.has(p.slug) && rankable(p)).sort(byTvl);
  for (const p of rest) picked.set(p.slug, p);

  const priced = [...picked.values()].map((p) => ({ p, s: scoreProtocol(p, snap.as_of, tune) }));
  priced.sort(byPrice);
  return priced.map((entry, i) => {
    const { p, s } = entry;
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: 'pre-token' as const,
      age_days: s.age,
      implied_value_usd: s.value,
      model: {
        multiple: round4(s.factor),
        growth_pct: s.growthPct,
        growth_mult: round4(s.growthFactor),
        maturity_mult: round4(s.maturityFactor),
        age_days: s.age,
      },
      farm_steps: farmPlan(p, s.age).map(renderStep),
    };
  });
};

// The live-token set, kept apart from the board and ordered by market cap.
export const liveSet = (snap: Snap): LiveRow[] =>
  snap.protocols
    .filter((p) => !hasNoToken(p) && (p.category === null || !DERIVATIVE_KINDS.includes(p.category)))
    .sort(byMcap)
    .slice(0, LIVE_SHOWN)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));

// One board row, slimmed down for the dashboard's data file.
export const dashRow = (row: BoardRow): DashRow => ({
  rank: row.rank,
  slug: row.slug,
  name: row.name,
  category: row.category,
  chains: row.chains,
  tvl_usd: row.tvl_usd,
  change_7d: row.change_7d,
  mcap_usd: row.mcap_usd,
  listed_at: row.listed_at,
  age_days: row.age_days,
  implied_value_usd: row.implied_value_usd,
  multiple: row.model.multiple,
  growth_mult: row.model.growth_mult,
  maturity_mult: row.model.maturity_mult,
  farm_steps: row.farm_steps,
});

// Everything the dashboard page needs, from the snapshot.
export const buildDash = (snap: Snap, tune: Tune = TUNE): { board: BoardRow[]; dash: DashData } => {
  const board = buildBoard(snap, tune);
  const live = liveSet(snap);
  const early = board.filter((r) => !snap.watchlist.includes(r.slug)).length;
  const dash: DashData = {
    as_of: snap.as_of,
    source: snap.source,
    floor_usd: snap.floor_usd,
    model: tune,
    model_version: MODEL_LABEL,
    watchlist: snap.watchlist,
    watchlist_size: snap.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(dashRow),
    live,
  };
  return { board, dash };
};

const fail = (message: string): never => {
  throw new SnapError(message);
};

// The snapshot out of a file's text. Anything off-shape is refused with a
// plain reason instead of scoring a broken document.
export const readSnap = (text: string): Snap => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('snapshot.json is not a JSON object');
  const doc = raw as Record<string, unknown>;
  if (typeof doc.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(doc.as_of)) fail('snapshot.json has no as_of date');
  if (typeof doc.source !== 'string') fail('snapshot.json has no source');
  if (typeof doc.floor_usd !== 'number' || !Number.isSafeInteger(doc.floor_usd) || doc.floor_usd <= 0)
    fail('snapshot.json has no floor_usd');
  if (!Array.isArray(doc.protocols)) fail('snapshot.json has no protocols array');
  if (!Array.isArray(doc.watchlist) || doc.watchlist.some((s) => typeof s !== 'string'))
    fail('snapshot.json has no watchlist of slugs');
  const protocols = (doc.protocols as unknown[]).map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`snapshot.json's protocol ${i} is not an object`);
    const rec = v as Record<string, unknown>;
    const okShape =
      typeof rec.slug === 'string' && typeof rec.name === 'string' &&
      typeof rec.tvl_usd === 'number' && Number.isFinite(rec.tvl_usd);
    if (!okShape) fail(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    const numOrNull = (key: string): number | null =>
      typeof rec[key] === 'number' && Number.isFinite(rec[key] as number) ? (rec[key] as number) : null;
    const strOrNull = (key: string): string | null => (typeof rec[key] === 'string' ? (rec[key] as string) : null);
    return {
      slug: rec.slug as string,
      name: rec.name as string,
      category: strOrNull('category'),
      chains: Array.isArray(rec.chains)
        ? (rec.chains as unknown[]).filter((c): c is string => typeof c === 'string')
        : [],
      tvl_usd: rec.tvl_usd as number,
      change_7d: numOrNull('change_7d'),
      listed_at: strOrNull('listed_at'),
      gecko_id: strOrNull('gecko_id'),
      symbol: strOrNull('symbol'),
      mcap_usd: numOrNull('mcap_usd'),
    };
  });
  return {
    as_of: doc.as_of as string,
    source: doc.source as string,
    floor_usd: doc.floor_usd as number,
    protocols,
    watchlist: doc.watchlist as string[],
  };
};

// Why a board is not one the gate will take, or null when it is sound:
// coverage, ranks, order, one shared price, and the farm plans.
export const boardProblem = (board: BoardRow[], snap: Snap): string | null => {
  const have = new Set(board.map((r) => r.slug));
  const missing = snap.watchlist.filter((s) => !have.has(s));
  if (missing.length > 0)
    return `the board is short ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board carries ${board.length} rows, fewer than the 100 the gate asks for`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++)
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd)
      return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd)
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps)
      if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0)
      return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
};

// The dashboard's whole dataset as one script: no fetch, no network.
export const dashScript = (dash: DashData): string =>
  'window.RADAR = ' + JSON.stringify(dash) + ';\n';
