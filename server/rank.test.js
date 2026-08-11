/**
 * Regression tests for the recommendation ranking.
 *
 * The bug these exist for: the overall score used to be a weighted *sum* of
 * seat quality and convenience. A showing whose only open pair was front-row
 * (seat quality 6/100) still banked ~32 points for being close, at the right
 * time and tomorrow — enough to be recommended #2. Since the whole point is
 * finding good seats, convenience must only order comparable options.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { rankShowtimes } from './index.js';

const DATES = ['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'];

const CONFIG = { startTime: 17 * 60, endTime: 21 * 60, distance: 25, priority: 65 };

/** A showing with the given best-seat score, distance, start time and date. */
function showing({ name, seatScore, distance, minutes = 19 * 60, date = DATES[0] }) {
  return {
    key: name,
    theaterName: name,
    distance,
    startsAt: { date, minutes, iso: `${date}T19:00` },
    seats: { bestScore: seatScore, optionCount: 1 },
  };
}

const rank = (list) => {
  rankShowtimes(list, CONFIG, DATES);
  return [...list].sort((a, b) => b.hot.score - a.hot.score).map((s) => s.key);
};

test('REGRESSION: perfect convenience cannot rescue front-row seats', () => {
  // "Universal" is the real case: 4.8mi, 7:00pm exactly, tomorrow, but its
  // only pair is row A. "Regal" is further, later in the week, but well back.
  const universal = showing({ name: 'universal', seatScore: 6, distance: 4.8 });
  const regal = showing({ name: 'regal', seatScore: 55, distance: 13.1, date: DATES[3] });

  assert.deepEqual(rank([universal, regal]), ['regal', 'universal']);
  assert.ok(
    regal.hot.score > universal.hot.score * 2,
    `good seats should win clearly: regal ${regal.hot.score} vs universal ${universal.hot.score}`,
  );
});

test('a front-row showing scores badly however convenient it is', () => {
  const best = showing({ name: 'ideal', seatScore: 6, distance: 0, minutes: 19 * 60 });
  rankShowtimes([best], CONFIG, DATES);
  assert.ok(best.hot.score <= 6, `front-row must stay low, got ${best.hot.score}`);
  assert.equal(best.hot.convenience, 100, 'this showing really is maximally convenient');
});

test('convenience still orders showings with equally good seats', () => {
  const near = showing({ name: 'near', seatScore: 70, distance: 2 });
  const far = showing({ name: 'far', seatScore: 70, distance: 24 });
  assert.deepEqual(rank([near, far]), ['near', 'far']);

  const soon = showing({ name: 'soon', seatScore: 70, distance: 10, date: DATES[0] });
  const later = showing({ name: 'later', seatScore: 70, distance: 10, date: DATES[3] });
  assert.deepEqual(rank([soon, later]), ['soon', 'later']);

  const onTime = showing({ name: 'onTime', seatScore: 70, distance: 10, minutes: 19 * 60 });
  const edge = showing({ name: 'edge', seatScore: 70, distance: 10, minutes: 21 * 60 });
  assert.deepEqual(rank([onTime, edge]), ['onTime', 'edge']);
});

test('a slightly better seat beats a much more convenient one', () => {
  const meh = showing({ name: 'meh', seatScore: 26, distance: 1, date: DATES[0] });
  const good = showing({ name: 'good', seatScore: 55, distance: 24, date: DATES[3] });
  assert.deepEqual(rank([meh, good]), ['good', 'meh']);
});

test('REGRESSION: a missing priority does not produce NaN scores', () => {
  const s = showing({ name: 'x', seatScore: 50, distance: 5 });
  rankShowtimes([s], { startTime: 17 * 60, endTime: 21 * 60, distance: 25 }, DATES);
  assert.ok(Number.isFinite(s.hot.score), `score must be a number, got ${s.hot.score}`);
  assert.ok(s.hot.score > 0);
});

test('the priority slider trades seat quality against going sooner', () => {
  const make = () => [
    showing({ name: 'soonerOkSeats', seatScore: 45, distance: 5, date: DATES[0] }),
    showing({ name: 'laterGreatSeats', seatScore: 62, distance: 20, date: DATES[3] }),
  ];

  const rankAt = (priority) => {
    const list = make();
    rankShowtimes(list, { ...CONFIG, priority }, DATES);
    return [...list].sort((a, b) => b.hot.score - a.hot.score).map((s) => s.key);
  };

  assert.equal(rankAt(0)[0], 'soonerOkSeats', 'at "go sooner" the nearer date should win');
  assert.equal(rankAt(100)[0], 'laterGreatSeats', 'at "best seats" the better seats should win');
});

test('convenience never swings a score by more than its floor allows', () => {
  const worst = showing({ name: 'worst', seatScore: 80, distance: 25, date: DATES[3], minutes: 21 * 60 });
  const bestCase = showing({ name: 'best', seatScore: 80, distance: 0, date: DATES[0] });
  rankShowtimes([worst, bestCase], CONFIG, DATES);
  assert.ok(worst.hot.score >= 0.55 * 80, 'the floor guarantees most of the seat credit');
  assert.ok(bestCase.hot.score <= 80, 'and seat quality is the ceiling');
});
