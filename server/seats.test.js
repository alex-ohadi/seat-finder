/**
 * Regression tests for the adjacency engine.
 *
 * Run: node --test server/
 *
 * The case that motivated most of these: an auditorium (Regal LA Live) that
 * leaves leftNeighbor/rightNeighbor blank on standard seats. A links-only
 * implementation reported 0 pairs there while 75 standard seats sat open.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findAdjacentRuns,
  buildRightwardAdjacency,
  depthScore,
  centreScore,
  normalisePositions,
  scoreSeats,
  IDEAL_DEPTH,
} from './seats.js';

const PITCH = 29.5;

/**
 * Build one row of seats.
 * @param spec.statuses  e.g. 'AARAA' - one char per seat
 * @param spec.links     'none' | 'full'  whether neighbour ids are populated
 * @param spec.gapAfter  index after which to insert an aisle-sized gap
 */
function makeRow({
  row = 1,
  prefix = 'A',
  statuses,
  links = 'full',
  gapAfter = null,
  types = null,
  startX = 0,
} = {}) {
  const seats = [];
  let x = startX;
  for (let i = 0; i < statuses.length; i++) {
    seats.push({
      id: `${prefix}${i + 1}`,
      row,
      column: i + 1,
      type: types?.[i] ?? 'standard',
      status: statuses[i],
      x,
      y: 0,
      width: 24,
      height: 24,
      leftNeighbor: '',
      rightNeighbor: '',
    });
    x += i === gapAfter ? PITCH * 3 : PITCH;
  }

  if (links === 'full') {
    for (let i = 0; i < seats.length; i++) {
      // An aisle means no link across the gap.
      if (i + 1 < seats.length && i !== gapAfter) seats[i].rightNeighbor = seats[i + 1].id;
      if (i - 1 >= 0 && i - 1 !== gapAfter) seats[i].leftNeighbor = seats[i - 1].id;
    }
  }
  return seats;
}

const mapOf = (...rows) => ({ seats: rows.flat() });

test('finds pairs when neighbour links are populated', () => {
  const map = mapOf(makeRow({ statuses: 'AAA', links: 'full' }));
  const { runs, maxRun } = findAdjacentRuns(map, 2);
  assert.equal(maxRun, 3);
  assert.deepEqual(
    runs.map((r) => r.seats),
    [
      ['A1', 'A2'],
      ['A2', 'A3'],
    ].sort(),
  );
});

test('REGRESSION: finds pairs when neighbour links are blank (geometry fallback)', () => {
  // This is the Regal LA Live shape. A links-only engine returns 0 here.
  const map = mapOf(makeRow({ statuses: 'AAA', links: 'none' }));
  const { runs, maxRun } = findAdjacentRuns(map, 2);
  assert.equal(maxRun, 3, 'geometry must recover the block when links are absent');
  assert.equal(runs.length, 2);
});

test('a sold seat splits a block', () => {
  const map = mapOf(makeRow({ statuses: 'AARAA', links: 'none' }));
  const { runs, maxRun } = findAdjacentRuns(map, 2);
  assert.equal(maxRun, 2);
  assert.deepEqual(
    runs.map((r) => r.seats).sort(),
    [
      ['A1', 'A2'],
      ['A4', 'A5'],
    ].sort(),
  );
});

test('an aisle is not an adjacency', () => {
  // Seats either side of an aisle must never be offered as "together".
  const map = mapOf(makeRow({ statuses: 'AAAA', links: 'none', gapAfter: 1 }));
  const { runs } = findAdjacentRuns(map, 2);
  const pairs = runs.map((r) => r.seats.join('+'));
  assert.ok(!pairs.includes('A2+A3'), `A2+A3 spans an aisle: got ${pairs.join(', ')}`);
  assert.deepEqual(pairs.sort(), ['A1+A2', 'A3+A4']);
});

test('party of 3 needs three in a row', () => {
  const map = mapOf(makeRow({ statuses: 'AARAA', links: 'none' }));
  assert.equal(findAdjacentRuns(map, 3).runs.length, 0);
  assert.equal(findAdjacentRuns(mapOf(makeRow({ statuses: 'AAAA' })), 3).runs.length, 2);
});

test('wheelchair and companion seats are excluded unless asked for', () => {
  const map = mapOf(
    makeRow({ statuses: 'AAA', links: 'none', types: ['wheelchair', 'companion', 'standard'] }),
  );
  assert.equal(findAdjacentRuns(map, 2).runs.length, 0, 'default must skip accessible seats');
  assert.equal(
    findAdjacentRuns(map, 2, { includeAccessible: true }).runs.length,
    2,
    'opt-in must include them',
  );
});

