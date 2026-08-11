# Seat Finder

Finds movie showtimes near a ZIP code and scans each showing's live seat map for
**N seats side by side**. Built for tracking down two seats together at an
IMAX 70mm screening, but every filter is configurable.

```bash
npm install
npm run dev        # web on :5173, scraper API on :8787
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Both servers, with cleanup when either exits |
| `npm run api` | Scraper API only (`API_PORT`, default 8787) |
| `npm run web` | Vite only |
| `npm test` | Adjacency engine regression tests |

## Where the data comes from

Fandango's own site calls two undocumented JSON endpoints. There is no public
API, no key, and no headless browser involved:

| Endpoint | Returns |
| --- | --- |
| `GET /napi/theaterswithshowtimes?zipCode=&date=&page=&limit=` | Theaters near a ZIP, with distance, formats and showtimes |
| `GET /napi/seatMap/<showtimeHashCode>` | Live seat map: every seat with status, type and geometry |

This app exposes them as `/api/search`, `/api/timeline` (one theater across
days), `/api/showtime/:hash` (map + analysis in one trip) and `/api/seatmap/:hash`.

The two join on `showtimeHashCode`, which the showtimes response already
carries — no scraping of HTML, and no ticket-flow session to establish.

**Bot protection.** A bare request gets `403`. The same request with a full set
of browser headers gets `200`. That is the only reason `BROWSER_HEADERS` exists
in [`server/fandango.js`](server/fandango.js).

Seat statuses: `A` available · `R` reserved/sold · `O` held or blocked.

### Dead ends, so nobody retries them

- `tickets.fandango.com/.../seatselection` renders a seat picker but its data
  call (`checkoutapi/showtimes/v2/<id>`) returns 404 for these chains; Fandango's
  own telemetry reports `onrequestmaperror not found`. The `napi/seatMap`
  endpoint behind the site's "Check Seats" button is the one that works.
- `checkoutapi/*` requires a bearer token that `POST /token` will not issue
  without an active cart.

## Deciding what counts as "together"

This is the part that is easy to get quietly wrong. Two independent signals
exist and **each is incomplete**, so [`server/seats.js`](server/seats.js) uses
the union:

1. **`leftNeighbor` / `rightNeighbor` seat ids** — authoritative where present,
   and they encode aisles. But some auditoriums leave them blank: Regal LA Live
   populates them for only 181 of 408 real pairs, so a links-only implementation
   reports *zero* pairs in a house with 75 open standard seats.
2. **Geometry** — seats sharing a `row`, ordered by `x`, with each gap compared
   against that row's median seat pitch. A gap wider than `1.35 × pitch` is an
   aisle. Always populated, and it matched the explicit links on all 875 pairs
   at TCL Chinese, which is what makes it trustworthy. It under-reports around
   wheelchair spaces, which sit 1.4–2× normal pitch apart and read as aisles.

Wheelchair and companion seats are excluded unless you tick the box. When
excluding them costs you noticeably better seats, the card says so instead of
leaving you wondering why the middle was not offered.

## Which seats are actually good

Every candidate group gets a 0-100 quality score. Depth **multiplies** the
centring term rather than being averaged with it, because a perfectly centred
front-row pair is still a bad pair — averaging let one score 55/100 and take the
top recommendation slot.

| Position | Score |
| --- | --- |
| ~⅔ back, dead centre | 100 |
| Back row, centre | 72 |
| Mid-house, centre | 60 |
| ~⅔ back, far side | 29 |
| Front row, centre | 6 |
| Front row, far side | 1 |

The peak sits at 65% of the way back. Falloff toward the screen is steeper than
linear so the whole front section scores badly, not just row A.

**Preferred area.** Drag a box over a real seat map to restrict results to part
of the room. It is stored in normalised 0-1 coordinates, never seat ids, so one
selection applies to every auditorium regardless of size or shape.

## Theater timeline

Pick a theater in the filters and a scrubber appears: drag the knob through
every showing at that theater across the searched days and watch the room fill
up, with open/filled counts and the best available pair at each step.

It deliberately ignores the time-of-day window — the point is to see whole days,
and clipping to 5-9pm would leave holes in the thing you are scrubbing. Ticks
under the slider mark each showing; green ones are inside your window.

Seat maps are cached per step and the neighbouring steps are prefetched, so a
slow drag stays continuous instead of flashing through loading states.

The slider moves **within** the loaded range; **Earlier / Later** page the whole
search to the previous or next range, so scrubbing to the end is no longer a
dead stop. Paging never goes back past today, since past showings cannot be
booked.

## Recommendations

The top three are scored on seat quality, distance, closeness to the middle of
your time window, and how soon. Seat quality **multiplies** the other three for
the same reason as above: being near, on time and tomorrow used to bank ~32
points regardless of whether the only free pair was against the screen.

A showing whose best seats score below 25 is listed but never recommended, and
the UI says how many were held back rather than quietly filling three slots.

The **priority slider** sets the trade-off between holding out for great seats
and going sooner and closer.

`npm test` covers both adjacency signals, aisle rejection, sold-seat splitting,
the blank-neighbour regression, the scoring curve, zone parsing, and the
ranking rules.

## Layout

```
server/
  fandango.js     endpoint client, headers, format presets
  seats.js        adjacency + seat-quality engine
  index.js        HTTP API, ranking, caching, bounded concurrency
  *.test.js       regression tests
src/
  App.jsx         page shell, recommendations, empty states
  api.js          client calls + time helpers
  components/     Controls, ShowtimeCard, SeatMap, ZonePicker
```

Everything is configurable from the UI: movie title, format
(IMAX 70mm / any 70mm / any IMAX / any), ZIP, distance, start date, days ahead,
earliest and latest start time, party size, preferred area, and the
seats-versus-sooner priority.

## Notes

- Seat maps are cached 60s, showtime lists 5 min. Seat maps are only fetched for
  showings that pass the time filter.
- A day that fails to fetch is reported in the UI rather than sinking the search.
- Results reflect Fandango's inventory; a theater's own site may differ.
