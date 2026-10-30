// Session links use a plain "#s-<code>" hash (also accepts the older "#/s/<code>").
export const sessionHash = (code: string) => `#s-${code}`

export function codeFromHash(hash: string): string | undefined {
  return /^#(?:s-|\/s\/)([a-z]+-[a-z]+-[a-z]+)$/.exec(hash)?.[1]
}

export const IS_DEMO = import.meta.env.MODE === 'demo'
