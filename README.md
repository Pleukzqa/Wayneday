# Wayneday — ระบบจัดเวร (duty roster planner)

A group duty-roster app. A host opens a session, everyone joins with a three-word code, and the app arranges students around the hospital's resident/staff roster (or, optionally, schedules residents and staff too), with a review period before the roster is final.

## How it works

**Hosts and co-hosts sign in with Google** (when the server has `GOOGLE_CLIENT_ID`): their rosters open on any device and are listed under *My rosters*; the owner adds co-hosts by Google email in *Setup → Hosts*. Members never need an account — just the code and a PIN.

The whole app is in **English or Thai (ไทย)** — switch at the top right; it follows the browser language the first time. Hosts get a **Next steps** checklist that jumps to whatever still needs doing.

1. **Host creates a session** → gets a code like `amber-otter-river` and an invite link.
2. **Setup (host):** period and holidays, jobs (ER, Ward…), shift slots (times, weekdays, positions like "1 resident + 1 staff"), people (resident / staff / student), **student** settings, **presentation rules** (weekly or one-day; who must present is set on a small diagram — e.g. one from each ward off last night's shift, or from the same day's shift), free-text **other conditions**, and a **calendar** to change single dates — switch a shift or presentation off or on, change how many people or presentations it needs — and copy a day's changes to the rest of its week or to every same weekday.
   - **Residents & staff roster — From the hospital (default):** shift slot positions are **student places** (e.g. Night: Ward × 1, ER × 1), People lists only students, and the **Hospital roster** has a box per date for the residents and the staff on each shift — type names (Wayneday suggests names already used) or paste the hospital's table from Excel / Google Sheets. Wayneday arranges only the students and presenters.
   - **Student rules (hospital mode):** each place has an "at least – at most" number of students; each student does an **equal share** (every place filled, split evenly ±1 shift with a similar mix of shift slots — the default), a set total, or an exact number of each shift slot (e.g. 1 long room + 1 short room); optional **shift points** (weekday / weekend-holiday values, a date's own points such as 3 the day before an exam, a multiplier per shift slot) kept about equal after shift counts; a minimum number of days between a student's shifts; **places by dates** (a student covers Ward A from one date to another, then Ward B); and, tried as hard as possible, no student meeting the same resident or staff member twice, no two students together twice, and nobody alone on every shift. The Roster tab's **Rules check** says what couldn't be met.
   - **Made by Wayneday:** Wayneday also schedules residents and staff from their availability.
3. **People join:** pick their name and set a PIN — or open their **personal link** with the name pre-picked. Anyone not on the list can **ask to join**; the host adds them as a new person or links them to an existing name, and their device logs in automatically.
4. **Members fill in** (in hospital mode, only students): **Spread out** or **Grouped** shifts, minimum days between shifts, and a dates × people grid. One **🚫 Can’t / avoid** tool marks a day with how much it matters — ✕ can’t work, !!! really need it off, !! important, ! rather not — and **🔒 Lock in** puts them on a shift slot. Members press **I’m ready!** when done. Everyone sees everyone's answers. The host can only edit other people's columns after switching that on and giving a reason; every host edit is logged and the member gets a message saying why. Hosts can also leave a member a private note. **Undo** works for everyone.
5. **Find arrangements (host):** shows how many valid arrangements exist (exact when small, estimated otherwise), lists the best distinct options to compare, or explains why none is possible.
6. **Students** are placed after residents and staff, so every resident and every staff member is on duty with students about equally often. **Presenters** are picked for each presentation rule, taking the required number from the previous day's shift first and sharing the load.
7. **AI hand-off:** the prompt includes the whole problem and the roster on screen, in the exact JSON the app reads back; the reply is checked against the hard rules before publishing.
8. **Publish for review** with a concern period. Members raise concerns (tap a cell) or **ask to swap** one of their shifts or student places: the request is announced to the group, others offer to take it or trade, the asker accepts, and the host approves (the app shows any rule the swap would break).
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
npm test         # solver, translation and API tests
npm run lint
```

Production:

```sh
npm run build
npm start        # serves dist/ and /api on PORT (default 8787)
```

Sessions are stored in Postgres when `DATABASE_URL` is set, otherwise as JSON files in `data/` (override with `DATA_DIR`). `TEST_DATABASE_URL=postgres://… npm test` also runs the API tests against Postgres.

**Putting it online** (Supabase + Render + Google sign-in, free): see [DEPLOY.md](DEPLOY.md).

### Phone demo

`npm run build:demo` builds a server-free version into `dist-demo/`: the API runs in the browser (`src/demo/`), data stays on the device, and a bar at the bottom switches between the host and each member. `dist-demo/artifact.html` is the page published as a claude.ai artifact, with exports going through the viewer's Downloads capability.

### Google Drive export

Uses the same `GOOGLE_CLIENT_ID` as host sign-in (set on the server at runtime; see DEPLOY.md). Enable the Drive API and add your site's origin to the client's authorised JavaScript origins.

Drive export uses the `drive.file` scope (only files it creates). Calendar export uses `calendar.calendarlist.readonly`, `calendar.events` and `calendar.app.created`; enable the Google Calendar API too. These are sensitive scopes: until Google verifies the app, add your team as test users on the OAuth consent screen. Without a client ID, the buttons fall back to file downloads.

## Layout

```
server/        Express API (sessions, PIN login, answers, roster, concerns), Google sign-in (auth.ts),
               storage (store.ts: Postgres or JSON files), rate limits (limit.ts)
src/shared/    Types, date helpers, solver, AI prompt/import — used by browser, server and tests
src/shared/i18n.ts, th.ts  t('English text') looks up the Thai dictionary; a test fails if a string has no Thai entry
src/components Setup, Availability grid, Roster tabs
src/export.ts  CSV / XLSX / PNG / Drive export
```
