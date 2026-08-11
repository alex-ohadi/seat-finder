/**
 * Adjacency and seat-quality analysis over a Fandango seat map.
 *
 * "Two seats together" sounds trivial but the source data is inconsistent, and
 * getting it wrong means reporting "nothing available" for a half-empty theater.
 * Two independent signals exist, and each one is incomplete on its own:
 *
 *   1. Explicit `leftNeighbor` / `rightNeighbor` seat ids.
 *      Authoritative where present — they encode aisles and the wider spacing
 *      around wheelchair spaces. But some auditoriums leave them blank: Regal
 *      LA Live populates them for only 181 of 408 real pairs, so trusting them
 *      alone reports 0 pairs in a house with 75 open standard seats.
 *
 *   2. Geometry — seats sharing a `row`, ordered by `x`, with the gap between
 *      neighbours compared against that row's median seat pitch. A gap much
 *      larger than the pitch is an aisle. Always populated, and it agreed with
 *      the explicit links on all 875 pairs at TCL Chinese, which is what makes
 *      it trustworthy. It does under-report around wheelchair spaces, which sit
 *      ~1.4-2x the normal pitch apart and read as aisles.
 *
 * Each covers the other's blind spot, so adjacency is the union of the two.
 */

const AVAILABLE = 'A';

/** A gap wider than pitch * this is an aisle, not a neighbouring seat. */
const AISLE_RATIO = 1.35;

const ACCESSIBLE_TYPES = new Set(['wheelchair', 'companion']);

/**
 * Status codes, confirmed against Fandango's own renderer: its seat elements
 * carry `smp__seat--A` / `--R` / `--O` classes matching these exactly.
 */
export const SEAT_STATUS_MEANING = {
  A: 'available',
  R: 'reserved / sold',
  O: 'unavailable (held or blocked)',
};

/* ------------------------------------------------------------------ *
 * Seat quality
 * ------------------------------------------------------------------ */

/**
 * Where the best row sits, as a fraction of the way back (0 = front row,
 * 1 = back row). Roughly two thirds of the way back: well behind the middle,
 * but not against the rear wall.
 */
export const IDEAL_DEPTH = 0.65;

/**
 * How much the very back row loses relative to the ideal depth. At 0.3 the
 * back wall still scores 0.7 — clearly second best, never bad.
 */
const BACK_WALL_PENALTY = 0.3;

/**
 * How sharply quality falls off in front of the sweet spot. Above 1 this
 * punishes the whole front section rather than only the first row or two,
 * which is what "close to the screen is the worst choice" actually means.
 */
const FRONT_FALLOFF = 1.8;

/**
 * How sharply quality falls off toward the side walls. Above 1 this keeps a
 * mildly off-centre seat good while dropping the far sides away quickly.
 */
const SIDE_FALLOFF = 1.4;

/**
 * Depth gates the score rather than merely adding to it: a seat jammed against
 * the screen is the worst seat in the house even if it is perfectly centred.
 * These floors keep front-row and far-side options ordered among themselves
 * instead of all collapsing to zero.
 */
const FRONT_ROW_FLOOR = 0.06;
const SIDE_SEAT_FLOOR = 0.2;

/**
 * Normalised position of every seat, 0..1 on each axis:
 *   nx = 0 far left, 0.5 dead centre, 1 far right
 *   ny = 0 front row (nearest the screen), 1 back row
 *
 * Auditoriums differ wildly in size and shape, so a preferred area is only
 * portable between them in this normalised space.
 */
export function normalisePositions(seatMap) {
  const seats = seatMap?.seats ?? [];
  if (seats.length === 0) return new Map();

  const xs = seats.map((s) => s.x + (s.width ?? 0) / 2);
  const ys = seats.map((s) => s.y + (s.height ?? 0) / 2);
  const minX = Math.min(...xs);
  const spanX = Math.max(...xs) - minX;
  const minY = Math.min(...ys);
  const spanY = Math.max(...ys) - minY;

  const pos = new Map();
  seats.forEach((seat, i) => {
    pos.set(seat.id, {
      nx: spanX > 0 ? (xs[i] - minX) / spanX : 0.5,
      ny: spanY > 0 ? (ys[i] - minY) / spanY : 0.5,
    });
  });
  return pos;
}

/**
 * Depth preference: rises from the front to a peak at IDEAL_DEPTH, then eases
 * back off toward the rear wall. Far back is great, dead last row slightly less.
 */
export function depthScore(ny) {
  if (ny <= IDEAL_DEPTH) return Math.pow(ny / IDEAL_DEPTH, FRONT_FALLOFF);
  const past = (ny - IDEAL_DEPTH) / (1 - IDEAL_DEPTH);
  return 1 - past * BACK_WALL_PENALTY;
}

/** Horizontal preference: 1 dead centre, 0 against either side wall. */
export function centreScore(nx) {
  const offset = Math.min(1, Math.abs(nx - 0.5) * 2);
  return Math.pow(1 - offset, SIDE_FALLOFF);
}

/**
 * 0-100 quality score for a group of seats.
 *
 * Well back and dead centre is best; the back wall is a close second; up
 * against the screen is the worst seat in the house, and being centred there
 * does not rescue it. Depth therefore multiplies the centring term instead of
 * being averaged with it — averaging let a centred front-row pair score 55/100
 * and win the top recommendation slot.
 *
 * Roughly: sweet-spot centre 100 · back-wall centre 76 · mid-house centre 66
 * · back-wall side 15 · front-row centre 6 · front-row side 1.
 */
