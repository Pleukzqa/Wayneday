// Shift swaps: a member asks, the group sees it, others offer to take it or trade, the asker accepts, the host approves.
import { useState } from 'react'
import { api } from '../api.ts'
import { shortDate } from '../shared/dates.ts'
import { validate } from '../shared/solver.ts'
import { applySwapPreview } from '../shared/ops.ts'
import type { Assignment } from '../shared/types.ts'
import type { SessionProps } from './props.ts'

export interface SwapDraft {
  date: string
  shiftId: string
  requirementId: string
}

export default function Swaps({ code, session, me, mutate, draft, clearDraft }: SessionProps & { draft: SwapDraft | null; clearDraft: () => void }) {
  const { config, schedule } = session
  const [note, setNote] = useState('')
  const [give, setGive] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  if (!schedule) return null
  const name = (id: string) => config.members.find((m) => m.id === id)?.name ?? '?'
  const shiftName = (id: string) => config.shifts.find((s) => s.id === id)?.name ?? '?'
  const label = (x: { date: string; shiftId: string }) => `${shortDate(x.date)} · ${shiftName(x.shiftId)}`
  const mine = me.memberId ? schedule.assignments.filter((a) => a.memberId === me.memberId).sort((a, b) => a.date.localeCompare(b.date)) : []
  const key = (a: Pick<Assignment, 'date' | 'shiftId' | 'requirementId'>) => `${a.date}|${a.shiftId}|${a.requirementId}`
  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const live = session.swaps.filter((s) => s.status === 'open' || s.status === 'agreed').sort((a, b) => b.createdAt - a.createdAt)
  const closed = session.swaps.filter((s) => !(s.status === 'open' || s.status === 'agreed')).sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))

  return (
    <section className="card" id="swaps">
      <h2>
        Shift swaps {live.length > 0 && <span className="badge warn">{live.length} open</span>}
      </h2>
      {me.memberId && (
        <form
          className="row wrap align-end"
          onSubmit={(e) => {
            e.preventDefault()
            const d = draft ?? (give.request ? parseKey(give.request) : null)
            if (!d) return
            void act(async () => {
              await mutate(() => api.requestSwap(code, { ...d, note }))
              setNote('')
              clearDraft()
              setGive((g) => ({ ...g, request: '' }))
            })
          }}
        >
          <label>
            Ask to swap my
            <select
              value={draft ? key(draft) : (give.request ?? '')}
              onChange={(e) => {
                clearDraft()
                setGive((g) => ({ ...g, request: e.target.value }))
              }}
            >
              <option value="">choose a shift…</option>
              {mine.map((a) => (
                <option key={key(a)} value={key(a)}>
                  {label(a)}
                </option>
              ))}
            </select>
          </label>
          <label className="grow">
            Note <span className="muted small">(optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. family wedding" />
          </label>
          <button className="primary" disabled={!draft && !give.request}>
            Announce
          </button>
        </form>
      )}
      {error && <p className="error small">{error}</p>}
      {live.length === 0 && <p className="muted small">No open swap requests.</p>}
      <ul className="swaps">
        {live.map((s) => {
          const isMine = s.memberId === me.memberId
          const myOffer = s.offers.find((o) => o.memberId === me.memberId)
          const accepted = s.offers.find((o) => o.id === s.acceptedOfferId)
          const preview = accepted ? validate(config, session.responses, applySwapPreview(schedule, s, accepted.id)) : []
          return (
            <li key={s.id} className={`swap ${s.status}`}>
              <div>
                <strong>{name(s.memberId)}</strong> wants to swap <strong>{label(s)}</strong>
                {s.note && <span className="muted"> — “{s.note}”</span>}
              </div>
              {s.status === 'agreed' && accepted ? (
                <p className="small">
                  Agreed with <strong>{name(accepted.memberId)}</strong>
                  {accepted.give ? ` (they give ${label(accepted.give)})` : ' (they take it)'} · waiting for the host.
                </p>
              ) : (
                <ul className="offers">
                  {s.offers.length === 0 && <li className="muted small">No offers yet.</li>}
                  {s.offers.map((o) => (
                    <li key={o.id} className="small row wrap">
                      <span>
                        {name(o.memberId)} {o.give ? `offers ${label(o.give)} in exchange` : 'will take it'}
                      </span>
                      {isMine && (
                        <button onClick={() => void act(() => mutate(() => api.actOnSwap(code, s.id, { action: 'accept', offerId: o.id })))}>
                          Accept
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className="row wrap">
                {!isMine && me.memberId && s.status === 'open' && (
                  <>
                    <select
                      aria-label="Offer"
                      value={give[s.id] ?? ''}
                      onChange={(e) => setGive((g) => ({ ...g, [s.id]: e.target.value }))}
                    >
                      <option value="">I’ll take it</option>
                      {mine.map((a) => (
                        <option key={key(a)} value={key(a)}>
                          Trade for my {label(a)}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() =>
                        void act(() =>
                          mutate(() => api.actOnSwap(code, s.id, { action: 'offer', ...(give[s.id] ? { give: parseKey(give[s.id]) } : {}) })),
                        )
                      }
                    >
                      {myOffer ? 'Update offer' : 'Offer'}
                    </button>
                    {myOffer && (
                      <button className="link" onClick={() => void act(() => mutate(() => api.actOnSwap(code, s.id, { action: 'withdraw' })))}>
                        Withdraw offer
                      </button>
                    )}
                  </>
                )}
                {me.isHost && s.status === 'agreed' && (
                  <>
                    <button className="primary" onClick={() => void act(() => mutate(() => api.actOnSwap(code, s.id, { action: 'approve' })))}>
                      Approve swap
                    </button>
                    <button onClick={() => void act(() => mutate(() => api.actOnSwap(code, s.id, { action: 'decline' })))}>Decline</button>
                  </>
                )}
                {(isMine || me.isHost) && (
                  <button className="link" onClick={() => void act(() => mutate(() => api.actOnSwap(code, s.id, { action: 'cancel' })))}>
                    Cancel request
                  </button>
                )}
              </div>
              {me.isHost && s.status === 'agreed' && preview.length > 0 && (
                <div className="alert warn small">
                  After this swap: {preview.slice(0, 4).join(' ')}
                  {preview.length > 4 ? ` …and ${preview.length - 4} more.` : ''}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {closed.length > 0 && (
        <details className="history">
          <summary className="small">Past requests ({closed.length})</summary>
          <ul>
            {closed.slice(0, 20).map((s) => (
              <li key={s.id} className="small">
                {name(s.memberId)} · {label(s)} · <strong>{s.status}</strong>
                {s.status === 'approved' && s.acceptedOfferId ? ` with ${name(s.offers.find((o) => o.id === s.acceptedOfferId)?.memberId ?? '')}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

function parseKey(k: string) {
  const [date, shiftId, requirementId] = k.split('|')
  return { date, shiftId, requirementId }
}
