import { CSSProperties, ReactNode } from 'react'

type BadgeVariant = 'green' | 'amber' | 'red' | 'blue' | 'gray'

const STYLES: Record<BadgeVariant, CSSProperties> = {
  green: { background: 'var(--green-bg)',  color: 'var(--green)',  border: '1px solid var(--green-border)' },
  amber: { background: 'var(--amber-bg)',  color: 'var(--amber)',  border: '1px solid var(--amber-border)' },
  red:   { background: 'var(--red-bg)',    color: 'var(--red)',    border: '1px solid var(--red-border)'   },
  blue:  { background: 'var(--accent-dim)',color: 'var(--accent)', border: '1px solid var(--accent)'       },
  gray:  { background: 'var(--surface-2)', color: 'var(--text-muted)', border: '1px solid var(--border-2)'},
}

interface BadgeProps {
  variant: BadgeVariant
  children: ReactNode
  size?: 'sm' | 'md'
}

export function Badge({ variant, children, size = 'sm' }: BadgeProps) {
  return (
    <span
      style={{
        ...STYLES[variant],
        fontSize:     size === 'sm' ? 10 : 11,
        fontWeight:   600,
        padding:      size === 'sm' ? '2px 7px' : '3px 9px',
        borderRadius: 99,
        display:      'inline-block',
        whiteSpace:   'nowrap',
      }}
    >
      {children}
    </span>
  )
}
