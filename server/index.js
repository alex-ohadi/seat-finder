/**
 * Scraper API for the seat finder.
 *
 * GET /api/search?zip=&distance=&startDate=&days=&startTime=&endTime=&partySize=&format=&title=
 *   -> { showtimes: [...], stats: {...} }
 *
 * GET /api/seatmap/:hash
 *   -> the raw seat map for one showtime (used by the seat-map preview)
 *
 * Node's built-in fetch does the work; there is no headless browser and no
 * third-party dependency.
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  fetchTheatersWithShowtimes,
  fetchSeatMap,
  extractShowtimes,
  FORMAT_PRESETS,
} from './fandango.js';
import { findAdjacentRuns } from './seats.js';

// Deliberately not PORT: the dev harness sets PORT for the web server, and the
// API stealing it pushes Vite onto a different port than the one being previewed.
const PORT = Number(process.env.API_PORT ?? 8787);

/** Seat maps move constantly; showtime lists barely move within a session. */
const seatCache = new TtlCache(60_000);
const showtimeCache = new TtlCache(5 * 60_000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return end(res, 204, '');

  try {
    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, formats: Object.keys(FORMAT_PRESETS) });
    }
    if (url.pathname === '/api/search') {
      return json(res, 200, await search(url.searchParams));
    }
    if (url.pathname === '/api/timeline') {
      return json(res, 200, await timeline(url.searchParams));
    }
    if (url.pathname.startsWith('/api/seatmap/')) {
      const hash = decodeURIComponent(url.pathname.slice('/api/seatmap/'.length));
      return json(res, 200, await cachedSeatMap(hash));
    }
    if (url.pathname.startsWith('/api/showtime/')) {
      const hash = decodeURIComponent(url.pathname.slice('/api/showtime/'.length));
      return json(res, 200, await showtimeDetail(hash, url.searchParams));
    }
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(`[api] ${url.pathname} failed:`, err.message);
    return json(res, 502, { error: err.message });
  }
});

/**
 * Every matching showtime across the date range, one request per day in
 * parallel. A failed day is reported rather than sinking the whole search.
 */
async function collectShowtimes(config, dates) {
  const dayErrors = [];
  const perDay = await Promise.all(
    dates.map(async (date) => {
      try {
        const cacheKey = `${config.zip}|${date}|${config.distance}`;
        const theaters = await showtimeCache.wrap(cacheKey, () =>
          fetchTheatersWithShowtimes(config.zip, date, { maxDistance: config.distance }),
        );
        return extractShowtimes(theaters, {
          titleMatch: config.title,
          formatKey: config.format,
          maxDistance: config.distance,
        });
      } catch (err) {
        dayErrors.push({ date, error: err.message });
        return [];
      }
    }),
  );
  return { all: perDay.flat(), dayErrors };
}

