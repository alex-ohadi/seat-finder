import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchSeatMap, describeZone } from '../api.js';

/**
 * Drag a box over a real seat map to say where you want to sit.
 *
 * The box is stored in normalised 0..1 coordinates, never seat ids or pixels,
 * so one selection carries across auditoriums of completely different shapes.
 */
export default function ZonePicker({ hash, theaterName, zone, onChange, onClose }) {
  const [state, setState] = useState({ status: 'loading' });
  const [drag, setDrag] = useState(null);
  const svgRef = useRef(null);

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

  const geometry = useMemo(() => {
    if (state.status !== 'ready') return null;
    const seats = state.map.seats ?? [];
    if (seats.length === 0) return null;

    const cx = seats.map((s) => s.x + s.width / 2);
    const cy = seats.map((s) => s.y + s.height / 2);
    const minX = Math.min(...cx);
    const maxX = Math.max(...cx);
    const minY = Math.min(...cy);
    const maxY = Math.max(...cy);
    // Match the server's normalisation exactly: seat centres, not seat edges.
    return {
      seats,
      minX,
      maxX,
      minY,
      maxY,
      spanX: maxX - minX || 1,
      spanY: maxY - minY || 1,
      vbX: Math.min(...seats.map((s) => s.x)) - 12,
      vbY: Math.min(...seats.map((s) => s.y)) - 30,
      vbW: Math.max(...seats.map((s) => s.x + s.width)) - Math.min(...seats.map((s) => s.x)) + 24,
      vbH: Math.max(...seats.map((s) => s.y + s.height)) - Math.min(...seats.map((s) => s.y)) + 42,
    };
  }, [state]);

  if (state.status === 'loading') return <div className="zone zone--msg">Loading a seat map…</div>;
  if (state.status === 'error')
    return <div className="zone zone--msg zone--error">{state.error}</div>;
  if (!geometry) return <div className="zone zone--msg">No seat data to draw on.</div>;

  /** Pointer position -> normalised 0..1 seat space. */
  const toNormalised = (event) => {
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    // Map client px -> viewBox units -> normalised seat-centre space.
    const vx = geometry.vbX + ((event.clientX - rect.left) / rect.width) * geometry.vbW;
    const vy = geometry.vbY + ((event.clientY - rect.top) / rect.height) * geometry.vbH;
    return {
      nx: clamp01((vx - geometry.minX) / geometry.spanX),
      ny: clamp01((vy - geometry.minY) / geometry.spanY),
    };
  };

  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toNormalised(e);
    setDrag({ from: p, to: p });
  };
  const onPointerMove = (e) => {
    if (!drag) return;
    setDrag({ ...drag, to: toNormalised(e) });
  };
  const onPointerUp = () => {
    if (!drag) return;
    const next = {
      x0: Math.min(drag.from.nx, drag.to.nx),
      x1: Math.max(drag.from.nx, drag.to.nx),
      y0: Math.min(drag.from.ny, drag.to.ny),
      y1: Math.max(drag.from.ny, drag.to.ny),
    };
    setDrag(null);
    // A stray click (rather than a drag) clears the selection.
    if (next.x1 - next.x0 < 0.02 || next.y1 - next.y0 < 0.02) onChange(null);
    else onChange(next);
  };

  const live = drag
    ? {
        x0: Math.min(drag.from.nx, drag.to.nx),
        x1: Math.max(drag.from.nx, drag.to.nx),
        y0: Math.min(drag.from.ny, drag.to.ny),
        y1: Math.max(drag.from.ny, drag.to.ny),
      }
    : zone;

  // Normalised box -> viewBox rectangle.
  const boxRect = live && {
    x: geometry.minX + live.x0 * geometry.spanX,
    y: geometry.minY + live.y0 * geometry.spanY,
    width: (live.x1 - live.x0) * geometry.spanX,
    height: (live.y1 - live.y0) * geometry.spanY,
  };

  const inZone = (s) => {
    if (!live) return true;
    const nx = (s.x + s.width / 2 - geometry.minX) / geometry.spanX;
    const ny = (s.y + s.height / 2 - geometry.minY) / geometry.spanY;
    return nx >= live.x0 && nx <= live.x1 && ny >= live.y0 && ny <= live.y1;
  };

  const height = 420;

  return (
    <div className="zone">
      <div className="zone__head">
        <div>
          <strong>Drag a box</strong> over the area you want.{' '}
          <span className="zone__muted">Click once to clear.</span>
          <div className="zone__muted zone__sub">
            Layout shown: {theaterName}. Your selection is relative, so it applies to every theater.
          </div>
        </div>
        <div className="zone__head-actions">
          <span className="zone__current">{describeZone(live)}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => onChange(null)}>
            Clear
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            Done
          </button>
        </div>
      </div>

      <svg
        ref={svgRef}
        className="zone__svg"
        style={{ height, width: (height * geometry.vbW) / geometry.vbH, maxWidth: '100%' }}
        viewBox={`${geometry.vbX} ${geometry.vbY} ${geometry.vbW} ${geometry.vbH}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="application"
        aria-label="Drag to choose a preferred seating area"
      >
        <text
          x={geometry.vbX + geometry.vbW / 2}
          y={geometry.vbY + 16}
          textAnchor="middle"
          className="seatmap__screen-label"
        >
          SCREEN
        </text>
        {geometry.seats.map((s) => (
          <rect
            key={s.id}
            x={s.x}
            y={s.y}
            width={s.width}
            height={s.height}
            rx={Math.min(6, s.width / 4)}
            className={`zone__seat ${inZone(s) ? 'is-in' : 'is-out'}`}
          />
        ))}
        {boxRect && boxRect.width > 0 && (
          <rect
            x={boxRect.x}
            y={boxRect.y}
            width={boxRect.width}
            height={boxRect.height}
            className="zone__box"
          />
        )}
      </svg>
    </div>
  );
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));
