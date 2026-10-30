import { useEffect, useState } from 'react'
import { t } from '../shared/i18n.ts'
import { sessionHash } from '../routes.ts'
import { getActing, onDemoChange, resetDemo, SAMPLE_CODE, sessionOf, setActing } from './demoApi.ts'
import ConfirmButton from '../components/ConfirmButton.tsx'

/** Fixed bar for the phone demo: pick who you are acting as. */
export default function DemoBar({ code, onSwitch }: { code: string | undefined; onSwitch: () => void }) {
  // Land on the sample session on first open.
  useEffect(() => {
    if (!code && !location.hash) location.hash = sessionHash(SAMPLE_CODE)
  }, [code])
  const [, force] = useState(0)
  useEffect(() => {
    const off = onDemoChange(() => force((n) => n + 1))
    return () => void off()
  }, [])

  const session = code ? sessionOf(code) : undefined
  return (
    <div className="demobar" role="region" aria-label={t("Demo controls")}>
      <span className="demobar-tag">{t("Demo")}</span>
      {session ? (
        <label className="inline">
          <span className="muted small">{t("Viewing as")}</span>
          <select
            id="demo-viewer"
            value={getActing(code!)}
            onChange={(e) => {
              setActing(code!, e.target.value)
              force((n) => n + 1)
              onSwitch()
            }}
          >
            <option value="host">{t("Host")}</option>
            {session.config.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.type})
              </option>
            ))}
          </select>
        </label>
      ) : (
        <a href={sessionHash(SAMPLE_CODE)} className="small">{t("Open the sample ward")}</a>
      )}
      <ConfirmButton
        className="link small"
        confirmText={t("Tap to reset")}
        onConfirm={() => {
          resetDemo()
          location.hash = sessionHash(SAMPLE_CODE)
          force((n) => n + 1)
          onSwitch()
        }}
      >{t("Reset demo")}</ConfirmButton>
    </div>
  );
}