async function search(params) {
  const config = readConfig(params);
  const dates = dateRange(config.startDate, config.days);
  const { all: everything, dayErrors } = await collectShowtimes(config, dates);

  // The theater filter narrows the results; the theater list itself is built
  // from the unfiltered set so you can still switch to a different one.
  const theaters = theaterOptions(everything);
  const all = config.theaterId
    ? everything.filter((s) => s.theaterId === config.theaterId)
    : everything;

  const inWindow = all.filter((s) => withinWindow(s, config));

  // Seat maps are the expensive call, so only in-window showtimes get one.
  const analysed = await mapWithConcurrency(inWindow, 6, async (showtime) => {
    try {
      const seatMap = await cachedSeatMap(showtime.key);
      const analysis = findAdjacentRuns(seatMap, config.partySize, {
        includeAccessible: config.includeAccessible,
        zone: config.zone,
      });

      // Accessible spaces often sit in the best part of the room. When they are
      // filtered out, say so rather than leaving "why not the middle?" unanswered.
      let accessibleAlternative = null;
      if (!config.includeAccessible) {
        const withAccessible = findAdjacentRuns(seatMap, config.partySize, {
          includeAccessible: true,
          zone: config.zone,
        });
        const better = withAccessible.runs[0];
        if (better && better.score > (analysis.runs[0]?.score ?? 0) + 5) {
          accessibleAlternative = { seats: better.seats, row: better.row, score: better.score };
        }
      }
      return {
        ...showtime,
        auditorium: seatMap.auditoriumId ?? null,
        seats: {
          total: analysis.totalSeats,
          available: analysis.availableSeats,
          maxRun: analysis.maxRun,
          optionCount: analysis.runs.length,
          zoneRejected: analysis.zoneRejected,
          bestScore: analysis.runs[0]?.score ?? null,
          accessibleAlternative,
          // The full list can run to hundreds of windows; the UI only shows a few.
          options: analysis.runs.slice(0, 12),
        },
        seatError: null,
      };
    } catch (err) {
      return { ...showtime, auditorium: null, seats: null, seatError: err.message };
    }
  });

  rankShowtimes(analysed, config, dates);

  analysed.sort((a, b) => {
    const at = a.startsAt?.iso ?? '';
    const bt = b.startsAt?.iso ?? '';
    return at.localeCompare(bt) || a.distance - b.distance;
  });

  // Recommend at most three, and only seats actually worth sitting in. Filling
  // all three slots regardless would put a front-row pair under a "Recommended"
  // banner just because nothing better existed.
  const qualified = analysed
    .filter((s) => (s.seats?.optionCount ?? 0) > 0)
    .filter((s) => (s.seats?.bestScore ?? 0) >= MIN_RECOMMENDABLE_SEAT_SCORE)
    .sort((a, b) => b.hot.score - a.hot.score);

  const recommended = qualified.slice(0, 3).map((s) => s.key);

  return {
    config,
    recommended,
    theaters,
    generatedAt: new Date().toISOString(),
    stats: {
      datesSearched: dates.length,
      showtimesFound: all.length,
      showtimesInWindow: inWindow.length,
      withSeatsTogether: analysed.filter((s) => (s.seats?.optionCount ?? 0) > 0).length,
      withGoodSeats: qualified.length,
      minRecommendableSeatScore: MIN_RECOMMENDABLE_SEAT_SCORE,
      seatLookupFailures: analysed.filter((s) => s.seatError).length,
      dayErrors,
    },
    showtimes: analysed,
  };
}

/** Distinct theaters in a result set, nearest first, for the filter dropdown. */
function theaterOptions(showtimes) {
  const byId = new Map();
  for (const s of showtimes) {
    if (!s.theaterId) continue;
    const seen = byId.get(s.theaterId);
    if (seen) seen.showtimeCount++;
    else
      byId.set(s.theaterId, {
        id: s.theaterId,
        name: s.theaterName,
        distance: s.distance,
        showtimeCount: 1,
      });
  }
  return [...byId.values()].sort((a, b) => a.distance - b.distance);
}

/**
 * Every showtime at one theater across the date range, in chronological order.
 *
 * Deliberately ignores the time-of-day window: the point of the timeline is to
 * watch a room fill up across whole days, so clipping it to 5-9pm would leave
 * holes in the very thing you are scrubbing through.
 */
async function timeline(params) {
  const config = readConfig(params);
  const dates = dateRange(config.startDate, config.days);
  const { all, dayErrors } = await collectShowtimes(config, dates);

  const mine = all
    .filter((s) => s.theaterId === config.theaterId)
    .sort((a, b) => (a.startsAt?.iso ?? '').localeCompare(b.startsAt?.iso ?? ''));

  return {
    theater: mine[0]
      ? { id: mine[0].theaterId, name: mine[0].theaterName, distance: mine[0].distance }
      : null,
    dayErrors,
    showtimes: mine.map((s) => ({
      key: s.key,
      date: s.startsAt?.date ?? null,
      time: s.time,
      minutes: s.startsAt?.minutes ?? null,
      iso: s.startsAt?.iso ?? null,
      format: s.format,
      amenityString: s.amenityString,
      ticketUrl: s.ticketUrl,
      theaterUrl: s.theaterUrl,
      inWindow: withinWindow(s, config),
    })),
  };
}

