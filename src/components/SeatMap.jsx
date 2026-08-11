import { useEffect, useState } from 'react';
import { fetchSeatMap } from '../api.js';

/**
 * Compact seat plan drawn from the raw x/y geometry Fandango returns.
 * Highlights one candidate group so the pair is easy to spot in the room.
 */
export default function SeatMap({ hash, highlight = [] }) {
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    fetchSeatMap(hash, controller.signal)
      .then((map) => setState({ status: 'ready', map }))
      .catch((err) => {
        if (err.name !== 'AbortError') setState({ status: 'error', error: err.message });
      });
    return () => controller.abort();
  }, [hash]);

  if (state.status === 'loading') return <div className="seatmap seatmap--msg">Loading seat map…</div>;
  if (state.status === 'error')
    return <div className="seatmap seatmap--msg seatmap--error">{state.error}</div>;

  const seats = state.map.seats ?? [];
  if (seats.length === 0) return <div className="seatmap seatmap--msg">No seat data.</div>;

  const pad = 10;
  const maxX = Math.max(...seats.map((s) => s.x + s.width));
  const maxY = Math.max(...seats.map((s) => s.y + s.height));
  const picked = new Set(highlight);

  const vbWidth = maxX + pad * 2;
  const vbHeight = maxY + pad * 2 + 18;

  // Size the element to the plan's own aspect ratio. A fixed-width box would
  // letterbox a tall auditorium down to a narrow strip in a sea of dead space.
  const height = 440;
  const style = { height, width: (height * vbWidth) / vbHeight, maxWidth: '100%' };

  return (
    <div className="seatmap">
      <svg
        viewBox={`${-pad} ${-pad - 18} ${vbWidth} ${vbHeight}`}
        className="seatmap__svg"
        style={style}
        role="img"
        aria-label="Seat availability plan"
      >
        <text x={maxX / 2} y={-24} textAnchor="middle" className="seatmap__screen-label">
          SCREEN
        </text>
        <line x1={0} y1={-14} x2={maxX} y2={-14} className="seatmap__screen" />
        {seats.map((s) => {
          const isPicked = picked.has(s.id);
          const cls = isPicked
            ? 'is-picked'
            : s.status === 'A'
              ? 'is-open'
              : s.status === 'O'
                ? 'is-blocked'
                : 'is-taken';
          return (
            <rect
              key={s.id}
              x={s.x}
              y={s.y}
              width={s.width}
              height={s.height}
              rx={Math.min(6, s.width / 4)}
              className={`seatmap__seat ${cls}`}
            >
              <title>{`${s.id} — ${s.type} — ${labelFor(s.status)}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="seatmap__legend">
        <Key className="is-picked" label={highlight.length ? highlight.join(' + ') : 'Your seats'} />
        <Key className="is-open" label="Open" />
        <Key className="is-taken" label="Taken" />
        <Key className="is-blocked" label="Blocked" />
      </div>
    </div>
  );
}

function Key({ className, label }) {
  return (
    <span className="seatmap__key">
      <i className={`seatmap__swatch ${className}`} />
      {label}
    </span>
  );
}

function labelFor(status) {
  if (status === 'A') return 'available';
  if (status === 'O') return 'unavailable';
  return 'sold';
}