export function scoreSeats(positions, seatIds) {
  const pts = seatIds.map((id) => positions.get(id)).filter(Boolean);
  if (pts.length === 0) return 0;

  const nx = pts.reduce((a, p) => a + p.nx, 0) / pts.length;
  const ny = pts.reduce((a, p) => a + p.ny, 0) / pts.length;

  const depth = FRONT_ROW_FLOOR + (1 - FRONT_ROW_FLOOR) * depthScore(ny);
  const centred = SIDE_SEAT_FLOOR + (1 - SIDE_SEAT_FLOOR) * centreScore(nx);

  return Math.round(100 * depth * centred);
}

/* ------------------------------------------------------------------ *
 * Adjacency
 * ------------------------------------------------------------------ */

/**
 * Map each seat to the seat immediately on its right, merging both signals.
 * @returns {Map<string, string>} seat id -> seat id to its right
 */
export function buildRightwardAdjacency(seatMap) {
  const seats = seatMap?.seats ?? [];
  const byId = new Map(seats.map((s) => [s.id, s]));
  const right = new Map();

  // Signal 1: geometry, per row.
  const rows = new Map();
  for (const seat of seats) {
    if (seat.row == null || typeof seat.x !== 'number') continue;
    if (!rows.has(seat.row)) rows.set(seat.row, []);
    rows.get(seat.row).push(seat);
  }

  for (const rowSeats of rows.values()) {
    rowSeats.sort((a, b) => a.x - b.x);
    const gaps = [];
    for (let i = 0; i + 1 < rowSeats.length; i++) gaps.push(rowSeats[i + 1].x - rowSeats[i].x);
    if (gaps.length === 0) continue;

    const pitch = median(gaps);
    if (!(pitch > 0)) continue;

    for (let i = 0; i + 1 < rowSeats.length; i++) {
      if (rowSeats[i + 1].x - rowSeats[i].x <= pitch * AISLE_RATIO) {
        right.set(rowSeats[i].id, rowSeats[i + 1].id);
      }
    }
  }

  // Signal 2: explicit links, filling gaps geometry treated as aisles
  // (chiefly the wider spacing around wheelchair spaces).
  for (const seat of seats) {
    if (seat.rightNeighbor && byId.has(seat.rightNeighbor) && !right.has(seat.id)) {
      right.set(seat.id, seat.rightNeighbor);
    }
    if (seat.leftNeighbor && byId.has(seat.leftNeighbor) && !right.has(seat.leftNeighbor)) {
      right.set(seat.leftNeighbor, seat.id);
    }
  }

  return right;
}

/**
 * Find every run of `partySize` consecutive available seats, best first.
 *
 * @param {object} seatMap        raw /napi/seatMap response
 * @param {number} partySize      how many seats must be side by side
 * @param {object} [opts]
 * @param {boolean} [opts.includeAccessible=false] allow wheelchair/companion seats
 * @param {?{x0:number,y0:number,x1:number,y1:number}} [opts.zone]
 *        preferred area in normalised 0..1 coordinates; every seat in a run
 *        must fall inside it
 */
export function findAdjacentRuns(
  seatMap,
  partySize,
  { includeAccessible = false, zone = null } = {},
) {
  const seats = seatMap?.seats ?? [];
  const byId = new Map(seats.map((s) => [s.id, s]));
  const right = buildRightwardAdjacency(seatMap);
  const positions = normalisePositions(seatMap);

  const left = new Map();
  for (const [from, to] of right) left.set(to, from);

  const usable = (seat) => {
    if (!seat || seat.status !== AVAILABLE) return false;
    if (!includeAccessible && ACCESSIBLE_TYPES.has(seat.type)) return false;
    return true;
  };

  const inZone = (id) => {
    if (!zone) return true;
    const p = positions.get(id);
    if (!p) return false;
    return p.nx >= zone.x0 && p.nx <= zone.x1 && p.ny >= zone.y0 && p.ny <= zone.y1;
  };

  const runs = [];
  const seen = new Set();
  let maxRun = 0;
  let zoneRejected = 0;

  for (const seat of seats) {
    if (!usable(seat) || seen.has(seat.id)) continue;

    // Start only at the left end of a block so each block is walked once.
    const leftId = left.get(seat.id);
    if (leftId && usable(byId.get(leftId))) continue;

    const block = [];
    let cursor = seat;
    while (cursor && usable(cursor) && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      block.push(cursor);
      const nextId = right.get(cursor.id);
      cursor = nextId ? byId.get(nextId) : null;
    }

    if (block.length > maxRun) maxRun = block.length;
    if (block.length < partySize) continue;

    // A block of 5 with a party of 2 offers 4 real choices; emit each window so
    // the UI can show actual seat ids rather than just "a block exists".
    for (let i = 0; i + partySize <= block.length; i++) {
      const window = block.slice(i, i + partySize);
      const ids = window.map((s) => s.id);

      if (!ids.every(inZone)) {
        zoneRejected++;
        continue;
      }

      runs.push({
        seats: ids,
        row: rowLabelOf(window[0]),
        rowIndex: window[0].row ?? null,
        columns: window.map((s) => s.column ?? null),
        types: [...new Set(window.map((s) => s.type))],
        blockSize: block.length,
        score: scoreSeats(positions, ids),
      });
    }
  }

  runs.sort((a, b) => b.score - a.score || a.seats[0].localeCompare(b.seats[0]));

  return {
    runs,
    totalSeats: seats.length,
    availableSeats: seats.filter((s) => s.status === AVAILABLE).length,
    maxRun,
    zoneRejected,
  };
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Seat ids look like "A12" / "DD7"; the leading letters are the row label. */
function rowLabelOf(seat) {
  const m = /^([A-Za-z]+)/.exec(seat.id ?? '');
  return m ? m[1] : String(seat.row ?? '?');
}
