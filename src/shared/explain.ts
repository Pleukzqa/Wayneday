// When no arrangement of students can be found: say why, in numbers and names, and what to change.
// Besides the direct checks, it retries with one rule loosened at a time and reports which would work.

import { shortDate } from './dates.ts'
import { t } from './i18n.ts'
import { arrangeStudents, fitCounts, shiftsNeeded, slotQuota, studentOccs, studentResponse } from './students.ts'
import { coversJob, type Assignment, type MemberResponse, type SessionConfig } from './types.ts'

export interface Hint {
  why: string
  fix: string
}
export interface Explanation {
  hints: Hint[]
  /** Single changes that make an arrangement possible, e.g. "each student doing 4 shifts instead of 5". */
  wouldWork: string[]
}

/** Indexes sorted by a key, smallest first. */
const sortedIdx = (keys: number[]) => keys.map((k, i) => [k, i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i)
const list = (xs: string[], most = 4) => `${xs.slice(0, most).join(', ')}${xs.length > most ? ` ${t('+{n} more', { n: xs.length - most })}` : ''}`

export function explainNoArrangement(config: SessionConfig, responses: Record<string, MemberResponse>, assignments: Assignment[]): Explanation {
  const students = config.members.filter((m) => m.type === 'student')
  const occs = studentOccs(config, assignments)
  if (!students.length || !occs.length) return { hints: [], wouldWork: [] }
  const auto = Boolean(config.students.auto)
  const quota = slotQuota(config)
  const need = shiftsNeeded(config)
  const resp = students.map((m) => studentResponse(config, responses, m.id))
  const allowed = students.map((m, si) =>
    occs.filter((o) => !resp[si].unavailable.includes(o.date) && coversJob(m, o.jobId, o.date) && (!quota || (quota.get(o.shiftId) ?? 0) > 0)).map((o) => o.i),
  )
  const places = occs.reduce((n, o) => n + o.cap, 0)
  const minimum = occs.reduce((n, o) => n + o.min, 0)
  const hints: Hint[] = []

  // Not enough places for everyone's shifts.
  if (!auto && !quota && students.length * need > places) {
    hints.push({
      why: t('{s} students × {need} shifts = {n} shifts, but there are only {p} student places.', { s: students.length, need, n: students.length * need, p: places }),
      fix: t('Lower “Each student does” to {k} shifts or fewer, turn on “Share equally”, or add student places (a higher “at most”, or another shift slot).', {
        k: Math.floor(places / students.length),
      }),
    })
  }
  if (quota) {
    for (const [shiftId, n] of quota) {
      const cap = occs.filter((o) => o.shiftId === shiftId).reduce((a, o) => a + o.cap, 0)
      const name = config.shifts.find((x) => x.id === shiftId)?.name ?? ''
      if (students.length * n > cap) {
        hints.push({
          why: t('{shift}: {s} students × {n} = {total}, but it only has {cap} places.', { shift: name, s: students.length, n, total: students.length * n, cap }),
          fix: t('Lower the number of {shift} shifts per student to {k}, or give {shift} more places.', { shift: name, k: Math.floor(cap / students.length) }),
        })
      }
    }
  }
  // Minimums need more students than there are shifts to go round.
  if (!auto && students.length * need < minimum) {
    hints.push({
      why: t('The places’ minimums add up to {min} student-shifts, but students only do {n}.', { min: minimum, n: students.length * need }),
      fix: t('Raise “Each student does” to {k}, or add students.', { k: Math.ceil(minimum / students.length) }),
    })
  }
  // The most the students could ever cover, working as often as their gaps and free days allow.
  const ceiling = fitCounts(occs, allowed, resp.map((r) => r.minInterval)).reduce((a, b) => a + b, 0)
  if (minimum > 0 && ceiling < minimum) {
    const each = Math.max(1, Math.round(ceiling / students.length))
    hints.push({
      why: t('Even working as often as their gaps and free days allow, the {s} students can cover at most {max} of the {min} student-shifts the minimums need.', {
        s: students.length,
        max: ceiling,
        min: minimum,
      }),
      fix: t('You need about {k} more student(s), or shorter gaps between shifts.', { k: Math.ceil((minimum - ceiling) / each) }),
    })
  }
  // Days where a place's minimum can't be met by who's free.
  const shortDays = occs.filter((o) => o.min > 0 && allowed.filter((a) => a.includes(o.i)).length < o.min)
  if (shortDays.length) {
    const dates = [...new Set(shortDays.map((o) => o.date))]
    const away = [...new Set(students.filter((_, si) => dates.some((d) => resp[si].unavailable.includes(d))).map((m) => m.name))]
    hints.push({
      why: t('On {dates}, a place needs a student but too few are free.', { dates: list(dates.map(shortDate)) }) + (away.length ? ` ${t('Unavailable then: {names}.', { names: list(away) })}` : ''),
      fix: t('Ask someone to free the day, or let more students cover that place.'),
    })
  }
  // Students who can't fit their shifts: because of the gap (even free every day), or their unavailable days.
  if (!auto) {
    const fit = fitCounts(occs, allowed, resp.map((r) => r.minInterval))
    const anyDay = (si: number) => occs.filter((o) => coversJob(students[si], o.jobId, o.date)).map((o) => o.i)
    const freeMax = students.map((_, si) => fitCounts(occs, [anyDay(si)], [resp[si].minInterval])[0])
    const gapBound = students.map((_, si) => si).filter((si) => freeMax[si] < need)
    if (gapBound.length) {
      const [fewest, most] = [Math.min(...gapBound.map((si) => freeMax[si])), Math.max(...gapBound.map((si) => freeMax[si]))]
      hints.push({
        why: t('Even free every day, {names} can’t fit {need} shifts with their gap between shifts (at most {max}).', {
          names: gapBound.length === students.length ? t('the students') : list(gapBound.map((si) => students[si].name)),
          need,
          max: fewest === most ? most : `${fewest}–${most}`,
        }),
        fix: t('Lower “Each student does” to {max}, or allow shorter gaps between shifts.', { max: fewest }),
      })
    }
    students.forEach((m, si) => {
      if (fit[si] >= need || gapBound.includes(si)) return
      const r = resp[si]
      const g = r.minInterval - 1
      const shorter = g >= 1 && fitCounts(occs, [allowed[si]], [g])[0] >= need
      const hostGap = (config.students.minGap ?? 0) > (responses[m.id]?.minInterval ?? r.minInterval)
      const restricted = m.jobs.length > 0 || (m.periods?.length ?? 0) > 0
      hints.push({
        why:
          t('{name} fits only {n} of {need} shifts around their {u} unavailable day(s).', { name: m.name, n: fit[si], need, u: r.unavailable.length }) +
          (restricted ? ` ${t('They can also only be in some places.')}` : ''),
        fix: shorter
          ? hostGap
            ? t('Lower “A student’s shifts at least … days apart” to {g} (it fits then).', { g })
            : g === 1
              ? t('Ask {name} to free some days, or to allow shifts on back-to-back days (it fits then).', { name: m.name })
              : t('Ask {name} to free some days, or to allow {g} days between shifts (it fits then).', { name: m.name, g })
          : t('Ask {name} to free some of their unavailable days.', { name: m.name }),
      })
    })
  }
  // Locks that can't be kept.
  students.forEach((m, si) => {
    const locks = [...resp[si].locks].sort((a, b) => a.date.localeCompare(b.date))
    const bad = locks.filter(
      (l) =>
        resp[si].unavailable.includes(l.date) ||
        !occs.some((o) => o.date === l.date && o.shiftId === l.shiftId && coversJob(m, o.jobId, o.date)),
    )
    const close = locks.filter((l, i) => i > 0 && (Date.parse(l.date) - Date.parse(locks[i - 1].date)) / 86_400_000 < resp[si].minInterval)
    if (bad.length || close.length) {
      hints.push({
        why: t('{name}’s locked shifts can’t all be kept ({dates}).', { name: m.name, dates: list([...bad, ...close].map((l) => shortDate(l.date))) }),
        fix: t('Remove or move those locks in Availability, or lower their gap.'),
      })
    }
  })

  // Try one change at a time, smallest first. Minimums stay as they are: a place that must be staffed is.
  const wouldWork: string[] = []
  const MOST = 6
  let budget = 18
  const works = (c: SessionConfig, r = responses) => budget-- > 0 && arrangeStudents(c, r, assignments, 1, 200).ok
  const tryIt = (label: string, c: SessionConfig, r = responses) => {
    if (wouldWork.length < MOST && works(c, r)) wouldWork.push(label)
  }
  const st = config.students
  const withResp = (si: number, patch: Partial<MemberResponse>) => ({ ...responses, [students[si].id]: { ...resp[si], ...patch } })
  // 1. Someone frees one day that a place can't be staffed on (only ✕ days block a student outright).
  for (const date of [...new Set(shortDays.map((o) => o.date))].slice(0, 4)) {
    students.forEach((m, si) => {
      if (!resp[si].unavailable.includes(date)) return
      tryIt(t('{name} freeing {date}', { name: m.name, date: shortDate(date) }), config, withResp(si, { unavailable: resp[si].unavailable.filter((d) => d !== date) }))
    })
  }
  // 2. One person allows a shorter gap (when it's their own answer, not the host's minimum).
  const byGap = sortedIdx(students.map((_, si) => -resp[si].minInterval))
  for (const si of byGap.slice(0, 4)) {
    const r = resp[si]
    const own = responses[students[si].id]?.minInterval ?? r.minInterval
    if (r.minInterval <= 1 || (st.minGap ?? 0) > own) continue
    const g = r.minInterval - 1
    tryIt(
      g === 1
        ? t('{name} allowing shifts on back-to-back days', { name: students[si].name })
        : t('{name} allowing shifts {g} days apart instead of {h}', { name: students[si].name, g, h: r.minInterval }),
      config,
      withResp(si, { minInterval: g }),
    )
  }
  // 3. One person may cover any place (their "Can cover" ticks or places by dates hold them back).
  students.forEach((m) => {
    if (!m.jobs.length && !m.periods?.length) return
    tryIt(t('{name} covering any place', { name: m.name }), { ...config, members: config.members.map((x) => (x.id === m.id ? { ...x, jobs: [], periods: undefined } : x)) })
  })
  // 4. A different number of shifts each.
  if (!auto && !quota) {
    tryIt(t('each student doing {n} shifts instead of {m}', { n: need + 1, m: need }), { ...config, students: { ...st, shiftsPerStudent: need + 1 } })
    if (need > 1) tryIt(t('each student doing {n} shifts instead of {m}', { n: need - 1, m: need }), { ...config, students: { ...st, shiftsPerStudent: need - 1 } })
  }
  // Enough shifts each to cover every minimum.
  const enough = Math.ceil(minimum / students.length)
  if (!auto && !quota && enough > need + 1) {
    tryIt(t('each student doing {n} shifts instead of {m}', { n: enough, m: need }), { ...config, students: { ...st, shiftsPerStudent: enough } })
  }
  if (!auto) tryIt(t('turning on “Share equally”'), { ...config, students: { ...st, auto: true } })
  // 5. One more student (free every day, default answers): worth asking for if nothing else works.
  tryIt(t('one more student'), { ...config, members: [...config.members, { id: '__extra', name: '+1', type: 'student', jobs: [] }] })
  // 6. Everyone a day shorter; no locks.
  if (resp.some((r) => r.minInterval > 1)) {
    const shorter = Object.fromEntries(students.map((m, si) => [m.id, { ...resp[si], minInterval: Math.max(1, resp[si].minInterval - 1) }]))
    tryIt(t('everyone’s gap between shifts one day shorter'), { ...config, students: { ...st, minGap: Math.max(0, (st.minGap ?? 0) - 1) } }, { ...responses, ...shorter })
  }
  if (resp.some((r) => r.locks.length)) {
    const unlocked = Object.fromEntries(students.map((m, si) => [m.id, { ...resp[si], locks: [] }]))
    tryIt(t('without the locked-in shifts'), config, { ...responses, ...unlocked })
  }
  // Nothing single works: a few pairs, sharing equally plus one more change.
  if (!wouldWork.length) {
    const shared = { ...config, students: { ...st, auto: true } }
    const extra = (c: SessionConfig) => ({ ...c, members: [...c.members, { id: `__extra${c.members.length}`, name: '+1', type: 'student' as const, jobs: [] }] })
    const shorterAll = Object.fromEntries(students.map((m, si) => [m.id, { ...resp[si], minInterval: Math.max(1, resp[si].minInterval - 1) }]))
    budget = 4
    tryIt(`${t('one more student')} + ${t('turning on “Share equally”')}`, extra(shared))
    if (resp.some((r) => r.minInterval > 1)) {
      tryIt(`${t('everyone’s gap between shifts one day shorter')} + ${t('turning on “Share equally”')}`, { ...shared, students: { ...shared.students, minGap: Math.max(0, (st.minGap ?? 0) - 1) } }, { ...responses, ...shorterAll })
    }
    tryIt(`${t('two more students')} + ${t('turning on “Share equally”')}`, extra(extra(shared)))
  }
  if (!hints.length) {
    hints.push({
      why: t('Each rule can be met on its own, but not all of them together — it’s a tight fit.'),
      fix: wouldWork.length ? t('Loosen one of the rules below.') : t('Try shorter gaps, a different number of shifts per student, or another student.'),
    })
  }
  return { hints, wouldWork }
}
