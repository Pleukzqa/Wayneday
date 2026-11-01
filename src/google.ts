// Google Identity Services: the "Sign in with Google" button for hosts, and access tokens for Drive and
// Calendar exports. The client ID comes from the server at start-up (GOOGLE_CLIENT_ID).

import { api } from './api.ts'
import { setAccount } from './account.ts'
import { t } from './shared/i18n.ts'

interface TokenClient {
  requestAccessToken(): void
}
export interface GoogleButtonOptions {
  theme?: 'outline' | 'filled_blue'
  size?: 'large' | 'medium'
  text?: 'signin_with' | 'continue_with'
  shape?: 'pill' | 'rectangular'
  locale?: string
  width?: number
}
declare global {
  interface Window {
    claude?: { use(name: string): Promise<unknown> }
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(o: {
            client_id: string
            scope: string
            callback: (r: { access_token?: string; expires_in?: number | string; error?: string; error_description?: string }) => void
            /** The window couldn't open (blocked) or was closed before allowing. */
            error_callback?: (e: { type: string; message?: string }) => void
          }): TokenClient
        }
        id: {
          initialize(o: { client_id: string; callback: (r: { credential: string }) => void; auto_select?: boolean }): void
          renderButton(el: HTMLElement, o: GoogleButtonOptions): void
          disableAutoSelect(): void
        }
      }
    }
  }
}

let clientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? ''
export const googleClientId = () => clientId

/** Ask the server which Google client to use. Without one, Google features stay hidden. */
export async function loadServerConfig() {
  try {
    const c = await api.config()
    if (c.googleClientId) clientId = c.googleClientId
  } catch {
    // Offline or an old server: carry on without Google.
  }
}

let gis: Promise<void> | null = null
export function loadGis(): Promise<void> {
  if (window.google?.accounts) return Promise.resolve()
  gis ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.onload = () => resolve()
    s.onerror = () => {
      gis = null
      reject(new Error('Could not load Google sign-in'))
    }
    document.head.appendChild(s)
  })
  return gis
}

let initialized = false
let reportError: ((message: string) => void) | null = null

/** Draw Google's sign-in button into `el`; signing in stores the host's account. */
export async function renderSignInButton(el: HTMLElement, options: GoogleButtonOptions, onError: (message: string) => void) {
  await loadGis()
  reportError = onError
  if (!initialized) {
    window.google!.accounts.id.initialize({
      client_id: clientId,
      callback: ({ credential }) => {
        api
          .signInGoogle(credential)
          .then(setAccount)
          .catch((e: Error) => reportError?.(e.message))
      },
    })
    initialized = true
  }
  window.google!.accounts.id.renderButton(el, options)
}

export function signOut() {
  setAccount(null)
  window.google?.accounts.id.disableAutoSelect()
}

// Access tokens last about an hour: kept until a minute before they run out.
const tokens = new Map<string, { token: string; until: number }>()

/**
 * Load Google's script ahead of time, so pressing an export button opens Google's window straight away: browsers
 * block a window that opens after a wait (Safari especially), and then nothing seems to happen.
 */
export function preloadGoogle() {
  if (clientId) loadGis().catch(() => undefined)
}

/** An access token for a Google API scope (asks the user the first time, and again when it has run out). */
export async function googleToken(scope: string): Promise<string> {
  if (!clientId) throw new Error(t('Google isn’t set up on this server (GOOGLE_CLIENT_ID).'))
  const cached = tokens.get(scope)
  if (cached && cached.until > Date.now()) return cached.token
  await loadGis()
  const r = await new Promise<{ token: string; seconds: number }>((resolve, reject) => {
    window.google!.accounts.oauth2
      .initTokenClient({
        client_id: clientId,
        scope,
        callback: (x) =>
          x.access_token
            ? resolve({ token: x.access_token, seconds: Number(x.expires_in) || 3600 })
            : reject(new Error(x.error === 'access_denied' ? t('Google access wasn’t allowed.') : (x.error_description ?? x.error ?? t('Google sign-in was cancelled.')))),
        error_callback: (e) =>
          reject(
            new Error(
              e.type === 'popup_failed_to_open'
                ? t('Your browser blocked Google’s window. Allow pop-ups for this site, then press the button again.')
                : e.type === 'popup_closed'
                  ? t('Google’s window was closed before access was allowed.')
                  : (e.message ?? t('Google sign-in failed.')),
            ),
          ),
      })
      .requestAccessToken()
  })
  tokens.set(scope, { token: r.token, until: Date.now() + (r.seconds - 60) * 1000 })
  return r.token
}

/** What went wrong, in words someone can act on (e.g. the API isn't turned on in the Google Cloud project). */
async function googleError(res: Response): Promise<string> {
  let message = ''
  let reason = ''
  try {
    const j = (await res.json()) as { error?: { message?: string; status?: string; errors?: { reason?: string }[] } }
    message = j.error?.message ?? ''
    reason = j.error?.errors?.[0]?.reason ?? j.error?.status ?? ''
  } catch {
    // not JSON
  }
  if (/accessNotConfigured|SERVICE_DISABLED/.test(reason) || /has not been used in project|is disabled/.test(message)) {
    const link = message.match(/https:\/\/console\.[^\s]+/)?.[0]
    return t('This Google service isn’t turned on for Wayneday’s Google Cloud project. The owner turns it on here: {link}', {
      link: link ?? 'https://console.cloud.google.com/apis/library',
    })
  }
  if (res.status === 403 && /insufficient|scope/i.test(`${reason} ${message}`)) return t('Wayneday wasn’t given that access. Press the button again and tick every box Google shows.')
  return t('Google said {status}: {message}', { status: res.status, message: message || res.statusText })
}

/** Call a Google API with the token for `scope`; a token that has run out is replaced once. */
export async function googleFetch(scope: string, url: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const token = await googleToken(scope)
    const res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } })
    if (res.status === 401 && attempt === 0) {
      tokens.delete(scope)
      continue
    }
    if (!res.ok) throw new Error(await googleError(res))
    return res
  }
}
