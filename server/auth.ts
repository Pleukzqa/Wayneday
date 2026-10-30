// Google sign-in for hosts. The browser gets an ID token from Google; the server checks it once and
// hands back its own signed account token, sent on later requests in the X-Wayneday-Account header.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'

export interface Account {
  email: string
  name: string
  picture?: string
}

const DAY_MS = 86_400_000
const TOKEN_DAYS = 60

export const normEmail = (e: string) => e.trim().toLowerCase()
export const isEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200

export function accountTokens(secret: string) {
  const sign = (body: string) => createHmac('sha256', secret).update(body).digest('base64url')
  return {
    issue(a: Account): string {
      const body = Buffer.from(JSON.stringify({ ...a, exp: Date.now() + TOKEN_DAYS * DAY_MS })).toString('base64url')
      return `${body}.${sign(body)}`
    },
    read(token: string | undefined): Account | null {
      const [body, mac] = (token ?? '').split('.')
      if (!body || !mac) return null
      const want = Buffer.from(sign(body))
      const got = Buffer.from(mac)
      if (want.length !== got.length || !timingSafeEqual(want, got)) return null
      try {
        const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as Account & { exp: number }
        if (!(p.exp > Date.now()) || !isEmail(p.email)) return null
        return { email: p.email, name: p.name, ...(p.picture ? { picture: p.picture } : {}) }
      } catch {
        return null
      }
    },
  }
}

/** A secret from SESSION_SECRET, or a random one (sign-ins then last until the server restarts). */
export function secretFromEnv(): string {
  const s = process.env.SESSION_SECRET
  if (s && s.length >= 16) return s
  if (process.env.GOOGLE_CLIENT_ID) console.warn('SESSION_SECRET is not set: hosts will have to sign in again after every restart.')
  return randomBytes(32).toString('hex')
}

export type GoogleVerify = (credential: string) => Promise<Account>

/** Checks a Google ID token: signed by Google, for this app's client ID, with a verified email. */
export function googleVerifier(clientId: string): GoogleVerify {
  const keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))
  return async (credential) => {
    const { payload } = await jwtVerify(credential, keys, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: clientId,
    })
    const email = typeof payload.email === 'string' ? normEmail(payload.email) : ''
    if (!email || payload.email_verified !== true) throw new Error('Google account email is not verified')
    return {
      email,
      name: typeof payload.name === 'string' ? payload.name : email,
      ...(typeof payload.picture === 'string' ? { picture: payload.picture } : {}),
    }
  }
}
