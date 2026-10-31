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
      fix: t('Lower the “at least” numbers, or raise “Each student does” to {k}.', { k: Math.ceil(minimum / students.length) }),
    })
  }
  // Days where a place's minimum can't be met by who's free.
  const shortDays = occs.filter((o) => o.min > 0 && allowed.filter((a) => a.includes(o.i)).length < o.min)
  if (shortDays.length) {
    const dates = [...new Set(shortDays.map((o) => o.date))]
    const away = [...new Set(students.filter((_, si) => dates.some((d) => resp[si].unavailable.includes(d))).map((m) => m.name))]
    hints.push({
      why: t('On {dates}, a place needs a student but too few are free.', { dates: list(dates.map(shortDate)) }) + (away.length ? ` ${t('Unavailable then: {names}.', { names: list(away) })}` : ''),
      fix: t('Lower that day’s minimum in the Setup calendar, or ask someone to free the day.'),
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

  // Try one change at a time.
  const wouldWork: string[] = []
  const works = (c: SessionConfig, r = responses) => arrangeStudents(c, r, assignments, 1, 200).ok
  const st = config.students
  if (!auto && !quota && need > 1 && works({ ...config, students: { ...st, shiftsPerStudent: need - 1 } })) {
    wouldWork.push(t('each student doing {n} shifts instead of {m}', { n: need - 1, m: need }))
  }
  if (!auto && works({ ...config, students: { ...st, auto: true } })) wouldWork.push(t('turning on “Share equally”'))
  if (minimum > 0) {
    const noMin = { ...config, shifts: config.shifts.map((s) => ({ ...s, requirements: s.requirements.map(({ min: _m, ...r }) => r) })) }
    if (works(noMin)) wouldWork.push(t('no “at least” minimums (places may stay empty)'))
  }
  if (resp.some((r) => r.minInterval > 1)) {
    const shorter = Object.fromEntries(students.map((m, si) => [m.id, { ...resp[si], minInterval: Math.max(1, resp[si].minInterval - 1) }]))
    if (works({ ...config, students: { ...st, minGap: Math.max(0, (st.minGap ?? 0) - 1) } }, { ...responses, ...shorter })) {
      wouldWork.push(t('everyone’s gap between shifts one day shorter'))
    }
  }
  if (resp.some((r) => r.locks.length)) {
    const unlocked = Object.fromEntries(students.map((m, si) => [m.id, { ...resp[si], locks: [] }]))
    if (works(config, { ...responses, ...unlocked })) wouldWork.push(t('without the locked-in shifts'))
  }
  if (!hints.length) {
    hints.push({
      why: t('Each rule can be met on its own, but not all of them together — it’s a tight fit.'),
      fix: wouldWork.length ? t('Loosen one of the rules below.') : t('Try fewer shifts per student, lower minimums or shorter gaps, or add student places.'),
    })
  }
  return { hints, wouldWork }
}
