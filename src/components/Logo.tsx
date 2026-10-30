/** Wayneday's mark: a calendar whose heartbeat line draws a W. Same drawing as public/favicon.svg. */
export default function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect x="4" y="9" width="56" height="51" rx="13" fill="#1f6f5c" />
      <rect x="17" y="3" width="7" height="14" rx="3.5" fill="#15503f" />
      <rect x="40" y="3" width="7" height="14" rx="3.5" fill="#15503f" />
      <path d="M7 36h5l5-15 7 26 8-18 8 18 7-26 5 15h5" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
