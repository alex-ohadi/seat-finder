import { FORMATS, formatMinutes, toTimeInput, fromTimeInput } from '../api.js';

export default function Controls({ draft, setDraft, onSearch, loading, onReset, theaters = [] }) {
  const set = (key) => (value) => setDraft({ ...draft, [key]: value });

  return (
    <form
      className="controls"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch();
      }}
    >
      <div className="controls__grid">
        <Field label="Movie" hint="Matched against the title">
          <input
            type="text"
            value={draft.title}
            onChange={(e) => set('title')(e.target.value)}
            placeholder="Odyssey"
          />
        </Field>

        <Field label="Format">
          <select value={draft.format} onChange={(e) => set('format')(e.target.value)}>
            {FORMATS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Theater"
          hint={theaters.length ? `${theaters.length} nearby` : 'All'}
        >
          <select
            value={draft.theaterId}
            onChange={(e) => set('theaterId')(e.target.value)}
            disabled={theaters.length === 0}
          >
            <option value="">All theaters</option>
            {theaters.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} — {t.distance.toFixed(1)} mi
              </option>
            ))}
          </select>
        </Field>

        <Field label="ZIP code">
          <input
            type="text"
            inputMode="numeric"
            value={draft.zip}
            onChange={(e) => set('zip')(e.target.value.replace(/\D/g, '').slice(0, 5))}
            placeholder="91401"
          />
        </Field>

        <Field label="Distance" hint={`${draft.distance} miles`}>
          <input
            type="range"
            min="1"
            max="100"
            value={draft.distance}
            onChange={(e) => set('distance')(Number(e.target.value))}
          />
        </Field>

        <Field label="Starting">
          <input
            type="date"
            value={draft.startDate}
            onChange={(e) => set('startDate')(e.target.value)}
          />
        </Field>

        <Field label="Days ahead" hint={`${draft.days} day${draft.days === 1 ? '' : 's'}`}>
          <input
            type="range"
            min="1"
            max="14"
            value={draft.days}
            onChange={(e) => set('days')(Number(e.target.value))}
          />
        </Field>

        <Field
          label="Earliest start"
          hint={formatMinutes(draft.startTime)}
        >
          <input
            type="time"
            value={toTimeInput(draft.startTime)}
            onChange={(e) => set('startTime')(fromTimeInput(e.target.value))}
          />
        </Field>

        <Field label="Latest start" hint={formatMinutes(draft.endTime)}>
          <input
            type="time"
            value={toTimeInput(draft.endTime)}
            onChange={(e) => set('endTime')(fromTimeInput(e.target.value))}
          />
        </Field>

        <Field label="Seats together" hint="No aisle between">
          <input
            type="number"
            min="1"
            max="12"
            value={draft.partySize}
            onChange={(e) => set('partySize')(Number(e.target.value))}
          />
        </Field>

        <Field label="Priority" hint={priorityLabel(draft.priority)}>
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={draft.priority}
            onChange={(e) => set('priority')(Number(e.target.value))}
          />
          <span className="field__ends">
            <span>Go sooner</span>
            <span>Best seats</span>
          </span>
        </Field>
      </div>

      <div className="controls__footer">
        <div className="controls__checks">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.includeAccessible}
              onChange={(e) => set('includeAccessible')(e.target.checked)}
            />
            <span>Include wheelchair &amp; companion seats</span>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.avoidBalcony}
              onChange={(e) => set('avoidBalcony')(e.target.checked)}
            />
            <span>Floor seats only (no balcony)</span>
          </label>
        </div>

        <div className="controls__actions">
          <button type="button" className="btn btn--ghost" onClick={onReset}>
            Reset
          </button>
          <button type="submit" className="btn btn--primary" disabled={loading}>
            {loading ? 'Searching…' : 'Find seats'}
          </button>
        </div>
      </div>
    </form>
  );
}

/** Plain-English reading of the seats-versus-sooner trade-off. */
function priorityLabel(p) {
  if (p >= 85) return 'Best seats, wait if needed';
  if (p >= 60) return 'Lean good seats';
  if (p >= 40) return 'Balanced';
  if (p >= 15) return 'Lean sooner & closer';
  return 'Go as soon as possible';
}

function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field__label">
        {label}
        {hint ? <em className="field__hint">{hint}</em> : null}
      </span>
      {children}
    </label>
  );
}
