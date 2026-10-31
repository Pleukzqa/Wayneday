// After the roster is final: everyone rates how it went (1–5 stars per question) and can leave a comment.
// Members see and edit their own; hosts see everyone's, with averages.
import { useState } from 'react'
import { api } from '../api.ts'
import { t } from '../shared/i18n.ts'
import { FEEDBACK_QUESTIONS, type Feedback } from '../shared/types.ts'
import type { SessionProps } from './props.ts'

export default function FeedbackCard({ code, session, me, mutate }: SessionProps) {
  if (session.schedule?.status !== 'final') return null
  const mine = session.feedback.find((f) => f.memberId === me.memberId)
  return (
    <section className="card feedback" id="feedback">
      <h2>⭐ {t('Feedback')}</h2>
      {me.memberId ? (
        <MyFeedback key={mine?.at ?? 0} mine={mine} save={(f) => mutate(() => api.saveFeedback(code, f))} />
      ) : (
        !me.isHost && <p className="muted small">{t('Log in to tell the host how this roster went.')}</p>
      )}
      {me.isHost && <Results session={session} />}
    </section>
  )
}

function Stars({ value, onChange, label }: { value: number; onChange?: (n: number) => void; label: string }) {
  return (
    <span className="stars" role={onChange ? 'radiogroup' : 'img'} aria-label={onChange ? label : t('{n} of 5 stars', { n: value })}>
      {[1, 2, 3, 4, 5].map((n) =>
        onChange ? (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={t('{n} of 5 stars', { n })}
            className={n <= value ? 'on' : ''}
            onClick={() => onChange(value === n ? 0 : n)}
          >
            ★
          </button>
        ) : (
          // An average lights a star only when it's nearly reached (4.5 shows four).
          <span key={n} className={n <= Math.floor(value + 0.25) ? 'on' : ''} aria-hidden>
            ★
          </span>
        ),
      )}
    </span>
  )
}

function MyFeedback({ mine, save }: { mine?: Feedback; save: (f: { ratings: Record<string, number>; text: string; anonymous: boolean }) => Promise<unknown> }) {
  const [ratings, setRatings] = useState<Record<string, number>>(mine?.ratings ?? {})
  const [text, setText] = useState(mine?.text ?? '')
  const [anonymous, setAnonymous] = useState(Boolean(mine?.anonymous))
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const changed =
    !mine ||
    text !== mine.text ||
    anonymous !== Boolean(mine.anonymous) ||
    FEEDBACK_QUESTIONS.some((q) => (ratings[q.id] ?? 0) !== (mine.ratings[q.id] ?? 0))
  const empty = !Object.values(ratings).some((v) => v > 0) && !text.trim()
  return (
    <div className="stack-tight">
      <p className="muted small">
        {mine
          ? t('Thanks — you sent this {time}. You can change it.', { time: new Date(mine.at).toLocaleString() })
          : t('The roster is final. How did it go? Tap the stars (1 = poor, 5 = great) — skip any you like.')}
      </p>
      <ul className="questions">
        {FEEDBACK_QUESTIONS.map((q) => (
          <li key={q.id}>
            <span>{t(q.text)}</span>
            <Stars label={t(q.text)} value={ratings[q.id] ?? 0} onChange={(n) => setRatings((r) => ({ ...r, [q.id]: n }))} />
          </li>
        ))}
      </ul>
      <label>
        {t('Any other recommendations? What went well, what should change next time')}
        <textarea rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <label className="check small">
        <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
        {t('Send without my name (the host won’t see who wrote it)')}
      </label>
      <div className="row wrap">
        <button
          type="button"
          className="primary"
          disabled={!changed || empty || state === 'saving'}
          onClick={async () => {
            setState('saving')
            try {
              await save({ ratings: Object.fromEntries(Object.entries(ratings).filter(([, v]) => v > 0)), text, anonymous })
              setState('saved')
            } catch {
              setState('error')
            }
          }}
        >
          {state === 'saving' ? t('Sending…') : mine ? t('Update feedback') : t('Send feedback')}
        </button>
        {state === 'saved' && <span className="small">✓ {t('Sent — thank you!')}</span>}
        {state === 'error' && <span className="small error">{t('Couldn’t send — try again.')}</span>}
      </div>
    </div>
  )
}

/** Hosts: how many answered, each question's average and spread, and the comments. */
function Results({ session }: { session: SessionProps['session'] }) {
  const all = session.feedback
  const answering = session.config.members.filter((m) => session.config.rosterMode !== 'hospital' || m.type === 'student')
  const name = (f: Feedback) => (f.memberId ? (session.config.members.find((m) => m.id === f.memberId)?.name ?? '?') : t('Anonymous'))
  return (
    <div className="results stack-tight">
      <h3>{t('Results ({n} of {total} answered)', { n: all.length, total: answering.length })}</h3>
      {all.length === 0 ? (
        <p className="muted small">{t('No feedback yet. Everyone sees this card on the Roster tab now that it’s final.')}</p>
      ) : (
        <>
          <ul className="questions">
            {FEEDBACK_QUESTIONS.map((q) => {
              const votes = all.map((f) => f.ratings[q.id]).filter((v): v is number => Boolean(v))
              const avg = votes.length ? votes.reduce((a, b) => a + b, 0) / votes.length : 0
              return (
                <li key={q.id}>
                  <span>{t(q.text)}</span>
                  <span className="nowrap">
                    <Stars label={t(q.text)} value={avg} /> <b>{votes.length ? avg.toFixed(1) : '—'}</b>{' '}
                    <span className="muted small">
                      ({votes.length ? [5, 4, 3, 2, 1].filter((n) => votes.includes(n)).map((n) => `${n}★ × ${votes.filter((v) => v === n).length}`).join(' · ') : t('no ratings')})
                    </span>
                  </span>
                </li>
              )
            })}
          </ul>
          {all.some((f) => f.text) && (
            <>
              <h3>{t('Recommendations')}</h3>
              <ul className="comments">
                {[...all]
                  .filter((f) => f.text)
                  .sort((a, b) => b.at - a.at)
                  .map((f, i) => (
                    <li key={`${f.memberId}-${i}`}>
                      <span className="muted small">
                        {name(f)} · {new Date(f.at).toLocaleString()}
                      </span>
                      <p className="note-text">{f.text}</p>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  )
}
