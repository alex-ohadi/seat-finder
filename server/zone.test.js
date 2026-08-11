/**
 * Regression tests for parsing the preferred-area parameters.
 *
 * The bug these exist for: Number(null) is 0, not NaN, so absent zone
 * parameters built a zero-size zone at the origin. Every search still returned
 * showtimes, but every one of them reported "no seats together" — a silent
 * wrong answer rather than a visible failure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readZone } from './index.js';

const params = (obj) => new URLSearchParams(obj);

test('REGRESSION: no zone parameters means no zone', () => {
  assert.equal(readZone(params({})), null);
});

test('a partially specified zone is ignored rather than half-applied', () => {
  assert.equal(readZone(params({ zoneX0: '0.2', zoneY0: '0.5' })), null);
  assert.equal(readZone(params({ zoneX0: '0.2', zoneY0: '0.5', zoneX1: '0.8' })), null);
});

test('empty strings mean no zone', () => {
  assert.equal(readZone(params({ zoneX0: '', zoneY0: '', zoneX1: '', zoneY1: '' })), null);
});

test('junk values mean no zone', () => {
  assert.equal(
    readZone(params({ zoneX0: 'abc', zoneY0: '0.1', zoneX1: '0.9', zoneY1: '0.9' })),
    null,
  );
});

test('a full-house zone is treated as no preference', () => {
  assert.equal(readZone(params({ zoneX0: '0', zoneY0: '0', zoneX1: '1', zoneY1: '1' })), null);
});

test('a real zone is parsed', () => {
  assert.deepEqual(readZone(params({ zoneX0: '0.3', zoneY0: '0.6', zoneX1: '0.7', zoneY1: '0.95' })), {
    x0: 0.3,
    y0: 0.6,
    x1: 0.7,
    y1: 0.95,
  });
});

test('a box dragged right-to-left or bottom-to-top is normalised', () => {
  assert.deepEqual(readZone(params({ zoneX0: '0.7', zoneY0: '0.95', zoneX1: '0.3', zoneY1: '0.6' })), {
    x0: 0.3,
    y0: 0.6,
    x1: 0.7,
    y1: 0.95,
  });
});

test('out-of-range values are clamped', () => {
  assert.deepEqual(readZone(params({ zoneX0: '-3', zoneY0: '0.5', zoneX1: '9', zoneY1: '0.8' })), {
    x0: 0,
    y0: 0.5,
    x1: 1,
    y1: 0.8,
  });
});