/**
 * One showtime's seat map plus its adjacency analysis, in a single round trip
 * so scrubbing the timeline does not need two requests per step.
 */
async function showtimeDetail(hash, params) {
  const partySize = clamp(num(params.get('partySize'), 2), 1, 12);
  const includeAccessible = params.get('includeAccessible') === 'true';
  const zone = readZone(params);

  const map = await cachedSeatMap(hash);
  const analysis = findAdjacentRuns(map, partySize, { includeAccessible, zone });

  return {
    map,
    analysis: {
      total: analysis.totalSeats,
      available: analysis.availableSeats,
      maxRun: analysis.maxRun,
      optionCount: analysis.runs.length,
      zoneRejected: analysis.zoneRejected,
      bestScore: analysis.runs[0]?.score ?? null,
      options: analysis.runs.slice(0, 8),
    },
  };
}

function readConfig(p) {
  const format = p.get('format');
  return {
    zone: readZone(p),
    zip: (p.get('zip') || '91401').trim(),
    distance: clamp(num(p.get('distance'), 25), 1, 100),
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(p.get('startDate') ?? '')
      ? p.get('startDate')
      : localToday(),
    days: clamp(num(p.get('days'), 7), 1, 14),
    startTime: clamp(num(p.get('startTime'), 17 * 60), 0, 24 * 60),
    endTime: clamp(num(p.get('endTime'), 21 * 60), 0, 24 * 60),
    partySize: clamp(num(p.get('partySize'), 2), 1, 12),
    /** 0 = sooner & closer wins, 100 = best seats win. */
    priority: clamp(num(p.get('priority'), 65), 0, 100),
    /** Restrict results to one theater; empty means all of them. */
    theaterId: (p.get('theaterId') || '').trim() || null,
    format: format in FORMAT_PRESETS ? format : 'imax-70mm',
    title: (p.get('title') ?? 'Odyssey').trim(),
    includeAccessible: p.get('includeAccessible') === 'true',
  };
}

/**
 * How much each factor counts toward the recommendation score.
 * Seat quality leads; the rest break ties between comparable showings.
 */
/**
 * Convenience factors, blended against each other. Seat quality is deliberately
 * NOT in here — see rankShowtimes.
 */
const HOT_WEIGHTS = {
  distance: 0.45, // nearer the ZIP is better
  time: 0.3, // nearer the middle of the chosen window is better
  soon: 0.25, // sooner is better
};

/**
 * How much of a showing's seat credit survives a maximally inconvenient trip.
 * Derived from the user's priority slider: at "best seats" almost all of it
 * survives (so a great seat next week still wins), at "sooner & closer" much
 * less does (so a decent seat tomorrow wins instead). Never reaches 1.0, so
 * convenience always breaks ties, and never reaches 0, so it can never rescue
 * a bad seat on its own.
 */
const DEFAULT_PRIORITY = 65;

function convenienceFloor(priority) {
  // A missing priority must not turn every score into NaN.
  const p = Number.isFinite(priority) ? clamp(priority, 0, 100) : DEFAULT_PRIORITY;
  return 0.25 + 0.7 * (p / 100);
}

/**
 * Seat quality below which a showing is listed but never recommended. Around
 * this mark you are in the front section or hard against a side wall.
 */
const MIN_RECOMMENDABLE_SEAT_SCORE = 25;

/**
 * Score every showing 0-100 on "how good an option is this overall", and
 * record the breakdown so the UI can say *why* something is recommended.
 *
 * Seat quality MULTIPLIES the convenience blend rather than being averaged
 * with it. Averaging meant a showing whose best pair was front-row (6/100)
 * still banked ~32 points from being near, at the right time and tomorrow —
 * enough to land in the top three. Since the point of this tool is to find
 * good seats, convenience may only order comparable options; it can never
 * rescue a bad one.
 */
