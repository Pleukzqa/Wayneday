import { getLang } from './shared/i18n.ts'
import type { CountResult } from './shared/solver.ts'
import type { Explanation } from './shared/explain.ts'
import type { StudentOption } from './shared/students.ts'
import type { Assignment, MemberResponse, PresenterAssignment, SessionConfig, StudentAssignment } from './shared/types.ts'
import type { WorkerRequest } from './solver.worker.ts'

/** Run solver work off the main thread; falls back to running inline where workers are unavailable. */
function run<T>(req: WorkerRequest): Promise<T> {
  const inline = () =>
    new Promise<T>((resolve) => setTimeout(() => void import('./solver.worker.ts').then((m) => resolve(m.handle(req) as T)), 30))
  let worker: Worker
  try {
    worker = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return inline()
  }
  return new Promise((resolve) => {
    worker.onmessage = (e: MessageEvent<T>) => {
      resolve(e.data)
      worker.terminate()
    }
    worker.onerror = () => {
      worker.terminate()
      resolve(inline())
    }
    worker.postMessage(req)
  })
}

export type ManyResult = {
  result: { ok: true; alternatives: StudentOption[] } | { ok: false; problems: string[] }
  count: CountResult | null
  /** Hospital mode, when nothing fits: why, and what to change. */
  explain?: Explanation | null
}

export const findArrangements = (config: SessionConfig, responses: Record<string, MemberResponse>, seed: number, count = 6) =>
  run<ManyResult>({ kind: 'many', lang: getLang(), config, responses, opts: { seed, count } })

export type StudentsResult =
  | { ok: true; students: StudentAssignment[]; presenters: PresenterAssignment[]; warnings: string[] }
  | { ok: false; problems: string[] }

export const rearrangeStudents = (config: SessionConfig, responses: Record<string, MemberResponse>, assignments: Assignment[], seed: number) =>
  run<StudentsResult>({ kind: 'students', lang: getLang(), config, responses, assignments, seed })
