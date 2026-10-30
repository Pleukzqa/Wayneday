import { useEffect, useState, type ReactNode } from 'react'

/** Two-tap confirmation: first tap arms the button, second tap runs the action. Works where confirm() is blocked. */
export default function ConfirmButton({
  onConfirm,
  children,
  confirmText = 'Tap again to confirm',
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
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
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
      {armed ? confirmText : children}
    </button>
  )
}
