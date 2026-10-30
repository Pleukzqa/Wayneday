// Simple in-memory rate limits (per server copy): slow down PIN guessing, code guessing and spam.

export class Limiter {
  private hits = new Map<string, { n: number; until: number }>()
  private max: number
  private windowMs: number
  constructor(max: number, windowMs: number) {
    this.max = max
    this.windowMs = windowMs
  }

  /** Count one attempt; false once `key` has used up its attempts in this window. */
  hit(key: string): boolean {
    const now = Date.now()
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.until < now) this.hits.delete(k)
    const h = this.hits.get(key)
    if (!h || h.until < now) {
      this.hits.set(key, { n: 1, until: now + this.windowMs })
      return true
    }
    h.n++
    return h.n <= this.max
  }

  /** True if `key` has used up its attempts, without counting one. */
  blocked(key: string): boolean {
    const h = this.hits.get(key)
    return Boolean(h && h.until >= Date.now() && h.n >= this.max)
  }

  reset(key: string) {
    this.hits.delete(key)
  }
}
