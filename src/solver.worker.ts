import { countArrangements, solveMany, type SolveOptions } from './shared/solver.ts'
import { arrangeStudents, pickPresenters } from './shared/students.ts'
import type { Assignment, MemberResponse, SessionConfig } from './shared/types.ts'

export type WorkerRequest =
  | { kind: 'many'; config: SessionConfig; responses: Record<string, MemberResponse>; opts: SolveOptions & { count?: number } }
  | { kind: 'students'; config: SessionConfig; responses: Record<string, MemberResponse>; assignments: Assignment[]; seed: number }

export function handle(req: WorkerRequest) {
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
