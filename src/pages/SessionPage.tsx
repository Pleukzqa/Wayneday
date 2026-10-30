import { useState, type FormEvent } from 'react'
import { forgetMember, setTokens, api } from '../api.ts'
import { invitedMemberFromHash, IS_DEMO, sessionHash } from '../routes.ts'
import { shortDate } from '../shared/dates.ts'
import type { MemberType } from '../shared/types.ts'
import { useSession } from '../useSession.ts'
import SetupTab from '../components/SetupTab.tsx'
import AvailabilityTab from '../components/AvailabilityTab.tsx'
import RosterTab from '../components/RosterTab.tsx'
import type { SessionProps } from '../components/props.ts'

type Tab = 'setup' | 'availability' | 'roster'

export default function SessionPage({ code }: { code: string }) {
  const { view, error, mutate, refresh } = useSession(code)
  const [tab, setTab] = useState<Tab | null>(null)
  const [hostLogin, setHostLogin] = useState(false)

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
          {IS_DEMO ? null : myName ? (
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
          {!IS_DEMO && <ShareButton code={code} />}
        </div>
      </div>

      {!IS_DEMO && !me.memberId && (session.config.members.length > 0 || me.pendingJoinId) &&
        (me.isHost && !hostLogin && !me.pendingJoinId ? (
          <button className="link host-login" onClick={() => setHostLogin(true)}>
            I’m also on this roster — log in as myself
          </button>
        ) : (
          <LoginCard {...props} onDone={() => void refresh()} />
        ))}
      {error && <p className="error small">Connection problem: {error}</p>}
      <Announcements session={session} me={me} go={setTab} />

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

function Announcements({ session, me, go }: { session: SessionProps['session']; me: SessionProps['me']; go: (t: Tab) => void }) {
  const name = (id: string) => session.config.members.find((m) => m.id === id)?.name ?? '?'
  const shift = (id: string) => session.config.shifts.find((s) => s.id === id)?.name ?? ''
  const open = session.swaps.filter((s) => s.status === 'open')
  const agreed = session.swaps.filter((s) => s.status === 'agreed')
  const joins = session.joinRequests.filter((r) => r.status === 'pending')
  const items: { key: string; text: string; tab: Tab; action: string }[] = []
  for (const s of open.slice(0, 3)) {
    items.push({
      key: s.id,
      text: `${s.memberId === me.memberId ? 'You' : name(s.memberId)} asked to swap ${shortDate(s.date)} ${shift(s.shiftId)}${s.offers.length ? ` · ${s.offers.length} offer(s)` : ''}`,
      tab: 'roster',
      action: s.memberId === me.memberId ? 'See offers' : 'Offer',
    })
  }
  if (open.length > 3) items.push({ key: 'more', text: `+${open.length - 3} more swap requests`, tab: 'roster', action: 'View' })
  if (me.isHost && agreed.length) items.push({ key: 'agreed', text: `${agreed.length} swap(s) agreed and waiting for your approval`, tab: 'roster', action: 'Review' })
  if (me.isHost && joins.length) items.push({ key: 'joins', text: `${joins.map((j) => j.name).join(', ')} asked to join`, tab: 'setup', action: 'Review' })
  if (!items.length) return null
  return (
    <ul className="announce" aria-label="Announcements">
      {items.map((i) => (
        <li key={i.key}>
          <span aria-hidden>⇄</span> <span>{i.text}</span>{' '}
          <button
            className="link"
            onClick={() => {
              go(i.tab)
              setTimeout(() => document.getElementById(i.tab === 'roster' ? 'swaps' : 'root')?.scrollIntoView({ behavior: 'smooth' }), 50)
            }}
          >
            {i.action}
          </button>
        </li>
      ))}
    </ul>
  )
}

function statusText(s: SessionProps['session']) {
  if (!s.schedule) return 'collecting answers'
  if (s.schedule.status === 'final') return 'roster final'
  return Date.now() < s.schedule.reviewUntil ? 'roster in review' : 'review period ended'
}

function ShareButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  const url = `${location.origin}${location.pathname}${sessionHash(code)}`
  const [show, setShow] = useState(false)
  return (
    <>
      <button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(`Join "${code}" on Wayneday: ${url}`)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          } catch {
            setShow(true)
          }
        }}
      >
        {copied ? 'Copied!' : 'Copy invite'}
      </button>
      {show && <input readOnly className="invite-url" value={url} onFocus={(e) => e.target.select()} autoFocus />}
    </>
  )
}

function LoginCard({ code, session, me, onDone }: SessionProps & { onDone: () => void }) {
  const invited = invitedMemberFromHash(location.hash)
  const [memberId, setMemberId] = useState(invited && session.config.members.some((m) => m.id === invited) ? invited : '')
  const [mode, setMode] = useState<'claim' | 'join'>('claim')
  const [name, setName] = useState('')
  const [type, setType] = useState<MemberType>(session.config.rosterMode === 'hospital' ? 'student' : 'resident')
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const claimed = session.claimed.includes(memberId)

  if (me.pendingJoinId) {
    const req = session.joinRequests.find((r) => r.id === me.pendingJoinId)
    return (
      <div className="card login">
        <strong>Waiting for the host</strong>
        <span className="small">
          You asked to join as {req?.name ?? 'a new person'}. You’ll be logged in here as soon as the host approves.
        </span>
        <button
          className="link"
          onClick={() => {
            forgetMember(code)
            onDone()
          }}
        >
          Cancel
        </button>
      </div>
    )
  }

  const run = (fn: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await fn()
      onDone()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const pinInput = (
    <input
      inputMode="numeric"
      pattern="\d{4,8}"
      aria-label="PIN"
      placeholder={mode === 'claim' && claimed ? 'Your PIN' : 'Choose a 4–8 digit PIN'}
      value={pin}
      onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
      required
    />
  )

  if (mode === 'join') {
    return (
      <form
        className="card login"
        onSubmit={run(async () => {
          const r = await api.requestJoin(code, name, type, pin)
          setTokens(code, { requestToken: r.requestToken })
        })}
      >
        <strong>Ask to join</strong>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" aria-label="Your name" required />
        <select value={type} onChange={(e) => setType(e.target.value as MemberType)} aria-label="I am a">
          <option value="resident">Resident</option>
          <option value="staff">Staff</option>
          <option value="student">Student</option>
        </select>
        {pinInput}
        <button className="primary" disabled={busy}>
          Send request
        </button>
        <button type="button" className="link" onClick={() => setMode('claim')}>
          Back
        </button>
        {error && <span className="error small">{error}</span>}
      </form>
    )
  }

  return (
    <form
      className="card login"
      onSubmit={run(async () => {
        const r = await api.claim(code, memberId, pin)
        setTokens(code, { memberToken: r.memberToken })
      })}
    >
      <strong>Who are you?</strong>
      <select value={memberId} onChange={(e) => setMemberId(e.target.value)} required aria-label="Your name">
        <option value="">Choose your name…</option>
        {session.config.members
          // Hospital mode: residents and staff only appear in the hospital's roster; students are the ones who log in.
          .filter((m) => session.config.rosterMode !== 'hospital' || m.type === 'student')
          .map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} {session.claimed.includes(m.id) ? '(has PIN)' : ''}
            </option>
          ))}
      </select>
      {pinInput}
      <button className="primary" disabled={busy || !memberId}>
        {claimed ? 'Log in' : 'Claim & log in'}
      </button>
      <button type="button" className="link" onClick={() => setMode('join')}>
        I’m not on the list
      </button>
      {error && <span className="error small">{error}</span>}
    </form>
  )
}
