# Wayneday — notes for Claude

Wayneday (ระบบจัดเวร) arranges medical students' duty shifts around a hospital's resident/staff roster.
Owner: Pleuk (MDCU78). The app is in Thai and English; the owner writes in English, users are Thai.
README.md describes features; DEPLOY.md is the step-by-step hosting guide (Supabase + Render + Google).

## Commands

- `npm run dev` — app + API on http://localhost:5173 (Vite dev server mounts the Express API)
- `npm test` — node:test, `src/**/*.test.ts` and `server/**/*.test.ts`. `TEST_DATABASE_URL=postgres://… npm test` also runs the API tests on Postgres.
- `npx tsc -b`, `npm run lint` (oxlint; two old warnings in useSession.ts and RosterTab.tsx are known)
- `npm run build` then `npm start` — production server (dist/ + /api), port 8787
- `npm run build:demo` — phone demo in dist-demo/ (the API runs in the browser, src/demo/demoApi.ts); `dist-demo/artifact.html` is the single-page version

Node ≥ 22.18 runs the TypeScript server directly (type stripping, `.ts` imports, erasable syntax only).

## Layout

- `src/shared/` — used by browser, worker, server and tests: types, calendar (shift runs/counts, points, shift times, presentation sources), students.ts (the student arranger, counting, rules report, per-cell issues, hand-arranging targets, presenters), solver.ts (generate mode), ops.ts (swaps, joins, answer log), ai.ts (prompt + import), i18n.ts + th.ts
- `server/` — api.ts (Express routes; `cleanConfig` validates everything stored), store.ts (Postgres via DATABASE_URL, else JSON files; saves are version compare-and-swap with retry), auth.ts (Google ID token → signed account token, `X-Wayneday-Account` header), limit.ts (rate limits)
- `src/components/` — SetupTab + SetupExtras (calendar, students card, points box, presenter diagram `PresenterFlow`, hospital roster, hosts), AvailabilityTab, RosterTab, RosterTable, Swaps, CalendarExport, Hosts
- `public/guide.html` (first-time guide, TH/EN), `public/privacy.html`, logo files

## Conventions

- Every user-facing string goes through `t('English text', { vars })`; add the Thai to `src/shared/th.ts`. A test fails if a literal t() key has no Thai entry or a translation drops a `{placeholder}`. Vocabulary: เวร, นิสิต, แพทย์ประจำบ้าน, อาจารย์, ผู้จัด / ผู้จัดร่วม, หลบเวร.
- Hospital mode (default): residents/staff come from the typed hospital roster (`config.duty`); shift-slot requirements are student places (optional place/job, `min`–`count`); only students are arranged and only students present. `config.noDuty` leaves the hospital roster blank: read it through `dutyOf(config)`, not `config.duty`.
- New config fields need: the type in types.ts, cleaning in server/api.ts `cleanConfig`, a default in `normalizeSession` if old sessions lack it, the AI prompt in ai.ts if it's a rule, and a test.
- Engine features to know: equal share (`students.auto`, ±1 shift within each `shareGroups` group of students who can take the same places, capped by the least available student), points (`students.points`, `config.datePoints`), multi-day shifts (`endDays`, no overlapping shifts per student), presenter `sources` (shift/place, count, day before / same day), one-day presentations (`dates`, no weekdays), places by dates (`Member.periods`; check places with `coversJob(m, jobId, date)`, never `m.jobs` directly).
- Keep real students' names out of committed tests and fixtures (use synthetic names).
- Browser checks: Playwright is used for screenshots/e2e (scripts were kept outside the repo). In tests, select buttons by exact role name; the Next-steps checklist reuses words like "Find arrangements".

## Deploy

Render (render.yaml) builds the default branch `claude/cool-franklin-oudt4v` and redeploys on push. Env: DATABASE_URL (Supabase session pooler; table `wayneday_sessions` with RLS on), GOOGLE_CLIENT_ID, SESSION_SECRET, optional HOST_EMAILS (who may create rosters). See DEPLOY.md.

## Open ideas (not built)

- Optional LINE login for members; members currently use name + PIN.
