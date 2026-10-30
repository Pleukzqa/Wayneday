// Google Identity Services: the "Sign in with Google" button for hosts, and access tokens for Drive and
// Calendar exports. The client ID comes from the server at start-up (GOOGLE_CLIENT_ID).

import { api } from './api.ts'
import { setAccount } from './account.ts'

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
            callback: (r: { access_token?: string; error?: string }) => void
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

const tokens = new Map<string, string>()
/** An access token for a Google API scope (asks the user the first time). */
export async function googleToken(scope: string): Promise<string> {
  if (!clientId) throw new Error('Google isn’t set up on this server (GOOGLE_CLIENT_ID).')
  const cached = tokens.get(scope)
  if (cached) return cached
  await loadGis()
  const t = await new Promise<string>((resolve, reject) => {
    window.google!.accounts.oauth2
      .initTokenClient({
        client_id: clientId,
        scope,
        callback: (r) => (r.access_token ? resolve(r.access_token) : reject(new Error(r.error ?? 'Google sign-in cancelled'))),
      })
      .requestAccessToken()
  })
  tokens.set(scope, t)
  return t
}
