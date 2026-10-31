import { countArrangements, solveMany, type SolveOptions } from './shared/solver.ts'
import { arrangeStudents, countStudentArrangements, pickPresenters, repairRoster, studentOptions } from './shared/students.ts'
import { setLang, type Lang } from './shared/i18n.ts'
import { explainNoArrangement } from './shared/explain.ts'
import { dutyOf, type Assignment, type MemberResponse, type Roster, type SessionConfig } from './shared/types.ts'

export type WorkerRequest = { lang: Lang } & (
  | { kind: 'many'; config: SessionConfig; responses: Record<string, MemberResponse>; opts: SolveOptions & { count?: number } }
  | { kind: 'students'; config: SessionConfig; responses: Record<string, MemberResponse>; assignments: Assignment[]; seed: number }
  | { kind: 'repair'; config: SessionConfig; responses: Record<string, MemberResponse>; roster: Roster }
)

export function handle(req: WorkerRequest) {
  setLang(req.lang)
  if (req.kind === 'repair') return repairRoster(req.config, req.responses, req.roster)
  if (req.kind === 'many' && req.config.rosterMode === 'hospital') {
    // Residents and staff are the hospital's; only students (and presenters) are arranged.
    const result = studentOptions(req.config, req.responses, dutyOf(req.config), req.opts)
    const count = result.ok ? countStudentArrangements(req.config, req.responses) : null
    // Nothing fits: say why and what to change.
    const explain = result.ok ? null : explainNoArrangement(req.config, req.responses, dutyOf(req.config))
    return { result, count, explain }
  }
  if (req.kind === 'many') {
    const result = solveMany(req.config, req.responses, req.opts)
    const count = result.ok ? countArrangements(req.config, req.responses) : null
    return { result, count }
  }
  const students = arrangeStudents(req.config, req.responses, req.assignments, req.seed)
  if (!students.ok) return { ok: false as const, problems: students.problems }
  const presenters = pickPresenters(req.config, req.responses, req.assignments, students.students, req.seed)
  return { ok: true as const, students: students.students, presenters: presenters.presenters, warnings: [...students.warnings, ...presenters.warnings] }
}

// Only listen when running as a worker (the inline fallback imports this module on the page).
if (typeof window === 'undefined') {
  self.onmessage = (e: MessageEvent<WorkerRequest>) => {
    ;(self as unknown as Worker).postMessage(handle(e.data))
  }
}
