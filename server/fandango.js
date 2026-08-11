/**
 * Fandango data client.
 *
 * Two undocumented JSON endpoints power everything:
 *   GET /napi/theaterswithshowtimes  -> theaters near a zip, with movies, formats and showtimes
 *   GET /napi/seatMap/<hash>         -> the live seat map for one showtime
 *
 * Both sit behind bot protection: a bare request is answered with 403, a request
 * carrying a full set of browser headers is answered with 200. That is the only
 * reason BROWSER_HEADERS exists.
 */

const ORIGIN = 'https://www.fandango.com';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="148", "Not/A)Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
};

class HttpError extends Error {
  constructor(status, url) {
    super(`Fandango responded ${status} for ${url}`);
    this.status = status;
  }
}

async function getJson(url, referer, { retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { ...BROWSER_HEADERS, Referer: referer },
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 429 || res.status >= 500) throw new HttpError(res.status, url);
      if (!res.ok) throw new HttpError(res.status, url);
      return await res.json();
    } catch (err) {
      lastErr = err;
      // Only 429/5xx/network faults are worth retrying; a 403 will not fix itself.
      if (err instanceof HttpError && err.status !== 429 && err.status < 500) throw err;
      if (attempt < retries) await sleep(400 * 2 ** attempt);
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Every theater near `zip` showing something on `date` (YYYY-MM-DD).
 * Pages until the results run past `maxDistance` or the pages run out, so the
 * distance slider actually widens the search instead of just filtering page 1.
 */
export async function fetchTheatersWithShowtimes(zip, date, { maxDistance = 25, maxPages = 6 } = {}) {
  const referer = `${ORIGIN}/${zip}_movietimes`;
  const theaters = [];

  for (let page = 1; page <= maxPages; page++) {
    const url =
      `${ORIGIN}/napi/theaterswithshowtimes?zipCode=${encodeURIComponent(zip)}` +
      `&city=&state=&date=${date}&page=${page}&favTheaterOnly=false&limit=50` +
      `&isdesktop=true&filter=open-theaters&filterEnabled=true` +
      `&expandedSearch%5BuseExpanded%5D=false&expandedSearch%5BsetExpanded%5D=`;

    const data = await getJson(url, referer);
    const batch = data?.theaters ?? [];
    if (batch.length === 0) break;

    theaters.push(...batch);

    // Results arrive sorted by distance, so once a page ends past the radius
    // every later page is too far as well.
    const farthest = batch[batch.length - 1]?.distance ?? Infinity;
    if (farthest > maxDistance) break;
  }

  return theaters;
}

/** The live seat map for a single showtime, keyed by its showtimeHashCode. */
export async function fetchSeatMap(showtimeHashCode) {
  const url = `${ORIGIN}/napi/seatMap/${encodeURIComponent(showtimeHashCode)}`;
  return getJson(url, `${ORIGIN}/`, { retries: 1 });
}

/**
 * Format presets, matched against the amenity names Fandango attaches to a
 * showtime group (e.g. "IMAX® 70MM Film", "70MM Film", "IMAX with Laser").
 */
export const FORMAT_PRESETS = {
  'imax-70mm': { label: 'IMAX 70mm', test: (s) => /imax/i.test(s) && /70\s*mm/i.test(s) },
  '70mm': { label: 'Any 70mm', test: (s) => /70\s*mm/i.test(s) },
  imax: { label: 'Any IMAX', test: (s) => /imax/i.test(s) },
  any: { label: 'Any format', test: () => true },
};

/**
 * Flatten the deeply nested theater -> movie -> variant -> amenityGroup -> showtime
 * response into one row per showtime, keeping only what the UI and seat lookup need.
 */
export function extractShowtimes(theaters, { titleMatch, formatKey, maxDistance }) {
  const preset = FORMAT_PRESETS[formatKey] ?? FORMAT_PRESETS.any;
  const titleRe = titleMatch ? new RegExp(escapeRegex(titleMatch), 'i') : null;
  const rows = [];

  for (const theater of theaters) {
    if (typeof theater.distance === 'number' && theater.distance > maxDistance) continue;

    for (const movie of theater.movies ?? []) {
      if (titleRe && !titleRe.test(movie.title ?? '')) continue;

      for (const variant of movie.variants ?? []) {
        for (const group of variant.amenityGroups ?? []) {
          const amenities = (group.amenities ?? []).map((a) => a.name).filter(Boolean);
          const amenityString = amenities.join(', ');
          if (!preset.test(amenityString)) continue;

          for (const showtime of group.showtimes ?? []) {
            if (showtime.expired) continue;
            if (!showtime.showtimeHashCode) continue;

            rows.push({
              key: showtime.showtimeHashCode,
              movieId: movie.id,
              movieTitle: movie.title,
              runtime: movie.runtime,
              rating: movie.rating,
              poster: movie.poster?.size?.['200'] ?? null,
              theaterName: theater.name,
              theaterId: theater.id,
              chain: theater.chainName,
              address: theater.fullAddress,
              distance: theater.distance,
              format: variant.filmFormatHeader,
              amenities,
              amenityString,
              time: showtime.date,
              startsAt: parseTicketingDate(showtime.ticketingDate),
              ticketUrl: showtime.ticketingJumpPageURL,
            });
          }
        }
      }
    }
  }

  return rows;
}

/** "2026-08-11+19:00" -> { date: "2026-08-11", minutes: 1140 } */
function parseTicketingDate(value) {
  if (typeof value !== 'string') return null;
  const [date, time] = value.split('+');
  if (!date || !time) return null;
  const [h, m] = time.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return { date, minutes: h * 60 + m, iso: `${date}T${time}` };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
