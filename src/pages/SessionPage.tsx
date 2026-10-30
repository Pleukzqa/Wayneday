import { useState } from 'react'
import { forgetMember, setTokens, api } from '../api.ts'
import { useSession } from '../useSession.ts'
import SetupTab from '../components/SetupTab.tsx'
import AvailabilityTab from '../components/AvailabilityTab.tsx'
import RosterTab from '../components/RosterTab.tsx'
import type { SessionProps } from '../components/props.ts'

type Tab = 'setup' | 'availability' | 'roster'

export default function SessionPage({ code }: { code: string }) {
  const { view, error, mutate, refresh } = useSession(code)
  const [tab, setTab] = useState<Tab | null>(null)

  if (!view) {
    return <p className={error ? 'error' : 'muted'}>{error ?? 'Loading session…'}</p>
  }
  const { session, me } = view
  // Default tab comes from the state at first load only, so saving doesn't yank the user elsewhere.
  const current: Tab = tab ?? initialTab(view)
  if (tab === null) setTab(current)
  const props: SessionProps = { code, session, me, mutate }
  const myName = session.config.members.find((m) => m.id === me.memberId)?.name

  return (
    <div className="session">
      <div className="session-head">
        <div>
          <h1>{session.config.title}</h1>
          <p className="muted small">
            {session.config.startDate} → {session.config.endDate} · {session.config.members.length} people ·{' '}
            {statusText(session)}
          </p>
        </div>
        <div className="who">
          {me.isHost && <span className="badge host">Host</span>}
          {myName ? (
            <>
              <span className="badge">Logged in as {myName}</span>
              <button
                className="link"
                onClick={() => {
                  forgetMember(code)
                  void refresh()
                }}
              >
                Log out
              </button>
            </>
          ) : null}
          <ShareButton code={code} />
        </div>
      </div>

      {!me.memberId && session.config.members.length > 0 && (
        <LoginCard {...props} onDone={() => void refresh()} />
      )}
      {error && <p className="error small">Connection problem: {error}</p>}

      <nav className="tabs" role="tablist">
        {(
          [
            ['setup', me.isHost ? '1 · Setup' : 'Setup'],
            ['availability', '2 · Availability & preferences'],
            ['roster', '3 · Roster'],
          ] as const
        ).map(([t, text]) => (
          <button key={t} role="tab" aria-selected={current === t} className={current === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
            {text}
          </button>
        ))}
      </nav>

      {current === 'setup' && <SetupTab {...props} />}
      {current === 'availability' && <AvailabilityTab {...props} />}
      {current === 'roster' && <RosterTab {...props} />}
    </div>
  )
}

function initialTab(v: { session: SessionProps['session']; me: SessionProps['me'] }): Tab {
  return v.session.schedule ? 'roster' : v.me.isHost && v.session.config.members.length === 0 ? 'setup' : 'availability'
}

function statusText(s: SessionProps['session']) {
  if (!s.schedule) return 'collecting answers'
  if (s.schedule.status === 'final') return 'roster final'
  return Date.now() < s.schedule.reviewUntil ? 'roster in review' : 'review period ended'
}

function ShareButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  const url = `${location.origin}${location.pathname}#/s/${code}`
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(`Join "${code}" on Wayneday: ${url}`)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          prompt('Copy this link', url)
        }
      }}
    >
      {copied ? 'Copied!' : 'Copy invite'}
    </button>
  )
}

function LoginCard({ code, session, onDone }: SessionProps & { onDone: () => void }) {
  const [memberId, setMemberId] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const claimed = session.claimed.includes(memberId)

  return (
    <form
      className="card login"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        try {
          const r = await api.claim(code, memberId, pin)
          setTokens(code, { memberToken: r.memberToken })
          onDone()
        } catch (err) {
          setError((err as Error).message)
        } finally {
          setBusy(false)
        }
      }}
    >
      <strong>Who are you?</strong>
      <select value={memberId} onChange={(e) => setMemberId(e.target.value)} required>
        <option value="">Choose your name…</option>
        {session.config.members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} {session.claimed.includes(m.id) ? '(has PIN)' : ''}
          </option>
        ))}
      </select>
      <input
        inputMode="numeric"
        pattern="\d{4,8}"
        placeholder={claimed ? 'Your PIN' : 'Choose a 4–8 digit PIN'}
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        required
      />
      <button className="primary" disabled={busy || !memberId}>
        {claimed ? 'Log in' : 'Claim & log in'}
      </button>
      {error && <span className="error small">{error}</span>}
    </form>
  )
}
