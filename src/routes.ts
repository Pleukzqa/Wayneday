// Session links use a plain "#s-<code>" hash (also accepts the older "#/s/<code>").
export const sessionHash = (code: string) => `#s-${code}`

const SESSION_RE = /^#(?:s-|\/s\/)([a-z]+-[a-z]+-[a-z]+)(?:--([\w-]+))?$/

export function codeFromHash(hash: string): string | undefined {
  return SESSION_RE.exec(hash)?.[1]
}

/** Member id from a personal invite link (#s-<code>--<memberId>). */
export function invitedMemberFromHash(hash: string): string | undefined {
  return SESSION_RE.exec(hash)?.[2]
}

export const IS_DEMO = import.meta.env.MODE === 'demo'
