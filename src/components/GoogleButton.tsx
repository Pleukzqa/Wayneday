import { useEffect, useRef, useState } from 'react'
import { useAccount } from '../account.ts'
import { renderSignInButton, signOut } from '../google.ts'
import { getLang, t } from '../shared/i18n.ts'

/** Google's own "Sign in with Google" button. */
export function GoogleButton() {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const lang = getLang()
  useEffect(() => {
    if (!ref.current) return
    renderSignInButton(ref.current, { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', locale: lang }, setError).catch(
      (e: Error) => setError(e.message),
    )
  }, [lang])
  return (
    <div className="google-signin">
      <div ref={ref} />
      {error && <p className="error small">{error}</p>}
    </div>
  )
}

/** Signed-in host in the top bar. */
export function AccountChip() {
  const account = useAccount()
  if (!account) return null
  return (
    <details className="account">
      <summary title={account.email}>
        {account.picture ? <img src={account.picture} alt="" referrerPolicy="no-referrer" /> : <span className="avatar">{account.name.slice(0, 1)}</span>}
      </summary>
      <div className="account-menu">
        <strong>{account.name}</strong>
        <span className="muted small">{account.email}</span>
        <a href="#home">🗂️ {t('My rosters')}</a>
        <button className="link" onClick={signOut}>
          {t('Sign out')}
        </button>
      </div>
    </details>
  )
}
