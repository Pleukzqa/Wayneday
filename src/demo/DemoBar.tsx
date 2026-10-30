import { useEffect, useState } from 'react'
import { sessionHash } from '../routes.ts'
import { getActing, resetDemo, SAMPLE_CODE, sessionOf, setActing } from './demoApi.ts'
import ConfirmButton from '../components/ConfirmButton.tsx'

/** Fixed bar for the phone demo: pick who you are acting as. */
export default function DemoBar({ code, onSwitch }: { code: string | undefined; onSwitch: () => void }) {
  // Land on the sample session on first open.
  useEffect(() => {
    if (!code && !location.hash) location.hash = sessionHash(SAMPLE_CODE)
  }, [code])
  const [, force] = useState(0)

  const session = code ? sessionOf(code) : undefined
  return (
    <div className="demobar" role="region" aria-label="Demo controls">
      <span className="demobar-tag">Demo</span>
      {session ? (
        <label className="inline">
          <span className="muted small">Viewing as</span>
          <select
            id="demo-viewer"
            value={getActing(code!)}
            onChange={(e) => {
              setActing(code!, e.target.value)
              force((n) => n + 1)
              onSwitch()
            }}
          >
            <option value="host">Host</option>
            {session.config.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.type})
              </option>
            ))}
          </select>
        </label>
      ) : (
        <a href={sessionHash(SAMPLE_CODE)} className="small">
          Open the sample ward
        </a>
      )}
      <ConfirmButton
        className="link small"
        confirmText="Tap to reset"
        onConfirm={() => {
          resetDemo()
          location.hash = sessionHash(SAMPLE_CODE)
          force((n) => n + 1)
          onSwitch()
        }}
      >
        Reset demo
      </ConfirmButton>
    </div>
  )
}
