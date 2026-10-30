import type { SolveOptions, SolveResult } from './shared/solver.ts'
import type { MemberResponse, SessionConfig } from './shared/types.ts'

/** Run the solver off the main thread so the page stays responsive. */
export function runSolver(
  config: SessionConfig,
  responses: Record<string, MemberResponse>,
  opts: SolveOptions,
): Promise<SolveResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<SolveResult>) => {
      resolve(e.data)
      worker.terminate()
    }
    worker.onerror = (e) => {
      reject(new Error(e.message || 'Solver crashed'))
      worker.terminate()
    }
    worker.postMessage({ config, responses, opts })
  })
}