export function rankShowtimes(showtimes, config, dates) {
  const windowMid = (config.startTime + config.endTime) / 2;
  const windowHalf = Math.max(1, (config.endTime - config.startTime) / 2);
  const lastDayIndex = Math.max(1, dates.length - 1);

  for (const s of showtimes) {
    // Seat quality: the best group this showing can offer.
    const seats = s.seats?.bestScore ?? 0;

    // Distance: full marks at the door, zero at the edge of the search radius.
    const distance = 100 * (1 - Math.min(1, (s.distance ?? config.distance) / config.distance));

    // Time: full marks in the middle of the chosen window, tapering to its edges.
    const offset = Math.abs((s.startsAt?.minutes ?? windowMid) - windowMid);
    const time = 100 * (1 - Math.min(1, offset / windowHalf));

    // Sooner: full marks on the first day searched.
    const dayIndex = Math.max(0, dates.indexOf(s.startsAt?.date ?? dates[0]));
    const soon = 100 * (1 - dayIndex / lastDayIndex);

    const convenience =
      HOT_WEIGHTS.distance * distance + HOT_WEIGHTS.time * time + HOT_WEIGHTS.soon * soon;

    const floor = convenienceFloor(config.priority);
    const score = seats * (floor + (1 - floor) * (convenience / 100));

    s.hot = {
      score: Math.round(score),
      convenience: Math.round(convenience),
      factors: {
        seats: Math.round(seats),
        distance: Math.round(distance),
        time: Math.round(time),
        soon: Math.round(soon),
      },
    };
  }
}

/**
 * A preferred area, as normalised 0..1 coordinates. Missing or malformed
 * values mean "no preference" rather than an error.
 */
export function readZone(p) {
  const raw = ['zoneX0', 'zoneY0', 'zoneX1', 'zoneY1'].map((k) => p.get(k));
  // Number(null) is 0, not NaN, so a missing parameter would otherwise build a
  // zero-size zone at the origin and silently reject every seat in the house.
  if (raw.some((v) => v == null || v === '')) return null;

  const nums = raw.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [x0, y0, x1, y1] = nums.map((n) => clamp(n, 0, 1));
  const zone = { x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1) };
  // A zone covering everything is the same as no zone; skip the extra work.
  if (zone.x0 === 0 && zone.y0 === 0 && zone.x1 === 1 && zone.y1 === 1) return null;
  return zone;
}

/**
 * Today in the machine's own timezone. toISOString() would answer in UTC,
 * which rolls over to tomorrow during a Pacific evening and silently drops
 * tonight's showings.
 */
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function withinWindow(showtime, config) {
  if (!showtime.startsAt) return false;
  const { minutes } = showtime.startsAt;
  return minutes >= config.startTime && minutes <= config.endTime;
}

function dateRange(startDate, days) {
  const out = [];
  const start = new Date(`${startDate}T12:00:00Z`);
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function cachedSeatMap(hash) {
  return seatCache.wrap(hash, () => fetchSeatMap(hash));
}

/** Bounded parallelism so a wide search doesn't fire 100 requests at once. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** TTL cache that also de-duplicates concurrent misses for the same key. */
function TtlCache(ttlMs) {
  const store = new Map();
  this.wrap = async (key, produce) => {
    const hit = store.get(key);
    if (hit && hit.expires > Date.now()) return hit.promise;
    const promise = produce().catch((err) => {
      store.delete(key); // never cache a failure
      throw err;
    });
    store.set(key, { promise, expires: Date.now() + ttlMs });
    return promise;
  };
}

const num = (v, fallback) => (v == null || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function json(res, status, body) {
  end(res, status, JSON.stringify(body), 'application/json');
}
function end(res, status, body, type = 'text/plain') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

// Only listen when run directly, so tests can import the helpers above
// without starting a server (and colliding with a running one).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, () => {
    console.log(`[api] seat-finder API listening on http://localhost:${PORT}`);
  });
}
