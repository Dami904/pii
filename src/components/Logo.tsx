/**
 * src/components/Logo.tsx
 * The Pii mark: a lowercase "ii" whose first dot is solid (value you can see) and whose
 * second is a ring (value that is hidden). Kept as inline SVG so it scales to favicon size.
 */

export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Pii"
      className={className}
    >
      <rect width="32" height="32" rx="8" style={{ fill: 'var(--accent)' }} />
      <rect x="9.3" y="14" width="3.4" height="10" rx="1.7" fill="#fff" />
      <rect x="19.3" y="14" width="3.4" height="10" rx="1.7" fill="#fff" />
      <circle cx="11" cy="9" r="2.4" fill="#fff" />
      <circle cx="21" cy="9" r="1.65" fill="none" stroke="#fff" strokeWidth="1.5" />
    </svg>
  )
}