test('links bridge the wide gap around a wheelchair space', () => {
  // Wheelchair spaces sit ~1.4-2x normal pitch apart, which geometry alone
  // reads as an aisle. The explicit link is what proves they are neighbours.
  const seats = makeRow({
    statuses: 'AA',
    links: 'none',
    types: ['wheelchair', 'companion'],
  });
  seats[1].x = seats[0].x + PITCH * 2; // too wide for the geometric test
  seats[0].rightNeighbor = seats[1].id;
  seats[1].leftNeighbor = seats[0].id;

  const right = buildRightwardAdjacency({ seats });
  assert.equal(right.get(seats[0].id), seats[1].id);
  assert.equal(findAdjacentRuns({ seats }, 2, { includeAccessible: true }).runs.length, 1);
});

test('rows are independent of each other', () => {
  const map = mapOf(
    makeRow({ row: 1, prefix: 'A', statuses: 'AA', links: 'none' }),
    makeRow({ row: 2, prefix: 'B', statuses: 'AA', links: 'none' }),
  );
  const { runs } = findAdjacentRuns(map, 2);
  assert.deepEqual(runs.map((r) => r.seats).sort(), [['A1', 'A2'], ['B1', 'B2']].sort());
  assert.equal(runs.every((r) => new Set(r.seats.map((s) => s[0])).size === 1), true);
});

test('a sold-out house yields nothing', () => {
  const map = mapOf(makeRow({ statuses: 'RRRR', links: 'none' }));
  const result = findAdjacentRuns(map, 2);
  assert.equal(result.runs.length, 0);
  assert.equal(result.availableSeats, 0);
  assert.equal(result.maxRun, 0);
});

test('status O is not bookable', () => {
  const map = mapOf(makeRow({ statuses: 'AOOA', links: 'none' }));
  assert.equal(findAdjacentRuns(map, 2).runs.length, 0);
});

/* ---------------- seat quality ---------------- */

test('depth: far back beats the front, and the back wall is second best', () => {
  const front = depthScore(0);
  const mid = depthScore(0.5);
  const sweet = depthScore(IDEAL_DEPTH);
  const backWall = depthScore(1);

  assert.equal(sweet, 1, 'the sweet spot is the peak');
  assert.ok(backWall < sweet, 'the very back must not outrank the sweet spot');
  assert.ok(backWall > mid, 'but the very back is still better than mid-house');
  assert.ok(mid > front, 'and anything beats the front row');
  assert.ok(backWall >= 0.65, `back wall should stay strong, got ${backWall}`);
  assert.ok(IDEAL_DEPTH > 0.5 && IDEAL_DEPTH < 0.8, 'sweet spot sits past the middle, off the wall');
});

test('the whole front section scores badly, not just the first row', () => {
  // "Close to the screen is the worst choice" covers the front block, so a
  // centred seat a quarter of the way back must still rank poorly.
  const seats = [];
  for (let r = 1; r <= 20; r++) {
    for (let c = 1; c <= 20; c++) {
      seats.push({
        id: `R${r}C${c}`,
        row: r,
        column: c,
        x: c * 30,
        y: r * 30,
        width: 24,
        height: 24,
        status: 'A',
        type: 'standard',
      });
    }
  }
  const pos = normalisePositions({ seats });
  const centredAt = (r) => scoreSeats(pos, [`R${r}C10`, `R${r}C11`]);

  const quarterBack = centredAt(6); // ~26% back, dead centre
  const sweetSpot = centredAt(14); // ~68% back, dead centre
  assert.ok(quarterBack < 30, `a quarter of the way back should be weak, got ${quarterBack}`);
  assert.ok(sweetSpot > 90, `the sweet spot should be excellent, got ${sweetSpot}`);
  assert.ok(centredAt(1) < 10, 'the front row is the worst place in the house');
});

test('centre: dead centre beats the side walls', () => {
  assert.equal(centreScore(0.5), 1);
  assert.ok(centreScore(0.5) > centreScore(0.25));
  assert.ok(centreScore(0.25) > centreScore(0));
  assert.equal(centreScore(0), 0);
  assert.equal(centreScore(1), 0);
});

test('back-centre outranks front-side across a real grid', () => {
  // 5 rows deep, 5 seats wide, all open.
  const rows = [1, 2, 3, 4, 5].map((r) =>
    makeRow({ row: r, prefix: String.fromCharCode(64 + r), statuses: 'AAAAA', links: 'none' }).map(
      (s) => ({ ...s, y: (r - 1) * 30 }),
    ),
  );
  const map = mapOf(...rows);
  const { runs } = findAdjacentRuns(map, 2);

  const best = runs[0];
  const worst = runs[runs.length - 1];
  assert.ok(best.rowIndex >= 4, `best pair should be well back, got row ${best.rowIndex}`);
  assert.ok(worst.rowIndex <= 2, `worst pair should be near the screen, got row ${worst.rowIndex}`);
  assert.ok(best.score > worst.score);
  // Scores must be ordered.
  for (let i = 1; i < runs.length; i++) assert.ok(runs[i - 1].score >= runs[i].score);
});

