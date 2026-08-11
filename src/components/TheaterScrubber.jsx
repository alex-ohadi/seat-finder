import { useEffect, useRef, useState } from 'react';
import SeatMap from './SeatMap.jsx';
import { fetchSeatMap, formatDateHeading } from '../api.js';

const WHY_LABELS = {
  seats: 'Seat quality',
  distance: 'Nearby',
  time: 'Your time',
  soon: 'How soon',
};

/**
 * One theater, with a knob to scrub through its showings.
 *
 * The showings come from the search that already ran, so they carry their seat
 * analysis with them — only the seat map itself is fetched, and only for the
 * step being looked at. Maps are cached per hash and the neighbouring steps are
 * warmed, so dragging stays continuous.
 *
 * Collapsed panels fetch nothing at all, which is what keeps a page full of
 * theaters cheap.
 */
export default function TheaterScrubber({
  theater,
  partySize,
  rank = null,
  defaultOpen = false,
  onShiftWeek = null,
  canGoEarlier = false,
  windowDays = 7,
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [index, setIndex] = useState(theater.bestIndex ?? 0);
  const [map, setMap] = useState(null);
  const [mapError, setMapError] = useState(null);
  const cache = useRef(new Map());

  const showtimes = theater.showtimes;
  const current = showtimes[index] ?? showtimes[0];
  const seats = current?.seats;
  const best = seats?.options?.[0];

  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, showtimes.length - 1)));
  }, [showtimes.length]);

  useEffect(() => {
    if (!open || !current) return;
    let cancelled = false;

    const load = async (hash) => {
      if (!hash) return null;
      if (cache.current.has(hash)) return cache.current.get(hash);
      const data = await fetchSeatMap(hash);
      cache.current.set(hash, data);
      return data;
    };

    const cached = cache.current.get(current.key);
    if (cached) setMap(cached);
    setMapError(null);

    load(current.key)
      .then((data) => {
        if (!cancelled && data) setMap(data);
        load(showtimes[index + 1]?.key).catch(() => {});
        load(showtimes[index - 1]?.key).catch(() => {});
      })
      .catch((err) => {
        if (!cancelled) setMapError(err.message);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current?.key]);

  if (!current) return null;

  const pctOpen = seats ? Math.round((seats.available / seats.total) * 100) : null;
  const dayStarts = [];
  showtimes.forEach((s, i) => {
    if (i === 0 || s.startsAt?.date !== showtimes[i - 1].startsAt?.date)
      dayStarts.push({ i, date: s.startsAt?.date });
  });

  return (
    <article className={`ts ${rank ? 'ts--rec' : ''} ${open ? '' : 'ts--closed'}`}>
      <header className="ts__head" onClick={() => setOpen(!open)}>
        <span className="ts__toggle" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="ts__ident">
          <h3 className="ts__name">
            {rank && <span className="ts__rank">#{rank}</span>}
            {theater.name}
            <span className="ts__dist">{theater.distance?.toFixed(1)} mi</span>
          </h3>
          <span className="ts__summary">
            {theater.bestScore > 0 ? (
              <>
                best seats <strong>{theater.bestSeats?.join(', ')}</strong> (quality{' '}
                {theater.bestScore}) · {showtimes.length} showing
                {showtimes.length === 1 ? '' : 's'} in your window
              </>
            ) : (
              <>
                no {partySize} together at any of its {showtimes.length} showing
                {showtimes.length === 1 ? '' : 's'}
              </>
            )}
          </span>
        </span>
        <span className={`ts__badge ${badgeClass(theater.bestScore)}`}>{theater.bestScore}</span>
      </header>

      {open && (
        <div className="ts__body">
          <div className="tl__now">
            <span className="tl__when">
              <strong>{current.time}</strong>
              <em>{formatDateHeading(current.startsAt?.date)}</em>
            </span>
            {seats ? (
              <span className="tl__stats">
                <Stat label="Open" value={`${seats.available}/${seats.total}`} />
                <Stat label="Filled" value={`${100 - pctOpen}%`} />
                <Stat label={`Ways to sit ${partySize}`} value={seats.optionCount} />
                <Stat
                  label="Best here"
                  value={best ? `${best.seats.join(', ')} (${best.score})` : 'none'}
                  wide
                />
              </span>
            ) : (
              <span className="tl__stats tl__stats--muted">
                {current.seatError ? `Seat map failed: ${current.seatError}` : 'No seat data'}
              </span>
            )}
          </div>

          {showtimes.length > 1 ? (
            <div className="tl__slider">
              <input
                type="range"
                min="0"
                max={showtimes.length - 1}
                step="1"
                value={index}
                onChange={(e) => setIndex(Number(e.target.value))}
                aria-label={`Scrub through showtimes at ${theater.name}`}
              />
              <div className="tl__ticks">
                {showtimes.map((s, i) => (
                  <span
                    key={s.key}
                    className={`tl__tick ${i === index ? 'is-current' : ''} ${
                      (s.seats?.optionCount ?? 0) > 0 ? 'is-inwindow' : ''
                    }`}
                    style={{ left: `${(i / Math.max(1, showtimes.length - 1)) * 100}%` }}
                    title={`${s.startsAt?.date} ${s.time}`}
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
          ) : (
            <p className="ts__single">Only one showing here in your window.</p>
          )}

          {/* The slider moves within the loaded range; these page to the next
              one, since scrubbing to the end used to be a dead stop. */}
          <div className="tl__nav">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => onShiftWeek?.(-1)}
              disabled={!onShiftWeek || !canGoEarlier}
              title={
                canGoEarlier
                  ? `Load the previous ${windowDays} days`
                  : 'Already showing from today'
              }
            >
              ← Earlier
            </button>
            {theater.bestIndex != null && theater.bestIndex !== index && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setIndex(theater.bestIndex)}
              >
                Jump to best
              </button>
            )}
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
              onClick={() => onShiftWeek?.(1)}
              disabled={!onShiftWeek}
              title={`Load the next ${windowDays} days`}
            >
              Later →
            </button>
          </div>

          {best && (
            <p className="card__ask">
              Ask for / select <strong>{best.seats.join(' and ')}</strong> — row {best.row},{' '}
              {current.time} on {formatDateHeading(current.startsAt?.date)}
            </p>
          )}
          {seats?.accessibleAlternative && (
            <p className="card__note">
              Better seats exist in row {seats.accessibleAlternative.row} (
              {seats.accessibleAlternative.seats.join(', ')}, quality{' '}
              {seats.accessibleAlternative.score}) but they are wheelchair or companion spaces.
            </p>
          )}

          {mapError ? (
            <div className="seatmap seatmap--msg seatmap--error">{mapError}</div>
          ) : (
            <SeatMap map={map} hash={map ? undefined : current.key} highlight={best?.seats ?? []} bare />
          )}

          {rank && current.hot && (
            <div className="why">
              {Object.entries(WHY_LABELS).map(([key, label]) => (
                <div className="why__item" key={key}>
                  <span className="why__label">{label}</span>
                  <span className="why__track">
                    <span
                      className={`why__fill ${
                        current.hot.factors[key] < 34
                          ? 'is-low'
                          : current.hot.factors[key] < 67
                            ? 'is-mid'
                            : 'is-high'
                      }`}
                      style={{ width: `${current.hot.factors[key]}%` }}
                    />
                  </span>
                  <span className="why__val">{current.hot.factors[key]}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function badgeClass(score) {
  if (score >= 60) return 'is-good';
  if (score >= 25) return 'is-ok';
  return 'is-poor';
}

function Stat({ label, value, wide }) {
  return (
    <span className={`tl__stat ${wide ? 'tl__stat--wide' : ''}`}>
      <em>{label}</em>
      <b>{value}</b>
    </span>
  );
}
