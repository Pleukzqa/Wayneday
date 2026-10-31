// Scoring helpers shared by the roster solver and the student arranger.
import { DEFAULT_RESPONSE, type MemberResponse } from './types.ts'

export function responseFor(responses: Record<string, MemberResponse>, memberId: string): MemberResponse {
  const r = responses[memberId]
  return r ? { ...DEFAULT_RESPONSE, ...r, minInterval: Math.max(1, Math.floor(r.minInterval || 1)) } : DEFAULT_RESPONSE
}

export function rng(seed: number) {
  let a = seed >>> 0 || 1
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function variance(xs: number[], caps?: number[]) {
  if (xs.length < 2) return 0
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  return xs.reduce((a, x, i) => {
    // Someone capped below the mean isn't "unfair" for sitting at their cap.
    const target = caps && caps[i] < mean ? caps[i] : mean
    return a + (x - target) ** 2
  }, 0) / xs.length
}

// Distributed is scored quadratically with weight 40, dense linearly with 30: dense people get clustered
// without squeezing the people who asked for spread-out shifts (distributed takes priority).
const DISTRIBUTED_WEIGHT = 40
const DENSE_WEIGHT = 30

/** How far one person's sorted shift days are from their spread-out / grouped preference. */
export function preferenceCost(d: number[], n: number, r: MemberResponse): number {
  if (d.length < 2) return 0
  const ideal = n / d.length
  if (r.preference === 'distributed') {
    // Even spacing across the whole period.
    const gaps = [d[0] + 1, ...d.slice(1).map((x, i) => x - d[i]), n - d[d.length - 1]]
    let c = 0
    gaps.forEach((g, i) => {
      const w = i === 0 || i === gaps.length - 1 ? 0.5 : 1
      c += w * ((ideal - g) / ideal) ** 2
    })
    return DISTRIBUTED_WEIGHT * c
  }
  // Clustered, as close to the member's minimum interval as possible.
  let c = 0
  for (let i = 1; i < d.length; i++) c += Math.abs(d[i] - d[i - 1] - r.minInterval) / ideal
  return DENSE_WEIGHT * c
}

/**
 * Items sorted by a key worked out once each. (A comparator that draws random numbers gives different
 * orders in different JavaScript engines, so the same seed would give different rosters.)
 */
export function sortedBy<T>(items: T[], key: (x: T) => number): T[] {
  return items
    .map((x, i) => ({ x, i, k: key(x) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((e) => e.x)
}

/** A shuffled copy (Fisher–Yates), the same for the same random numbers everywhere. */
export function shuffled<T>(items: T[], rand: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
