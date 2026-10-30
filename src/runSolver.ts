import { solve, type SolveOptions, type SolveResult } from './shared/solver.ts'
import type { MemberResponse, SessionConfig } from './shared/types.ts'

/** Run the solver off the main thread so the page stays responsive; falls back to inline if workers are unavailable. */
export function runSolver(
  config: SessionConfig,
  responses: Record<string, MemberResponse>,
  opts: SolveOptions,
): Promise<SolveResult> {
  const inline = () => new Promise<SolveResult>((resolve) => setTimeout(() => resolve(solve(config, responses, opts)), 30))
  let worker: Worker
  try {
    worker = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return inline()
  }
  return new Promise((resolve) => {
    worker.onmessage = (e: MessageEvent<SolveResult>) => {
      resolve(e.data)
      worker.terminate()
    }
    worker.onerror = () => {
      worker.terminate()
      resolve(inline())
    }
    worker.postMessage({ config, responses, opts })
  })
}