test('being centred cannot rescue a front-row seat', () => {
  // 6 rows deep, 9 wide. The front row is fully open and dead centre; the back
  // rows have only one off-centre pair. Back-and-side must still beat
  // front-and-centre, because close to the screen is the worst place to sit.
  const rows = [
    makeRow({ row: 1, prefix: 'A', statuses: 'AAAAAAAAA', links: 'none' }),
    makeRow({ row: 2, prefix: 'B', statuses: 'RRRRRRRRR', links: 'none' }),
    makeRow({ row: 3, prefix: 'C', statuses: 'RRRRRRRRR', links: 'none' }),
    makeRow({ row: 4, prefix: 'D', statuses: 'RRRRRRRRR', links: 'none' }),
    makeRow({ row: 5, prefix: 'E', statuses: 'AARRRRRRR', links: 'none' }),
    makeRow({ row: 6, prefix: 'F', statuses: 'RRRRRRRRR', links: 'none' }),
  ].map((row, i) => row.map((s) => ({ ...s, y: i * 30 })));

  const { runs } = findAdjacentRuns(mapOf(...rows), 2);
  const best = runs[0];
  assert.equal(best.row, 'E', `expected the back-side pair to win, got row ${best.row}`);

  const frontCentred = runs.find((r) => r.seats.join() === 'A5,A6');
  assert.ok(frontCentred, 'the front-centre pair should still be listed');
  assert.ok(
    best.score > frontCentred.score,
    `back-side ${best.score} must beat front-centre ${frontCentred.score}`,
  );
  assert.ok(frontCentred.score < 25, `front row should score poorly, got ${frontCentred.score}`);
});

test('far-side seats score poorly even well back', () => {
  const rows = [1, 2, 3, 4, 5].map((r) =>
    makeRow({
      row: r,
      prefix: String.fromCharCode(64 + r),
      statuses: 'AAAAAAAAA',
      links: 'none',
    }).map((s) => ({ ...s, y: (r - 1) * 30 })),
  );
  const { runs } = findAdjacentRuns(mapOf(...rows), 2);

  const backCentre = runs[0];
  const backSide = runs.find((r) => r.rowIndex === 4 && r.seats.includes('D1'));
  assert.ok(backCentre.score > 70, `back centre should score high, got ${backCentre.score}`);
  assert.ok(backSide.score < 40, `far-side should score poorly, got ${backSide.score}`);
});

test('normalised positions put the front row at ny=0 and the back at ny=1', () => {
  const rows = [1, 2, 3].map((r) =>
    makeRow({ row: r, prefix: String.fromCharCode(64 + r), statuses: 'AA', links: 'none' }).map(
      (s) => ({ ...s, y: (r - 1) * 30 }),
    ),
  );
  const pos = normalisePositions(mapOf(...rows));
  assert.equal(pos.get('A1').ny, 0);
  assert.equal(pos.get('C1').ny, 1);
  assert.equal(pos.get('A1').nx, 0);
  assert.equal(pos.get('A2').nx, 1);
});

/* ---------------- stacked seating areas ---------------- */

/**
 * A room shaped like Regal LA Live: a Reserved floor, then a physical gap,
 * then a Balcony sitting well behind it in map coordinates.
 */
function twoAreaHouse() {
  const rows = [];
  for (let r = 1; r <= 6; r++) {
    rows.push(
      makeRow({ row: r, prefix: `F${r}`, statuses: 'AAAAA', links: 'none' }).map((s) => ({
        ...s,
        y: (r - 1) * 30,
        areaCode: 'reserved1',
      })),
    );
  }
  for (let r = 1; r <= 6; r++) {
    rows.push(
      makeRow({ row: 10 + r, prefix: `B${r}`, statuses: 'AAAAA', links: 'none' }).map((s) => ({
        ...s,
        y: 800 + (r - 1) * 30,
        areaCode: 'reserved2',
      })),
    );
  }
  return {
    seats: rows.flat(),
    areas: [
      { code: 'reserved1', id: '1', name: 'Reserved' },
      { code: 'reserved2', id: '2', name: 'Balcony' },
    ],
  };
}

test('REGRESSION: depth is judged within a seating area, not across the room', () => {
  // Measured across the whole room the balcony swallows the ideal depth, and
  // no orchestra seat can compete however well placed it is.
  const map = twoAreaHouse();
  const pos = normalisePositions(map);

  const orchestraBack = pos.get('F5C1' in {} ? '' : 'F51'); // row 5 of the floor
  assert.ok(orchestraBack.areaNy > 0.7, 'a back-of-orchestra seat is deep within its own area');
  assert.ok(orchestraBack.ny < 0.5, 'even though it sits in the front half of the room');

  const balconyFront = pos.get('B11');
  assert.equal(balconyFront.areaNy, 0, 'the first balcony row is the front of the balcony');
  assert.ok(balconyFront.ny > 0.5, 'despite being past halfway across the room');
});

