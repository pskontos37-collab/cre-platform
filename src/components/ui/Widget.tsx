import { ReactNode } from 'react'

interface WidgetProps {
  title: string
  chip?: string
  children: ReactNode
  fullWidth?: boolean
  minHeight?: number
}

export function Widget({ title, chip, children, fullWidth, minHeight }: WidgetProps) {
  return (
    <div
      style={{
        background:  'var(--surface)',
        border:      '1px solid var(--border)',
        borderRadius: 10,
        overflow:    'hidden',
        gridColumn:  fullWidth ? '1 / -1' : undefined,
        minHeight,
      }}
    >
      <div
        style={{
          padding:       '10px 14px',
          borderBottom:  '1px solid var(--border)',
          display:       'flex',
          alignItems:    'center',
          justifyContent:'space-between',
        }}
      >
        <span
          style={{
            fontSize:      11,
            fontWeight:    600,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color:         'var(--text-muted)',
          }}
        >
          {title}
        </span>
        {chip && (
          <span
            style={{
              fontSize:     10,
              color:        'var(--text-faint)',
              background:   'var(--surface-2)',
              padding:      '2px 8px',
              borderRadius: 99,
            }}
          >
            {chip}
          </span>
        )}
      </div>
      <div style={{ padding: '12px 14px' }}>{children}</div>
    </div>
  )
}

export function WidgetSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 14,
            background: 'var(--surface-2)',
            borderRadius: 4,
            width: `${70 + (i % 3) * 10}%`,
            opacity: 0.6,
          }}
        />
      ))}
    </div>
  )
}
