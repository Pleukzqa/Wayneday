# Wayneday — แอปจัดเวร

A group duty-roster app. A host opens a session, everyone joins with a three-word code, fills in their availability and preferences, and the host simulates and publishes a fair roster with a review period before it's final.

## How it works

1. **Host creates a session** → gets a code like `amber-otter-river` and an invite link.
2. **Setup (host):** period and holidays, jobs (ER, Ward…), shift slots (times, weekdays, and positions like "1 resident + 1 staff"), people (resident/staff, jobs they can cover, optional max shifts), and free-text **other conditions** (e.g. morning round rules).
3. **Members log in** by picking their name and setting a PIN, then:
   - choose **Spread out** (distributed) or **Grouped** (dense) shifts and their **minimum days between shifts**;
   - tap/drag cells in the **dates × people grid** to mark days **unavailable** or **lock** themselves into a shift.
   Everyone's answers are visible to the whole group.
4. **Simulate (host):** the solver previews a roster privately, or explains why none is possible (e.g. "Nov 3 → 5: 7 resident positions but people can cover at most 5").
5. **Other conditions → AI:** the Roster tab builds a full prompt to paste into any AI; paste the JSON reply back and it's checked against the hard rules before publishing.
6. **Publish for review** with a concern period (hours). Members raise concerns (tap a roster cell to tag the date); the host can edit cells, resolve concerns, extend, then **Finalize**.
7. **Export:** Excel (.xlsx, with a per-person sheet), CSV, PNG image, or Google Sheets in Drive.

### Solver

- **Hard rules:** every position filled by someone of the right type/job; one shift per person per day; each person's minimum interval; unavailable dates; locks; max-shift caps.
- **Soft goals:** equal totals per type, then equal weekend/holiday shifts, then equal counts per shift type, then preferences. People who want spread-out shifts are prioritised; grouped people are packed toward their minimum interval.
- Backtracking search (most-constrained position first) finds a valid roster, then simulated annealing improves it. Runs in a Web Worker in the host's browser.

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

It uses the `drive.file` scope, so it can only access files it creates. Without a client ID, the button is disabled and users can upload the .xlsx to Drive themselves.

## Layout

```
server/        Express API (sessions, PIN login, answers, roster, concerns)
src/shared/    Types, date helpers, solver, AI prompt/import — used by browser, server and tests
src/components Setup, Availability grid, Roster tabs
src/export.ts  CSV / XLSX / PNG / Drive export
```
