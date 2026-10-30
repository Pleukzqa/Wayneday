// Who runs this session: the owner and co-hosts (Google accounts).
import { useState, type FormEvent } from 'react'
import { useAccount } from '../account.ts'
import { api, type HostInfo } from '../api.ts'
import { t } from '../shared/i18n.ts'
import ConfirmButton from './ConfirmButton.tsx'
import { GoogleButton } from './GoogleButton.tsx'
import type { SessionProps } from './props.ts'

export function HostsCard({ code, me, mutate, hosts }: Pick<SessionProps, 'code' | 'me' | 'mutate'> & { hosts: HostInfo[] }) {
  const account = useAccount()
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const owner = me.hostRole === 'owner'

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    if (await run(() => mutate(() => api.setHost(code, 'add', email.trim())))) setEmail('')
  }

  return (
    <section className="card hosts">
      <h2>👑 {t('Hosts')}</h2>
      {hosts.length === 0 ? (
        <>
          <p className="muted small">{t('Sign in with Google to keep host access on any device and to add co-hosts. Right now only this browser can run the session.')}</p>
          {!account && <GoogleButton />}
        </>
      ) : (
        <>
          <ul className="host-list">
            {hosts.map((h) => (
              <li key={h.email}>
                <span>
                  <strong>{h.name !== h.email ? h.name : h.email}</strong>
                  {h.name !== h.email && <span className="muted small"> {h.email}</span>}
                </span>
                <span className={`badge ${h.role === 'owner' ? 'host' : ''}`}>{h.role === 'owner' ? t('Owner') : t('Co-host')}</span>
                {h.role === 'cohost' && (owner || h.email === account?.email) && (
                  <ConfirmButton className="link" disabled={busy} onConfirm={() => void run(() => mutate(() => api.setHost(code, 'remove', h.email)))}>
                    {h.email === account?.email ? t('Leave') : t('Remove')}
                  </ConfirmButton>
                )}
              </li>
            ))}
          </ul>
          {owner && (
            <form className="row wrap align-end" onSubmit={add}>
              <label className="grow">
                {t('Co-host’s Google email')}
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@gmail.com" autoCapitalize="none" />
              </label>
              <button disabled={busy || !email.trim()}>➕ {t('Add co-host')}</button>
            </form>
          )}
          <p className="muted small">
            {t('Co-hosts can do everything the owner can except manage hosts. Send them this session’s link; they sign in with Google using that email.')}
          </p>
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  )
}

/** For visitors who aren't hosts here: a way in for hosts and co-hosts on a new device. */
export function HostSignIn({ isHost }: { isHost: boolean }) {
  const account = useAccount()
  if (isHost) return null
  if (account) return <p className="muted small host-signin">{t('Signed in as {email}, which isn’t a host of this session.', { email: account.email })}</p>
  return (
    <details className="host-signin">
      <summary className="small">🧑‍✈️ {t('Host or co-host? Sign in with Google')}</summary>
      <GoogleButton />
    </details>
  )
}
