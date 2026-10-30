import { solve, type SolveOptions } from './shared/solver.ts'
import type { MemberResponse, SessionConfig } from './shared/types.ts'

self.onmessage = (e: MessageEvent<{ config: SessionConfig; responses: Record<string, MemberResponse>; opts: SolveOptions }>) => {
  const { config, responses, opts } = e.data
  ;(self as unknown as Worker).postMessage(solve(config, responses, opts))
}
