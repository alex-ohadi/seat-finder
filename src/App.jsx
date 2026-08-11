import { useCallback, useEffect, useRef, useState } from 'react';
import Controls from './components/Controls.jsx';
import ShowtimeCard from './components/ShowtimeCard.jsx';
import ZonePicker from './components/ZonePicker.jsx';
import { DEFAULT_CONFIG, search, formatMinutes, formatDateHeading, describeZone } from './api.js';
import './styles.css';

export default function App() {
  const [draft, setDraft] = useState(DEFAULT_CONFIG);
  const [applied, setApplied] = useState(DEFAULT_CONFIG);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [onlyMatches, setOnlyMatches] = useState(true);
  const [zoneOpen, setZoneOpen] = useState(false);
  const inflight = useRef(null);

  const run = useCallback(async (config) => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;

    setLoading(true);
    setError(null);
    try {
      const data = await search(config, controller.signal);
      setResult(data);
      setApplied(config);
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message);
    } finally {
      if (inflight.current === controller) setLoading(false);
    }
  }, []);

  useEffect(() => {
    run(DEFAULT_CONFIG);
  }, [run]);

  const showtimes = result?.showtimes ?? [];
  const recommendedKeys = result?.recommended ?? [];
  const recommended = recommendedKeys
    .map((key) => showtimes.find((s) => s.key === key))
    .filter(Boolean);

  const visible = onlyMatches
    ? showtimes.filter((s) => (s.seats?.optionCount ?? 0) > 0)
    : showtimes;
  const byDate = groupBy(visible, (s) => s.startsAt?.date ?? 'unknown');

  // The seat map to draw the preferred-area box on: whichever showing has the
  // most seat data, so the layout is representative.
  const zoneSample = showtimes.find((s) => s.seats) ?? null;

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1 className="header__title">Seat Finder</h1>
          <p className="header__sub">
            Live showtimes and seat maps, scanned for{' '}
            <strong>
              {applied.partySize} seat{applied.partySize === 1 ? '' : 's'} together
            </strong>
          </p>
        </div>
        {result && (
          <dl className="summary">
            <Stat label="Showings" value={result.stats.showtimesInWindow} />
            <Stat label="With seats" value={result.stats.withSeatsTogether} highlight />
            <Stat label="Days" value={result.stats.datesSearched} />
          </dl>
        )}
      </header>

      <Controls
        draft={draft}
        setDraft={setDraft}
        loading={loading}
        onSearch={() => run(draft)}
        onReset={() => {
          setDraft(DEFAULT_CONFIG);
          run(DEFAULT_CONFIG);
        }}
      />

      {error && (
        <div className="banner banner--error">
          <strong>Search failed.</strong> {error}
        </div>
      )}

      {result?.stats?.dayErrors?.length > 0 && (
        <div className="banner banner--warn">
          Some days could not be fetched:{' '}
          {result.stats.dayErrors.map((d) => `${d.date} (${d.error})`).join(', ')}
        </div>
      )}

      <div className="resultbar">
        <span>
          {applied.title || 'Any movie'} · within {applied.distance} mi of {applied.zip} ·{' '}
          {formatMinutes(applied.startTime)}–{formatMinutes(applied.endTime)} starts ·{' '}
          <button
            type="button"
            className="linkbtn"
            onClick={() => setZoneOpen(!zoneOpen)}
            disabled={!zoneSample}
          >
            seats: {describeZone(draft.zone)}
          </button>
        </span>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={onlyMatches}
            onChange={(e) => setOnlyMatches(e.target.checked)}
          />
          <span>Only showings with {applied.partySize} together</span>
        </label>
      </div>

      {zoneOpen && zoneSample && (
        <ZonePicker
          hash={zoneSample.key}
          theaterName={zoneSample.theaterName}
          zone={draft.zone}
          onChange={(zone) => {
            const next = { ...draft, zone };
            setDraft(next);
            run(next);
          }}
          onClose={() => setZoneOpen(false)}
        />
      )}

      {result && !loading && (
        <section className="recs">
          <h2 className="recs__heading">
            Recommended
            <span className="recs__hint">good seats first, then nearest, your time, soonest</span>
          </h2>

          {recommended.length === 0 ? (
            <div className="empty">
              <p>
                <strong>Nothing here is worth recommending.</strong>
              </p>
              <p>
                Every showing in range has only front-row or far-side seats left. Try a wider time
                window, more days, or a bigger distance.
              </p>
            </div>
          ) : (
            <>
              {recommended.map((s, i) => (
                <ShowtimeCard
                  key={s.key}
                  showtime={s}
                  partySize={applied.partySize}
                  rank={i + 1}
                  showDate
                />
              ))}
              {recommended.length < 3 && (
                <p className="recs__note">
                  Only {recommended.length} showing{recommended.length === 1 ? '' : 's'} had seats
                  worth recommending. The rest are listed below — their best remaining seats are
                  front-row or far-side.
                </p>
              )}
            </>
          )}
        </section>
      )}

      {loading && !result && <p className="empty">Scanning showtimes and seat maps…</p>}

      {result && visible.length === 0 && !loading && (
        <div className="empty">
          <p>
            <strong>Nothing matched.</strong>
          </p>
          <p>
            {result.stats.showtimesFound === 0
              ? 'No showings of that movie in that format nearby — try widening the distance or switching format.'
              : onlyMatches
                ? `Found ${result.stats.showtimesInWindow} showing(s) in your time window, but none with ${applied.partySize} seats together. Untick the filter above to see them anyway.`
                : 'No showings fell inside that time window — try widening it.'}
          </p>
        </div>
      )}

      <main className={loading ? 'results is-loading' : 'results'}>
        {[...byDate.entries()].map(([date, items]) => (
          <section key={date} className="day">
            <h2 className="day__heading">
              {formatDateHeading(date)}
              <span className="day__count">{items.length} showing{items.length === 1 ? '' : 's'}</span>
            </h2>
            {items.map((s) => (
              <ShowtimeCard key={s.key} showtime={s} partySize={applied.partySize} />
            ))}
          </section>
        ))}
      </main>

      {result && (
        <footer className="footer">
          Data scraped live from Fandango · updated {new Date(result.generatedAt).toLocaleTimeString()}
        </footer>
      )}
    </div>
  );
}

function Stat({ label, value, highlight }) {
  return (
    <div className={`stat ${highlight ? 'stat--highlight' : ''}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function groupBy(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}
