import { useEffect, useRef, useState } from 'react';
import SeatMap from './SeatMap.jsx';
import { fetchTimeline, fetchShowtime, formatDateHeading } from '../api.js';

/**
 * Scrub through one theater's showtimes across the searched days and watch the
 * room fill up.
 *
 * Seat maps are fetched per step and kept in a local cache, so dragging back
 * and forth over ground you have already covered is instant. The step either
 * side of the current one is prefetched, which is what makes a slow drag feel
 * continuous rather than a series of loading flashes.
 */
export default function Timeline({ config, theaterId, onClose }) {
  const [list, setList] = useState({ status: 'loading' });
  const [index, setIndex] = useState(0);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const cache = useRef(new Map());

  // Config values that change what a seat map means, so the cache must drop.
  const detailKey = `${config.partySize}|${config.includeAccessible}|${JSON.stringify(config.zone)}`;

  useEffect(() => {
    const controller = new AbortController();
    setList({ status: 'loading' });
    setIndex(0);
    setDetail(null);
    cache.current = new Map();

    fetchTimeline(config, theaterId, controller.signal)
      .then((data) => {
        setList({ status: 'ready', ...data });
        // Open on the first showing inside the chosen time window, since that
        // is the one the rest of the page is about.
        const firstInWindow = data.showtimes.findIndex((s) => s.inWindow);
        setIndex(firstInWindow >= 0 ? firstInWindow : 0);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setList({ status: 'error', error: err.message });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theaterId, config.startDate, config.days, config.zip, config.distance, config.format, config.title]);

  useEffect(() => {
    cache.current = new Map();
    setDetail(null);
  }, [detailKey]);

  const showtimes = list.status === 'ready' ? list.showtimes : [];
  const current = showtimes[index] ?? null;

  useEffect(() => {
    if (!current) return;
    let cancelled = false;

    const load = async (hash) => {
      if (!hash || cache.current.has(hash)) return cache.current.get(hash);
      const data = await fetchShowtime(hash, config);
      cache.current.set(hash, data);
      return data;
    };

    setDetailError(null);
    const cached = cache.current.get(current.key);
    if (cached) setDetail(cached);

    load(current.key)
      .then((data) => {
        if (!cancelled && data) setDetail(data);
        // Warm the neighbours so a continued drag stays smooth.
        load(showtimes[index + 1]?.key).catch(() => {});
        load(showtimes[index - 1]?.key).catch(() => {});
      })
      .catch((err) => {
        if (!cancelled) setDetailError(err.message);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.key, detailKey]);

  if (list.status === 'loading')
    return <div className="tl tl--msg">Loading this theater’s showtimes…</div>;
  if (list.status === 'error')
    return <div className="tl tl--msg tl--error">{list.error}</div>;
  if (showtimes.length === 0)
    return (
      <div className="tl tl--msg">
        No showings of this movie at that theater in the selected days.
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
          Close
        </button>
      </div>
    );

  const analysis = detail?.analysis;
  const best = analysis?.options?.[0];
  const pctOpen = analysis ? Math.round((analysis.available / analysis.total) * 100) : null;

  // Day boundaries, for the ticks under the slider.
  const dayStarts = [];
  showtimes.forEach((s, i) => {
    if (i === 0 || s.date !== showtimes[i - 1].date) dayStarts.push({ i, date: s.date });
  });

  return (
    <section className="tl">
      <header className="tl__head">
        <div>
          <h2 className="tl__title">{list.theater?.name}</h2>
          <p className="tl__sub">
            {showtimes.length} showings over {dayStarts.length} day
            {dayStarts.length === 1 ? '' : 's'} · drag to watch the room fill up
          </p>
        </div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="tl__now">
        <span className="tl__when">
          <strong>{current.time}</strong>
          <em>{formatDateHeading(current.date)}</em>
        </span>
        {analysis ? (
          <span className="tl__stats">
            <Stat label="Open" value={`${analysis.available}/${analysis.total}`} />
            <Stat label="Filled" value={`${100 - pctOpen}%`} />
            <Stat label={`Ways to sit ${config.partySize}`} value={analysis.optionCount} />
            <Stat
              label="Best seats"
              value={best ? `${best.seats.join(', ')} (${best.score})` : 'none'}
              wide
            />
          </span>
        ) : (
          <span className="tl__stats tl__stats--muted">
            {detailError ? `Seat map failed: ${detailError}` : 'Loading seats…'}
          </span>
        )}
      </div>

      <div className="tl__slider">
        <input
          type="range"
          min="0"
          max={showtimes.length - 1}
          step="1"
          value={index}
          onChange={(e) => setIndex(Number(e.target.value))}
          aria-label="Scrub through showtimes"
        />
        <div className="tl__ticks">
          {showtimes.map((s, i) => (
            <span
              key={s.key}
              className={`tl__tick ${i === index ? 'is-current' : ''} ${s.inWindow ? 'is-inwindow' : ''}`}
              style={{ left: `${(i / Math.max(1, showtimes.length - 1)) * 100}%` }}
              title={`${s.date} ${s.time}`}
            />
          ))}
        </div>
        <div className="tl__days">
          {dayStarts.map(({ i, date }) => (
            <span
              key={date}
              className="tl__day"
              style={{ left: `${(i / Math.max(1, showtimes.length - 1)) * 100}%` }}
            >
              {new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
                weekday: 'short',
                day: 'numeric',
              })}
            </span>
          ))}
        </div>
      </div>

      <div className="tl__nav">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setIndex(Math.max(0, index - 1))}
          disabled={index === 0}
        >
          ← Earlier
        </button>
        <a
          className="btn btn--primary btn--sm"
          href={current.theaterUrl ?? current.ticketUrl}
          target="_blank"
          rel="noreferrer"
        >
          Tickets
        </a>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setIndex(Math.min(showtimes.length - 1, index + 1))}
          disabled={index === showtimes.length - 1}
        >
          Later →
        </button>
      </div>

      {detail && (
        <SeatMap map={detail.map} highlight={best?.seats ?? []} bare />
      )}
    </section>
  );
}

function Stat({ label, value, wide }) {
  return (
    <span className={`tl__stat ${wide ? 'tl__stat--wide' : ''}`}>
      <em>{label}</em>
      <b>{value}</b>
    </span>
  );
}
