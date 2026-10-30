# Wayneday — แอปจัดเวร

A group duty-roster app. A host opens a session, everyone joins with a three-word code, fills in their availability and preferences, and the host simulates and publishes a fair roster with a review period before it's final.

## How it works

1. **Host creates a session** → gets a code like `amber-otter-river` and an invite link.
2. **Setup (host):** period and holidays, jobs (ER, Ward…), shift slots (times, weekdays, positions like "1 resident + 1 staff"), a **calendar** to change single dates (switch a shift off or on, change how many people it needs), people (resident / staff / student, jobs they can cover, optional max shifts), **student** settings, **presentation rules**, and free-text **other conditions**.
3. **People join:** pick their name and set a PIN — or open their **personal link** with the name pre-picked. Anyone not on the list can **ask to join**; the host adds them as a new person or links them to an existing name, and their device logs in automatically.
4. **Members fill in:** **Spread out** or **Grouped** shifts, minimum days between shifts, and a dates × people grid to mark days **unavailable** or **lock** themselves into a shift slot. Everyone sees everyone's answers. The host can only edit other people's columns after switching that on; every host edit is logged, the member is told, and can restore their previous answers. **Undo** works for everyone.
5. **Find arrangements (host):** shows how many valid rosters exist (exact when small, estimated otherwise), lists the best distinct options to compare, or explains why none is possible.
6. **Students** are placed after residents and staff, so every resident and every staff member is on duty with students about equally often. **Presenters** are picked for each presentation rule, taking the required number from the previous day's shift first and sharing the load.
7. **AI hand-off:** the prompt includes the whole problem and the roster on screen, in the exact JSON the app reads back; the reply is checked against the hard rules before publishing.
8. **Publish for review** with a concern period. Members raise concerns (tap a cell) or **ask to swap** one of their shifts: the request is announced to the group, others offer to take it or trade, the asker accepts, and the host approves (the app shows any rule the swap would break).
9. **Export:** Excel, CSV, PNG, Google Sheets, and **calendar** — pick whose shifts, the event name, a colour and the Google calendar (or a new one), or download .ics / Google Calendar CSV.

### Solver

- **Hard rules:** every position filled by someone of the right type/job; one shift per person per day; each person's minimum interval; unavailable dates; locks; max-shift caps; date exceptions.
- **Soft goals:** equal totals per type, then weekend/holiday shifts, then counts per shift type, then preferences (spread-out people first; grouped people packed toward their interval).
- Backtracking search (most-constrained position first), then simulated annealing; several seeds give the alternative options. Counting walks the search tree exactly when small and uses Knuth's random-probe estimator otherwise. Runs in a Web Worker in the host's browser.

## Development

Requires Node ≥ 22.18 (runs the TypeScript server directly).

```sh
npm install
npm run dev      # app + API on http://localhost:5173
npm test         # solver tests
npm run lint
```

Production:

```sh
npm run build
npm start        # serves dist/ and /api on PORT (default 8787)
```

Session data is stored as JSON files in `data/` (override with `DATA_DIR`).

### Phone demo

`npm run build:demo` builds a server-free version into `dist-demo/`: the API runs in the browser (`src/demo/`), data stays on the device, and a bar at the bottom switches between the host and each member. `dist-demo/artifact.html` is the page published as a claude.ai artifact, with exports going through the viewer's Downloads capability.

### Google Drive export

Create an OAuth 2.0 **Web client** in Google Cloud Console, enable the Drive API, add your site's origin to the authorised JavaScript origins, then build with:

```sh
VITE_GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com npm run build
```

Drive export uses the `drive.file` scope (only files it creates). Calendar export uses `calendar.calendarlist.readonly`, `calendar.events` and `calendar.app.created`; enable the Google Calendar API too. These are sensitive scopes: until Google verifies the app, add your team as test users on the OAuth consent screen. Without a client ID, the buttons fall back to file downloads.

## Layout

```
server/        Express API (sessions, PIN login, answers, roster, concerns)
src/shared/    Types, date helpers, solver, AI prompt/import — used by browser, server and tests
src/components Setup, Availability grid, Roster tabs
src/export.ts  CSV / XLSX / PNG / Drive export
```
