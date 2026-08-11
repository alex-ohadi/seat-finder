export const FORMATS = [
  { key: 'imax-70mm', label: 'IMAX 70mm' },
  { key: '70mm', label: 'Any 70mm' },
  { key: 'imax', label: 'Any IMAX' },
  { key: 'any', label: 'Any format' },
];

/**
 * Today in the local timezone. toISOString() answers in UTC, which rolls over
 * to tomorrow during a Pacific evening and silently skips tonight's showings.
 */
export function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const DEFAULT_CONFIG = {
  title: 'Odyssey',
  zip: '91401',
  distance: 25,
  startDate: localToday(),
  days: 7,
  startTime: 17 * 60, // 5:00 PM
  endTime: 21 * 60, // 9:00 PM
  partySize: 2,
  /** 0 = prefer sooner & closer, 100 = hold out for the best seats. */
  priority: 65,
  format: 'imax-70mm',
  includeAccessible: false,
  /** Restrict to one theater; '' means all of them. */
  theaterId: '',
  /** Preferred area in normalised 0..1 coords, or null for "anywhere". */
  zone: null,
};

export async function search(config, signal) {
  const { zone, ...rest } = config;
  const params = new URLSearchParams(Object.entries(rest).map(([k, v]) => [k, String(v)]));
  if (zone) {
    params.set('zoneX0', zone.x0);
    params.set('zoneY0', zone.y0);
    params.set('zoneX1', zone.x1);
    params.set('zoneY1', zone.y1);
  }
  const res = await fetch(`/api/search?${params}`, { signal });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Search failed (${res.status})`);
  return body;
}

/** Every showtime at one theater across the date range, chronological. */
export async function fetchTimeline(config, theaterId, signal) {
  const { zone, ...rest } = config;
  const params = new URLSearchParams(Object.entries(rest).map(([k, v]) => [k, String(v)]));
  params.set('theaterId', theaterId);
  const res = await fetch(`/api/timeline?${params}`, { signal });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Timeline failed (${res.status})`);
  return body;
}

/** One showtime's seat map and its adjacency analysis, in a single request. */
export async function fetchShowtime(hash, config, signal) {
  const params = new URLSearchParams({
    partySize: String(config.partySize),
    includeAccessible: String(config.includeAccessible),
  });
  if (config.zone) {
    params.set('zoneX0', config.zone.x0);
    params.set('zoneY0', config.zone.y0);
    params.set('zoneX1', config.zone.x1);
    params.set('zoneY1', config.zone.y1);
  }
  const res = await fetch(`/api/showtime/${encodeURIComponent(hash)}?${params}`, { signal });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Showtime failed (${res.status})`);
  return body;
}

export async function fetchSeatMap(hash, signal) {
  const res = await fetch(`/api/seatmap/${encodeURIComponent(hash)}`, { signal });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Seat map failed (${res.status})`);
  return body;
}

/** 1140 -> "7:00 PM" */
export function formatMinutes(mins) {
  const h24 = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

/** 1140 -> "19:00" for <input type="time"> */
export function toTimeInput(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

export function fromTimeInput(value) {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

/** Plain-English name for a preferred area, e.g. "back centre". */
export function describeZone(zone) {
  if (!zone) return 'anywhere in the room';
  const midY = (zone.y0 + zone.y1) / 2;
  const midX = (zone.x0 + zone.x1) / 2;
  const depth = midY > 0.66 ? 'back' : midY < 0.33 ? 'front' : 'middle';
  const side = midX > 0.6 ? 'right' : midX < 0.4 ? 'left' : 'centre';
  return `${depth} ${side}`;
}

export function formatDateHeading(isoDate) {
  const d = new Date(`${isoDate}T12:00:00`);
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}
