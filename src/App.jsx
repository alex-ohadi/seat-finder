import { useCallback, useEffect, useRef, useState } from 'react';
import Controls from './components/Controls.jsx';
import TheaterScrubber from './components/TheaterScrubber.jsx';
import ZonePicker from './components/ZonePicker.jsx';
import { DEFAULT_CONFIG, search, formatMinutes, describeZone } from './api.js';
import './styles.css';

export default function App() {
  const [draft, setDraft] = useState(DEFAULT_CONFIG);
  const [applied, setApplied] = useState(DEFAULT_CONFIG);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
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
  const minScore = result?.stats?.minRecommendableSeatScore ?? 25;

  // One panel per theater, each scrubbable across every date in range. Split so
  // theaters that can actually seat you well lead, and the rest stay reachable
  // underneath rather than being hidden.
  const theaters = groupByTheater(showtimes);
  const goodTheaters = theaters.filter((t) => t.bestScore >= minScore);
  const otherTheaters = theaters.filter((t) => t.bestScore < minScore);

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
        theaters={result?.theaters ?? []}
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
        <span className="resultbar__hint">Every theater below scrubs across all dates</span>
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

      {loading && !result && <p className="empty">Scanning showtimes and seat maps…</p>}

      {result && theaters.length === 0 && !loading && (
        <div className="empty">
          <p>
            <strong>Nothing matched.</strong>
          </p>
          <p>
            {result.stats.showtimesFound === 0
              ? 'No showings of that movie in that format nearby — try widening the distance or switching format.'
              : 'No showings fell inside that time window — try widening it.'}
          </p>
        </div>
      )}

      <main className={loading ? 'results is-loading' : 'results'}>
        {goodTheaters.length > 0 && (
          <section className="recs">
            <h2 className="recs__heading">
              Recommended
              <span className="recs__hint">
                good seats first, then nearest, your time, soonest
              </span>
            </h2>
            {goodTheaters.map((t, i) => (
              <TheaterScrubber
                key={t.id}
                theater={t}
                partySize={applied.partySize}
                rank={i + 1}
                defaultOpen={i === 0}
              />
            ))}
          </section>
        )}

        {otherTheaters.length > 0 && (
          <section className="recs">
            <h2 className="recs__heading recs__heading--muted">
              Other theaters
              <span className="recs__hint">
                {goodTheaters.length === 0
                  ? 'nothing here has good seats left — scrub to check other days'
                  : 'best remaining seats are front-row or far-side · still scrubbable'}
              </span>
            </h2>
            {otherTheaters.map((t) => (
              <TheaterScrubber key={t.id} theater={t} partySize={applied.partySize} />
            ))}
          </section>
        )}
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

/**
 * Collapse the flat showtime list into one entry per theater, chronological
 * within each, carrying the best seats that theater can offer anywhere in the
 * range and which step they are on.
 */
function groupByTheater(showtimes) {
  const map = new Map();
  for (const s of showtimes) {
    const id = s.theaterId ?? s.theaterName;
    if (!map.has(id)) {
      map.set(id, {
        id,
        name: s.theaterName,
        distance: s.distance,
        chain: s.chain,
        showtimes: [],
      });
    }
    map.get(id).showtimes.push(s);
  }

  const entries = [...map.values()];
  for (const t of entries) {
    t.showtimes.sort((a, b) => (a.startsAt?.iso ?? '').localeCompare(b.startsAt?.iso ?? ''));

    let bestIndex = 0;
    let bestScore = 0;
    t.showtimes.forEach((s, i) => {
      const score = s.seats?.bestScore ?? 0;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    });

    t.bestScore = bestScore;
    t.bestIndex = bestIndex;
    t.bestSeats = t.showtimes[bestIndex]?.seats?.options?.[0]?.seats ?? null;
    // Rank theaters by their best showing's overall score, not raw seat quality,
    // so distance and timing still break ties between comparable rooms.
    t.bestHot = Math.max(0, ...t.showtimes.map((s) => s.hot?.score ?? 0));
  }

  return entries.sort((a, b) => b.bestHot - a.bestHot || a.distance - b.distance);
}
