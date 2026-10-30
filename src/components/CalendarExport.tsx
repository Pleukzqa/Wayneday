// "Add to calendar": choose whose shifts, the event name, colour and which Google calendar.
import { useMemo, useState } from 'react'
import {
  addToGoogleCalendar,
  buildEvents,
  exportGoogleCalendarCsv,
  exportIcs,
  GOOGLE_CLIENT_ID,
  GOOGLE_COLORS,
  IN_ARTIFACT,
  listGoogleCalendars,
  type GoogleCalendar,
} from '../export.ts'
import type { Roster } from '../shared/types.ts'
import type { SessionProps } from './props.ts'

export default function CalendarExport({ session, me, roster }: SessionProps & { roster: Roster }) {
  const { config } = session
  const [who, setWho] = useState<string>(me.memberId ?? 'all')
  const [template, setTemplate] = useState(me.memberId ? '{shift} – {job}' : '{name}: {shift} – {job}')
  const [color, setColor] = useState('7')
  const [calendars, setCalendars] = useState<GoogleCalendar[] | null>(null)
  const [target, setTarget] = useState('new')
  const [newName, setNewName] = useState(config.title)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const events = useMemo(() => buildEvents(config, roster, who === 'all' ? 'all' : [who], template), [config, roster, who, template])
  const run = (label: string, fn: () => Promise<string | void>) => async () => {
    setBusy(label)
    setMsg(null)
    try {
      const m = await fn()
      if (m) setMsg(m)
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <details className="calexport">
      <summary>
        <strong>Add to calendar</strong> <span className="muted small">Google Calendar, Apple, Outlook</span>
      </summary>
      <div className="stack">
        <div className="row wrap">
          <label>
            Whose shifts
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              {me.memberId && <option value={me.memberId}>Mine</option>}
              <option value="all">Everyone</option>
              {config.members
                .filter((m) => m.id !== me.memberId)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="grow">
            Event name
            <input value={template} onChange={(e) => setTemplate(e.target.value)} />
          </label>
        </div>
        <p className="muted small">
          Use {'{shift}'} {'{job}'} {'{name}'} {'{roster}'}. Example: <strong>{events[0]?.title ?? '—'}</strong> · {events.length} event(s)
        </p>
        <div>
          <span className="small">Colour</span>
          <div className="swatches" role="radiogroup" aria-label="Event colour">
            {GOOGLE_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={color === c.id}
                aria-label={c.name}
                title={c.name}
                className={`swatch-btn ${color === c.id ? 'on' : ''}`}
                style={{ background: c.hex }}
                onClick={() => setColor(c.id)}
              />
            ))}
          </div>
        </div>

        <div className="row wrap align-end">
          {GOOGLE_CLIENT_ID ? (
            <>
              {calendars ? (
                <label>
                  Calendar
                  <select value={target} onChange={(e) => setTarget(e.target.value)}>
                    <option value="new">New calendar…</option>
                    {calendars.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.summary}
                        {c.primary ? ' (main)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <button disabled={busy !== null} onClick={run('list', async () => setCalendars(await listGoogleCalendars()))}>
                  Connect Google Calendar
                </button>
              )}
              {calendars && target === 'new' && (
                <label>
                  New calendar name
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} />
                </label>
              )}
              {calendars && (
                <button
                  className="primary"
                  disabled={busy !== null || events.length === 0}
                  onClick={run('add', async () => {
                    const n = await addToGoogleCalendar(events, target === 'new' ? { newName: newName || config.title } : { calendarId: target }, color, (d) =>
                      setBusy(`Adding ${d}/${events.length}…`),
                    )
                    return `Added ${n} event(s) to Google Calendar.`
                  })}
                >
                  {busy?.startsWith('Adding') ? busy : `Add ${events.length} event(s)`}
                </button>
              )}
            </>
          ) : (
            <p className="muted small">
              Direct Google Calendar sync isn’t set up on this server, so colour and calendar are chosen when you import the file.
            </p>
          )}
        </div>
        <div className="row wrap">
          {!IN_ARTIFACT && (
            <button disabled={events.length === 0} onClick={run('ics', () => exportIcs(config, events, newName || config.title))}>
              Download .ics (Apple, Outlook, Google)
            </button>
          )}
          <button disabled={events.length === 0} onClick={run('csv', () => exportGoogleCalendarCsv(config, events))}>
            Google Calendar CSV
          </button>
        </div>
        <p className="muted small">
          To import a file into Google Calendar: on a computer, open Settings → Import &amp; export → Import, and choose which calendar it goes into.
        </p>
        {msg && <p className="small">{msg}</p>}
      </div>
    </details>
  )
}
