import { useMemo, useState, type FormEvent } from 'react'
import { forgetMember, setTokens, api } from '../api.ts'
import { invitedMemberFromHash, IS_DEMO, sessionHash } from '../routes.ts'
import { shortDate } from '../shared/dates.ts'
import { t } from '../shared/i18n.ts'
import type { Organizer } from '../apiTypes.ts'
import type { HostNote } from '../shared/types.ts'
import type { MemberType } from '../shared/types.ts'
import { useSession } from '../useSession.ts'
import SetupTab from '../components/SetupTab.tsx'
import AvailabilityTab from '../components/AvailabilityTab.tsx'
import RosterTab from '../components/RosterTab.tsx'
import type { SessionProps } from '../components/props.ts'
import { HostsCard, HostSignIn } from '../components/Hosts.tsx'
import { googleClientId } from '../google.ts'
import { rosterAlerts } from '../shared/students.ts'

type Tab = 'setup' | 'availability' | 'roster'

export default function SessionPage({ code }: { code: string }) {
  const { view, error, mutate, refresh } = useSession(code)
  const [tab, setTab] = useState<Tab | null>(null)
  const [hostLogin, setHostLogin] = useState(false)
  // Hosts: how many rules the published roster breaks, on the Roster tab.
  const broken = useMemo(() => {
    const s = view?.session
    if (!view?.me.isHost || !s?.schedule || !s.config.members.some((m) => m.type === 'student')) return 0
    return rosterAlerts(s.config, s.responses, s.schedule).filter((a) => a.level === 'rule').length
  }, [view])

  if (!view) {
    return <p className={error ? 'error' : 'muted'}>{error ?? t("Loading session…")}</p>;
  }
  const { session, me, hosts, organizers = [] } = view
  const google = !IS_DEMO && Boolean(googleClientId())
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
            {session.config.startDate}→ {session.config.endDate}· {session.config.members.length} {t("people ·")}{' '}
            {statusText(session)}
          </p>
          <Organizers list={organizers} />
        </div>
        <div className="who">
          {me.isHost && <span className="badge host">{me.hostRole === 'cohost' ? t('Co-host') : t('Host')}</span>}
          {IS_DEMO ? null : myName ? (
            <>
              <span className="badge">{t("Logged in as")} {myName}</span>
              <button
                className="link"
                onClick={() => {
                  forgetMember(code)
                  void refresh()
                }}
              >{t("Log out")}</button>
            </>
          ) : null}
          {!IS_DEMO && <span className="code-pill session-code">{code}</span>}
          {!IS_DEMO && <ShareButton code={code} />}
        </div>
      </div>
      {!IS_DEMO && !me.memberId && (session.config.members.length > 0 || me.pendingJoinId) &&
        (me.isHost && !hostLogin && !me.pendingJoinId ? (
          <button className="link host-login" onClick={() => setHostLogin(true)}>{t("I’m also on this roster — log in as myself")}</button>
        ) : (
          <LoginCard {...props} onDone={() => void refresh()} />
        ))}
      {error && <p className="error small">{t("Connection problem:")} {error}</p>}
      <Announcements session={session} me={me} go={setTab} />
      {me.memberId && <MemberNotes notes={session.notes.filter((n) => n.memberId === me.memberId)} read={(id) => void mutate(() => api.readNote(code, id))} />}
      <nav className="tabs" role="tablist">
        {(
          [
            ['setup', `⚙️ ${t('Setup')}`],
            ['availability', `🗓️ ${t('Availability')}`],
            ['roster', `📋 ${t('Roster')}`],
          ] as const
        ).map(([key, text]) => (
          <button key={key} role="tab" aria-selected={current === key} className={current === key ? 'tab active' : 'tab'} onClick={() => setTab(key)}>
            {text}
            {key === 'roster' && broken > 0 && (
              <span className="badge warn" title={t('{n} rule(s) the published roster breaks', { n: broken })}>
                🚨 {broken}
              </span>
            )}
          </button>
        ))}
      </nav>
      {me.isHost && <NextSteps session={session} go={setTab} />}
      {current === 'setup' && google && me.isHost && <HostsCard code={code} me={me} mutate={mutate} hosts={hosts ?? []} />}
      {current === 'setup' && <SetupTab {...props} />}
      {current === 'availability' && <AvailabilityTab {...props} />}
      {current === 'roster' && <RosterTab {...props} />}
      {google && <HostSignIn isHost={me.isHost} />}
    </div>
  );
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
  const items: { key: string; text: string; tab: Tab; action: string; target?: string; icon?: string }[] = []
  if (me.memberId && session.schedule?.status === 'final' && !session.feedback.some((f) => f.memberId === me.memberId)) {
    items.push({ key: 'feedback', icon: '⭐', text: t('The roster is final — tell the host how it went'), tab: 'roster', action: t('Give feedback'), target: 'feedback' })
  }
  for (const s of open.slice(0, 3)) {
    items.push({
      key: s.id,
      text: `${t('{who} asked to swap {date} {shift}', { who: s.memberId === me.memberId ? t('You') : name(s.memberId), date: shortDate(s.date), shift: shift(s.shiftId) })}${s.offers.length ? ` · ${t('{n} offer(s)', { n: s.offers.length })}` : ''}`,
      tab: 'roster',
      action: s.memberId === me.memberId ? t('See offers') : t('Offer'),
    })
  }
  if (open.length > 3) items.push({ key: 'more', text: t('+{n} more swap requests', { n: open.length - 3 }), tab: 'roster', action: t('View') })
  if (me.isHost && agreed.length) {
    items.push({ key: 'agreed', text: t('{n} swap(s) agreed and waiting for your approval', { n: agreed.length }), tab: 'roster', action: t('Review') })
  }
  if (me.isHost && joins.length) items.push({ key: 'joins', text: t('{names} asked to join', { names: joins.map((j) => j.name).join(', ') }), tab: 'setup', action: t('Review') })
  if (!items.length) return null
  return (
    <ul className="announce" aria-label={t("Announcements")}>
      {items.map((i) => (
        <li key={i.key}>
          <span aria-hidden>{i.icon ?? '⇄'}</span> <span>{i.text}</span>{' '}
          <button
            className="link"
            onClick={() => {
              go(i.tab)
              setTimeout(() => document.getElementById(i.target ?? (i.tab === 'roster' ? 'swaps' : 'root'))?.scrollIntoView({ behavior: 'smooth' }), 50)
            }}
          >
            {i.action}
          </button>
        </li>
      ))}
    </ul>
  );
}

