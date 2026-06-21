import { useState, useRef, useEffect } from 'react'
import { THEMES, useTheme } from '../../contexts/ThemeContext'

export function ThemePicker() {
  const { theme, setTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  const current = THEMES.find(t => t.id === theme) ?? THEMES[0]

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Change theme"
        style={{
          width:        32,
          height:       32,
          borderRadius: 8,
          border:       '1px solid var(--border-2)',
          background:   'var(--surface-2)',
          cursor:       'pointer',
          display:      'flex',
          alignItems:   'center',
          justifyContent:'center',
          gap:          4,
          padding:      '0 8px',
        }}
      >
        <span style={{
          width:        12,
          height:       12,
          borderRadius: '50%',
          background:   current.preview,
          border:       `2px solid ${current.textPreview}`,
          flexShrink:   0,
        }} />
      </button>

      {open && (
        <div
          style={{
            position:  'absolute',
            top:       36,
            right:     0,
            background:'var(--surface)',
            border:    '1px solid var(--border-2)',
            borderRadius: 10,
            padding:   8,
            minWidth:  160,
            zIndex:    50,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          }}
        >
          <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-faint)', padding: '4px 8px 8px' }}>
            Appearance
          </div>
          {THEMES.map(t => (
            <button
              key={t.id}
              onClick={() => { setTheme(t.id); setOpen(false) }}
              style={{
                width:         '100%',
                display:       'flex',
                alignItems:    'center',
                gap:           10,
                padding:       '7px 8px',
                borderRadius:  6,
                background:    theme === t.id ? 'var(--accent-dim)' : 'transparent',
                border:        'none',
                cursor:        'pointer',
                textAlign:     'left',
              }}
            >
              <span style={{
                width:        20,
                height:       20,
                borderRadius: 6,
                background:   t.preview,
                border:       theme === t.id ? `2px solid var(--accent)` : '2px solid transparent',
                flexShrink:   0,
              }} />
              <span style={{ fontSize: 12, color: theme === t.id ? 'var(--accent)' : 'var(--text-muted)', fontWeight: theme === t.id ? 600 : 400 }}>
                {t.name}
              </span>
              {theme === t.id && (
                <span style={{ marginLeft: 'auto', color: 'var(--accent)', fontSize: 12 }}>✓</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