test('neither seating area is structurally advantaged over the other', () => {
  // Both areas here have identical geometry, so the best seat in each must
  // score the same. Measuring depth across the whole room instead capped the
  // orchestra at 72% of the depth score while the balcony reached 99%, which
  // made every recommendation a balcony seat regardless of placement.
  const { runs } = findAdjacentRuns(twoAreaHouse(), 2);
  const scores = (code) => runs.filter((r) => r.areaCode === code).map((r) => r.score);

  const bestOrchestra = Math.max(...scores('reserved1'));
  const bestBalcony = Math.max(...scores('reserved2'));
  assert.equal(
    bestOrchestra,
    bestBalcony,
    `identical geometry must score identically: orchestra ${bestOrchestra}, balcony ${bestBalcony}`,
  );

  const worstBalcony = Math.min(...scores('reserved2'));
  assert.ok(
    bestOrchestra > worstBalcony,
    `a good orchestra seat ${bestOrchestra} must beat a bad balcony seat ${worstBalcony}`,
  );
});

test('runs report the seating area you must choose at checkout', () => {
  const { runs } = findAdjacentRuns(twoAreaHouse(), 2);
  assert.ok(runs.every((r) => r.area === 'Reserved' || r.area === 'Balcony'));
  assert.ok(runs.some((r) => r.area === 'Reserved'));
  assert.ok(runs.some((r) => r.area === 'Balcony'));
});

test('a single-area room is unaffected by the per-area rule', () => {
  const rows = [1, 2, 3, 4, 5].map((r) =>
    makeRow({ row: r, prefix: String.fromCharCode(64 + r), statuses: 'AAAAA', links: 'none' }).map(
      (s) => ({ ...s, y: (r - 1) * 30 }),
    ),
  );
  const pos = normalisePositions(mapOf(...rows));
  for (const p of pos.values()) assert.equal(p.areaNy, p.ny);
});

/* ---------------- preferred area ---------------- */

test('a preferred area excludes pairs outside it', () => {
  const rows = [1, 2, 3, 4].map((r) =>
    makeRow({ row: r, prefix: String.fromCharCode(64 + r), statuses: 'AAAA', links: 'none' }).map(
      (s) => ({ ...s, y: (r - 1) * 30 }),
    ),
  );
  const map = mapOf(...rows);

  const all = findAdjacentRuns(map, 2);
  // Back half only.
  const back = findAdjacentRuns(map, 2, { zone: { x0: 0, x1: 1, y0: 0.5, y1: 1 } });

  assert.ok(back.runs.length > 0, 'the back half must still yield pairs');
  assert.ok(back.runs.length < all.runs.length, 'the zone must actually exclude something');
  assert.ok(
    back.runs.every((r) => r.rowIndex >= 3),
    `every pair must be in the back half, got rows ${back.runs.map((r) => r.rowIndex)}`,
  );
  assert.ok(back.zoneRejected > 0);
});

test('an impossible preferred area yields nothing rather than falling back', () => {
  const map = mapOf(makeRow({ statuses: 'AAAA', links: 'none' }));
  const res = findAdjacentRuns(map, 2, { zone: { x0: 0.99, x1: 1, y0: 0.99, y1: 1 } });
  assert.equal(res.runs.length, 0);
  assert.ok(res.zoneRejected > 0, 'rejections must be reported so the UI can explain the gap');
});

test('a pair straddling the zone edge is rejected', () => {
  // Only the leftmost seat is inside the zone; the pair must not qualify.
  const map = mapOf(makeRow({ statuses: 'AAAA', links: 'none' }));
  const res = findAdjacentRuns(map, 2, { zone: { x0: 0, x1: 0.1, y0: 0, y1: 1 } });
  assert.equal(res.runs.length, 0);
});

test('counts and ranking are sane', () => {
  const map = mapOf(makeRow({ statuses: 'AAAAA', links: 'none' }));
  const result = findAdjacentRuns(map, 2);
  assert.equal(result.totalSeats, 5);
  assert.equal(result.availableSeats, 5);
  assert.equal(result.runs.length, 4, 'a block of 5 offers 4 pairs');
  // Best-ranked pair must be one of the two equally-central pairs, never an edge pair.
  const best = result.runs[0].seats.join('+');
  assert.ok(['A2+A3', 'A3+A4'].includes(best), `expected a central pair, got ${best}`);
  assert.ok(!['A1+A2', 'A4+A5'].includes(best));
});
