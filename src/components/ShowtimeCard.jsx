import { useState } from 'react';
import SeatMap from './SeatMap.jsx';

export default function ShowtimeCard({ showtime, partySize, rank = null, showDate = false }) {
  const [open, setOpen] = useState(false);
  const [pickIndex, setPickIndex] = useState(0);

  const seats = showtime.seats;
  const options = seats?.options ?? [];
  const found = options.length > 0;
  const picked = options[pickIndex];

  return (
    <article className={`card ${found ? '' : 'card--empty'} ${rank ? 'card--rec' : ''}`}>
      {rank && (
        <div className="card__ribbon">
          <span className="card__rank">#{rank}</span>
          <span>{rank === 1 ? 'Best overall' : 'Recommended'}</span>
          <span className="card__hot">{showtime.hot?.score}</span>
        </div>
      )}
      <div className="card__main">
        <div className="card__time">
          <strong>{showtime.time}</strong>
          {showDate && <span className="card__date">{shortDate(showtime.startsAt?.date)}</span>}
          <span className="card__runtime">{showtime.runtime} min</span>
        </div>

        <div className="card__body">
          <h3 className="card__theater">
            {showtime.theaterName}
            <span className="card__distance">{showtime.distance?.toFixed(1)} mi</span>
          </h3>
          <p className="card__meta">
            {showtime.amenities.slice(0, 4).map((a) => (
              <span key={a} className="tag">
                {a}
              </span>
            ))}
            {showtime.auditorium != null && <span className="tag tag--muted">Aud {showtime.auditorium}</span>}
          </p>

          {showtime.seatError ? (
            <p className="card__status card__status--warn">Seat map unavailable: {showtime.seatError}</p>
          ) : found ? (
            <>
              <p className="card__status card__status--good">
                {seats.optionCount} way{seats.optionCount === 1 ? '' : 's'} to sit {partySize}{' '}
                together · {seats.available} of {seats.total} seats open
              </p>
              {seats.accessibleAlternative && (
                <p className="card__note">
                  Better seats exist in row {seats.accessibleAlternative.row} (
                  {seats.accessibleAlternative.seats.join(', ')}, quality{' '}
                  {seats.accessibleAlternative.score}) but they are wheelchair or companion spaces —
                  tick the box above to include them.
                </p>
              )}
              <div className="picks">
                {options.slice(0, 6).map((opt, i) => (
                  <button
                    key={opt.seats.join('-')}
                    type="button"
                    className={`pick ${i === pickIndex ? 'pick--active' : ''}`}
                    onClick={() => {
                      setPickIndex(i);
                      setOpen(true);
                    }}
                    title={`Seat quality ${opt.score}/100`}
                  >
                    <span className="pick__row">
                      Row {opt.row}
                      <em className="pick__score">{opt.score}</em>
                    </span>
                    <span className="pick__seats">{opt.seats.join(', ')}</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="card__status">
              {seats?.zoneRejected > 0
                ? `No ${partySize} together in your chosen area · ${seats.zoneRejected} pair${seats.zoneRejected === 1 ? '' : 's'} elsewhere in the room`
                : `No ${partySize} seats together`}
              {seats ? ` · largest block is ${seats.maxRun} · ${seats.available} open` : ''}
            </p>
          )}
        </div>

        <div className="card__actions">
          <Availability seats={seats} />
          <a className="btn btn--primary btn--sm" href={showtime.ticketUrl} target="_blank" rel="noreferrer">
            Tickets
          </a>
          {seats && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(!open)}>
              {open ? 'Hide map' : 'Seat map'}
            </button>
          )}
        </div>
      </div>

      {rank && showtime.hot && <WhyBar factors={showtime.hot.factors} />}

      {open && <SeatMap hash={showtime.key} highlight={picked?.seats ?? []} />}
    </article>
  );
}

const WHY_LABELS = {
  seats: 'Seat quality',
  distance: 'Nearby',
  time: 'Your time',
  soon: 'How soon',
};

/** Shows what earned this showing its recommendation, so the rank is not a black box. */
function WhyBar({ factors }) {
  return (
    <div className="why">
      {Object.entries(WHY_LABELS).map(([key, label]) => (
        <div className="why__item" key={key}>
          <span className="why__label">{label}</span>
          <span className="why__track">
            <span
              className={`why__fill ${factors[key] < 34 ? 'is-low' : factors[key] < 67 ? 'is-mid' : 'is-high'}`}
              style={{ width: `${factors[key]}%` }}
            />
          </span>
          <span className="why__val">{factors[key]}</span>
        </div>
      ))}
    </div>
  );
}

function shortDate(isoDate) {
  if (!isoDate) return '';
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function Availability({ seats }) {
  if (!seats || !seats.total) return null;
  const pct = Math.round((seats.available / seats.total) * 100);
  return (
    <div className="avail" title={`${seats.available} of ${seats.total} seats open`}>
      <div className="avail__bar">
        <div className="avail__fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="avail__pct">{pct}% open</span>
    </div>
  );
}