function statusText(s: SessionProps['session']) {
  if (!s.schedule) return `📝 ${t('collecting answers')}`
  if (s.schedule.status === 'final') return `✅ ${t('roster final')}`
  return Date.now() < s.schedule.reviewUntil ? `👀 ${t('roster in review')}` : `⏰ ${t('review period ended')}`
}

/** Notes the hosts left for me: unread ones stand out until I press "Got it"; earlier ones fold away. */
function MemberNotes({ notes, read }: { notes: HostNote[]; read: (id: string) => void }) {
  const unread = notes.filter((n) => !n.readAt)
  const seen = notes.filter((n) => n.readAt)
  if (!notes.length) return null
  const from = (n: HostNote) => `${n.role === 'owner' ? t('Host') : t('Co-host')}${n.by ? ` ${n.by}` : ''}`
  return (
    <div className="member-notes stack-tight">
      {unread.map((n) => (
        <div key={n.id} className="member-note" role="status">
          <div>
            <strong>{n.change ? `✏️ ${t('{who} changed your answers', { who: from(n) })}` : `💬 ${t('Message from {who}', { who: from(n) })}`}</strong>{' '}
            <span className="muted small">· {new Date(n.at).toLocaleString()}</span>
            {n.change && <p className="small">{n.change.summary}.</p>}
            <p className="note-text">
              {n.change && <b>{t('Why:')} </b>}
              {n.text}
            </p>
          </div>
          <button type="button" className="primary" onClick={() => read(n.id)}>
            {t('Got it')}
          </button>
        </div>
      ))}
      {seen.length > 0 && (
        <details className="small">
          <summary className="muted">{t('Earlier messages from the hosts ({n})', { n: seen.length })}</summary>
          <ul>
            {[...seen].reverse().map((n) => (
              <li key={n.id}>
                <span className="muted">{new Date(n.at).toLocaleString()} · {from(n)}:</span> {n.change ? `${n.change.summary} — ${n.text}` : n.text}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

/** Who runs this roster, for everyone: the host (owner) and co-hosts, by name. */
function Organizers({ list }: { list: Organizer[] }) {
  if (!list.length) return null
  const names = (xs: Organizer[]) => {
    const named = xs.filter((x) => x.name).map((x) => x.name)
    const more = xs.length - named.length
    return [...named, ...(more ? [named.length ? t('+{n} more', { n: more }) : String(more)] : [])].join(', ')
  }
  const owner = list.filter((o) => o.role === 'owner')
  const cohosts = list.filter((o) => o.role === 'cohost')
  return (
    <p className="small organizers">
      {owner.length > 0 && (
        <span>
          👑 {t('Host')}: <b>{names(owner)}</b>
        </span>
      )}
      {cohosts.length > 0 && (
        <span>
          🤝 {t('Co-host')}: <b>{names(cohosts)}</b>
        </span>
      )}
    </p>
  )
}

/** The host's checklist: what's done and what to do next, each step one tap away. */
function NextSteps({ session, go }: { session: SessionProps['session']; go: (t: Tab) => void }) {
  const [open, setOpen] = useState(true)
  const c = session.config
  const hospital = c.rosterMode === 'hospital'
  const students = c.members.filter((m) => m.type === 'student')
  const answering = hospital ? students : c.members
  const ready = answering.filter((m) => session.responses[m.id]?.ready).length
  const dutyDays = new Set(c.duty.map((a) => a.date)).size
  const steps: { done: boolean; text: string; tab: Tab }[] = [
    { done: c.shifts.length > 0 && c.shifts.some((s) => s.requirements.length), text: t('Set the period and shift slots'), tab: 'setup' },
    ...(hospital
      ? [
          {
            done: dutyDays > 0 || Boolean(c.noDuty),
            text: c.noDuty ? t('Hospital roster: left blank') : t('Enter the hospital roster ({n} days so far)', { n: dutyDays }),
            tab: 'setup' as Tab,
          },
        ]
      : []),
    { done: answering.length > 0, text: hospital ? t('Add students ({n})', { n: students.length }) : t('Add people ({n})', { n: c.members.length }), tab: 'setup' },
    { done: answering.length > 0 && ready === answering.length, text: t('Everyone fills in availability and presses “I’m ready!” ({a}/{n} ready)', { a: ready, n: answering.length }), tab: 'availability' },
    { done: Boolean(session.schedule), text: t('Find arrangements and publish for review'), tab: 'roster' },
    { done: session.schedule?.status === 'final', text: t('Handle concerns and swaps, then finalize'), tab: 'roster' },
  ]
  const next = steps.findIndex((s) => !s.done)
  if (next === -1 && !open) return null
  return (
    <details className="next-steps" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        🧭 {t('Next steps')} <span className="muted small">{steps.filter((s) => s.done).length}/{steps.length}</span>
      </summary>
      <ol>
        {steps.map((s, i) => (
          <li key={s.text} className={s.done ? 'done' : i === next ? 'now' : ''}>
            <span aria-hidden>{s.done ? '✅' : i === next ? '👉' : '⬜'}</span>
            <button className="link" onClick={() => go(s.tab)}>
              {s.text}
            </button>
          </li>
        ))}
      </ol>
    </details>
  )
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
            await navigator.clipboard.writeText(t('Join "{code}" on Wayneday: {url}', { code, url }))
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          } catch {
            setShow(true)
          }
        }}
      >
        {copied ? t("Copied!") : t("Copy invite")}
      </button>
      {show && <input readOnly className="invite-url" value={url} onFocus={(e) => e.target.select()} autoFocus />}
    </>
  );
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
        <strong>{t("Waiting for the host")}</strong>
        <span className="small">{t("You asked to join as")} {req?.name ?? t("a new person")}{t(". You’ll be logged in here as soon as the host approves.")}</span>
        <button
          className="link"
          onClick={() => {
            forgetMember(code)
            onDone()
          }}
        >{t("Cancel")}</button>
      </div>
    );
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
      aria-label={t("PIN")}
      placeholder={mode === 'claim' && claimed ? t('Your PIN') : t('Choose a 4–8 digit PIN')}
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
        <strong>{t("Ask to join")}</strong>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Your name")} aria-label={t("Your name")} required />
        <select value={type} onChange={(e) => setType(e.target.value as MemberType)} aria-label={t("I am a")}>
          <option value="resident">{t("Resident")}</option>
          <option value="staff">{t("Staff")}</option>
          <option value="student">{t("Student")}</option>
        </select>
        {pinInput}
        <button className="primary" disabled={busy}>{t("📨 Send request")}</button>
        <button type="button" className="link" onClick={() => setMode('claim')}>{t("Back")}</button>
        {error && <span className="error small">{error}</span>}
      </form>
    );
  }

  return (
    <form
      className="card login"
      onSubmit={run(async () => {
        const r = await api.claim(code, memberId, pin)
        setTokens(code, { memberToken: r.memberToken })
      })}
    >
      <strong>{t("Who are you?")}</strong>
      <select value={memberId} onChange={(e) => setMemberId(e.target.value)} required aria-label={t("Your name")}>
        <option value="">{t("Choose your name…")}</option>
        {session.config.members
          // Hospital mode: residents and staff only appear in the hospital's roster; students are the ones who log in.
          .filter((m) => session.config.rosterMode !== 'hospital' || m.type === 'student')
          .map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} {session.claimed.includes(m.id) ? t("(has PIN)") : ''}
            </option>
          ))}
      </select>
      {pinInput}
      <button className="primary" disabled={busy || !memberId}>
        {claimed ? t("Log in") : t("Claim & log in")}
      </button>
      <button type="button" className="link" onClick={() => setMode('join')}>{t("I’m not on the list")}</button>
      {error && <span className="error small">{error}</span>}
    </form>
  );
}
