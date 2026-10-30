import { useEffect, useState, type ReactNode } from 'react'
import { t } from '../shared/i18n.ts'

/** Two-tap confirmation: first tap arms the button, second tap runs the action. Works where confirm() is blocked. */
export default function ConfirmButton({
  onConfirm,
  children,
  confirmText,
  className,
  title,
  disabled,
}: {
  onConfirm: () => void
  children: ReactNode
  confirmText?: string
  className?: string
  title?: string
  disabled?: boolean
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(timer)
  }, [armed])
  return (
    <button
      type="button"
      className={`${className ?? ''} ${armed ? 'armed' : ''}`}
      title={title}
      disabled={disabled}
      onClick={() => {
        if (armed) {
          setArmed(false)
          onConfirm()
        } else setArmed(true)
      }}
    >
      {armed ? (confirmText ?? t('Tap again to confirm')) : children}
    </button>
  )
}
