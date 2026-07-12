import { useState, useRef, useEffect, type CSSProperties } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useFilter } from '../../contexts/FilterContext'
import { useProperties, usePortfolios } from '../../hooks/useProperties'
import { ThemePicker } from '../ui/ThemePicker'
import { HelpCenter } from '../help/HelpCenter'

export function Header() {
  const { filter, setFilter } = useFilter()
  const { data: properties } = useProperties()
  const { data: portfolios } = usePortfolios()

  return (
    <header
      style={{
        height:        52,
        borderBottom:  '1px solid var(--border)',
        display:       'flex',
        alignItems:    'center',
        padding:       '0 16px',
        gap:           12,
        background:    'var(--surface)',
        position:      'sticky',
        top:           0,
        zIndex:        10,
      }}
    >
      {/* Filter scope selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>View:</span>
        <FilterButton
          label="All Properties"
          active={filter.scope === 'all'}
          onClick={() => setFilter({ scope: 'all', id: null, label: 'All Properties' })}
        />
        {/* Portfolio filter: a hierarchical dropdown of capital-partner portfolios.
            Children (e.g. MetLife/URS) nest under their parent (MetLife) and roll
            UP into it when the parent is selected. */}
        {(portfolios ?? []).length > 0 && (
          <PortfolioPicker portfolios={portfolios!} />
        )}
        {(properties ?? []).length > 0 && (
          <PropertyPicker
            properties={properties!.map(p => ({ id: p.id, name: p.name }))}
          />
        )}
      </div>

      {/* Right side actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <HelpCenter />
        <ThemePicker />
        <AccountMenu />
      </div>
    </header>
  )
}

// Account dropdown: shows the signed-in email and offers a self-service
// password change plus sign-out. Password change calls supabase.auth.updateUser
// (see AuthContext.updatePassword) — no admin or re-login required.
function AccountMenu() {
  const { appUser, user, signOut } = useAuth()
  const [open, setOpen] = useState(false)
  const [showPw, setShowPw] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const email = appUser?.email ?? user?.email ?? 'Account'
  const initials = email.slice(0, 2).toUpperCase()

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title={email}
        style={{
          display:      'flex',
          alignItems:   'center',
          gap:          7,
          background:   'var(--surface-2)',
          border:       '1px solid var(--border-2)',
          borderRadius: 6,
          color:        'var(--text-muted)',
          fontSize:     11,
          padding:      '4px 9px',
          cursor:       'pointer',
        }}
      >
        <span
          style={{
            display:        'inline-flex',
            alignItems:     'center',
            justifyContent: 'center',
            width:          20,
            height:         20,
            borderRadius:   '50%',
            background:     'var(--accent-dim)',
            color:          'var(--accent)',
            fontSize:       9.5,
            fontWeight:     700,
          }}
        >
          {initials}
        </span>
        Account ▾
      </button>
      {open && (
        <div
          style={{
            position:     'absolute',
            top:          'calc(100% + 6px)',
            right:        0,
            minWidth:     220,
            background:   'var(--surface)',
            border:       '1px solid var(--border-2)',
            borderRadius: 10,
            boxShadow:    '0 8px 30px rgba(0,0,0,0.45)',
            zIndex:       50,
            padding:      6,
          }}
        >
          <div style={{ padding: '6px 8px 8px', borderBottom: '1px solid var(--border)', marginBottom: 6 }}>
            <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>Signed in as</div>
            <div style={{ fontSize: 12, color: 'var(--text)', wordBreak: 'break-all' }}>{email}</div>
          </div>
          <button
            onClick={() => { setOpen(false); setShowPw(true) }}
            style={menuItem}
          >
            Change password
          </button>
          <button
            onClick={() => signOut()}
            style={menuItem}
          >
            Sign out
          </button>
        </div>
      )}
      {showPw && <ChangePasswordModal onClose={() => setShowPw(false)} />}
    </div>
  )
}

const menuItem: CSSProperties = {
  display:      'block',
  width:        '100%',
  textAlign:    'left',
  padding:      '7px 8px',
  borderRadius: 6,
  border:       'none',
  background:   'transparent',
  color:        'var(--text-muted)',
  fontSize:     12,
  cursor:       'pointer',
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const { updatePassword } = useAuth()
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function submit() {
    setError(null)
    if (pw1.length < 8) { setError('Password must be at least 8 characters.'); return }
    if (pw1 !== pw2) { setError('The two passwords do not match.'); return }
    setBusy(true)
    const { error: err } = await updatePassword(pw1)
    setBusy(false)
    if (err) { setError(err); return }
    setDone(true)
  }

  return (
    <div
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: 380, background: 'var(--surface)', border: '1px solid var(--border-2)',
          borderRadius: 12, padding: 20, boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
          Change password
        </div>
        {done ? (
          <>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '10px 0 18px' }}>
              Your password has been updated. You'll use the new password next time you sign in.
            </div>
            <button style={modalBtn('primary')} onClick={onClose}>Done</button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 16 }}>
              Enter a new password (at least 8 characters).
            </div>
            <label style={modalLabel}>New password</label>
            <input
              type="password"
              value={pw1}
              onChange={e => setPw1(e.target.value)}
              autoComplete="new-password"
              style={modalInput}
            />
            <label style={{ ...modalLabel, marginTop: 12 }}>Confirm new password</label>
            <input
              type="password"
              value={pw2}
              onChange={e => setPw2(e.target.value)}
              autoComplete="new-password"
              onKeyDown={e => { if (e.key === 'Enter') submit() }}
              style={modalInput}
            />
            {error && (
              <div style={{ fontSize: 11.5, color: 'var(--danger, #e5484d)', marginTop: 10 }}>{error}</div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
              <button style={modalBtn('primary')} disabled={busy} onClick={submit}>
                {busy ? 'Saving…' : 'Update password'}
              </button>
              <button style={modalBtn()} disabled={busy} onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const modalLabel: CSSProperties = {
  display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 5,
}
const modalInput: CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'var(--surface-2)',
  border: '1px solid var(--border-2)', borderRadius: 6, color: 'var(--text)',
  fontSize: 13, padding: '7px 10px', outline: 'none',
}
function modalBtn(variant?: 'primary'): CSSProperties {
  return {
    flex: variant === 'primary' ? 1 : undefined,
    background:   variant === 'primary' ? 'var(--accent)' : 'var(--surface-2)',
    color:        variant === 'primary' ? '#fff' : 'var(--text-muted)',
    border:       variant === 'primary' ? 'none' : '1px solid var(--border-2)',
    borderRadius: 6, fontSize: 12.5, fontWeight: variant === 'primary' ? 600 : 400,
    padding:      '8px 14px', cursor: 'pointer',
  }
}

// Multi-select property picker: check one property or any combination.
function PropertyPicker({ properties }: { properties: Array<{ id: string; name: string }> }) {
  const { filter, setFilter } = useFilter()
  const [open, setOpen] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const boxRef = useRef<HTMLDivElement>(null)

  // Seed the checkboxes from the active filter whenever the panel opens.
  useEffect(() => {
    if (!open) return
    if (filter.scope === 'property' && filter.id) setChecked(new Set([filter.id]))
    else if (filter.scope === 'custom') setChecked(new Set(filter.ids ?? []))
    else setChecked(new Set())
  }, [open])

  // Close when clicking anywhere outside the panel.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const active = filter.scope === 'property' || filter.scope === 'custom'
  const buttonLabel = active ? filter.label : 'Select properties…'

  function apply() {
    const ids = [...checked]
    if (ids.length === 0) {
      setFilter({ scope: 'all', id: null, label: 'All Properties' })
    } else if (ids.length === 1) {
      const p = properties.find(x => x.id === ids[0])
      setFilter({ scope: 'property', id: ids[0], label: p?.name ?? '1 property' })
    } else {
      setFilter({ scope: 'custom', id: null, ids, label: `${ids.length} properties` })
    }
    setOpen(false)
  }

  function toggle(id: string) {
    const next = new Set(checked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setChecked(next)
  }

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background:   active ? 'var(--accent-dim)' : 'var(--surface-2)',
          border:       active ? '1px solid var(--accent)' : '1px solid var(--border-2)',
          borderRadius: 6,
          color:        active ? 'var(--accent)' : 'var(--text-muted)',
          fontSize:     12,
          padding:      '3px 10px',
          cursor:       'pointer',
          whiteSpace:   'nowrap',
        }}
      >
        {buttonLabel} ▾
      </button>
      {open && (
        <div
          style={{
            position:     'absolute',
            top:          'calc(100% + 6px)',
            left:         0,
            width:        320,
            maxHeight:    420,
            overflowY:    'auto',
            background:   'var(--surface)',
            border:       '1px solid var(--border-2)',
            borderRadius: 10,
            boxShadow:    '0 8px 30px rgba(0,0,0,0.45)',
            zIndex:       50,
            padding:      8,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 6px 8px' }}>
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
              Pick one property or any combination
            </span>
            <button
              onClick={() => setChecked(new Set())}
              style={{ fontSize: 10.5, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}
            >
              Clear
            </button>
          </div>
          {properties.map(p => (
            <label
              key={p.id}
              style={{
                display:      'flex',
                alignItems:   'center',
                gap:          8,
                padding:      '5px 6px',
                borderRadius: 6,
                cursor:       'pointer',
                fontSize:     12,
                color:        checked.has(p.id) ? 'var(--text)' : 'var(--text-muted)',
                background:   checked.has(p.id) ? 'var(--surface-2)' : 'transparent',
              }}
            >
              <input
                type="checkbox"
                checked={checked.has(p.id)}
                onChange={() => toggle(p.id)}
                style={{ accentColor: 'var(--accent)' }}
              />
              {p.name}
            </label>
          ))}
          <div style={{ position: 'sticky', bottom: 0, background: 'var(--surface)', paddingTop: 8, display: 'flex', gap: 8 }}>
            <button
              onClick={apply}
              style={{
                flex: 1, background: 'var(--accent)', color: '#fff', border: 'none',
                borderRadius: 6, fontSize: 12, fontWeight: 600, padding: '6px 0', cursor: 'pointer',
              }}
            >
              Apply{checked.size > 0 ? ` (${checked.size})` : ' (all)'}
            </button>
            <button
              onClick={() => setOpen(false)}
              style={{
                background: 'var(--surface-2)', color: 'var(--text-muted)', border: '1px solid var(--border-2)',
                borderRadius: 6, fontSize: 12, padding: '6px 12px', cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Portfolio filter: pick a capital-partner portfolio. Top-level partners are listed
// with their sub-portfolios indented beneath them. Selecting a parent rolls up all
// of its descendants' assets (see useFilteredPropertyIds / portfolioSubtreeIds).
function PortfolioPicker({ portfolios }: { portfolios: Array<{ id: string; name: string; parent_id: string | null }> }) {
  const { filter, setFilter } = useFilter()
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const active = filter.scope === 'portfolio'

  // Flatten to [root, ...its children] pairs so the menu reads as a one-level tree.
  const roots = portfolios.filter(p => !p.parent_id)
  const ordered: Array<{ p: { id: string; name: string }; depth: number }> = []
  for (const r of roots) {
    ordered.push({ p: r, depth: 0 })
    for (const c of portfolios.filter(x => x.parent_id === r.id)) ordered.push({ p: c, depth: 1 })
  }

  function pick(p: { id: string; name: string }) {
    setFilter({ scope: 'portfolio', id: p.id, label: p.name })
    setOpen(false)
  }

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background:   active ? 'var(--accent-dim)' : 'var(--surface-2)',
          border:       active ? '1px solid var(--accent)' : '1px solid var(--border-2)',
          borderRadius: 6,
          color:        active ? 'var(--accent)' : 'var(--text-muted)',
          fontSize:     12,
          fontWeight:   active ? 600 : 400,
          padding:      '3px 10px',
          cursor:       'pointer',
          whiteSpace:   'nowrap',
        }}
      >
        {active ? filter.label : 'Portfolio'} ▾
      </button>
      {open && (
        <div
          style={{
            position:     'absolute',
            top:          'calc(100% + 6px)',
            left:         0,
            minWidth:     240,
            maxHeight:    420,
            overflowY:    'auto',
            background:   'var(--surface)',
            border:       '1px solid var(--border-2)',
            borderRadius: 10,
            boxShadow:    '0 8px 30px rgba(0,0,0,0.45)',
            zIndex:       50,
            padding:      6,
          }}
        >
          {ordered.map(({ p, depth }) => {
            const selected = active && filter.id === p.id
            return (
              <button
                key={p.id}
                onClick={() => pick(p)}
                style={{
                  display:      'block',
                  width:        '100%',
                  textAlign:    'left',
                  padding:      `5px 8px 5px ${8 + depth * 16}px`,
                  borderRadius: 6,
                  border:       'none',
                  cursor:       'pointer',
                  fontSize:     12,
                  fontWeight:   selected ? 600 : 400,
                  color:        selected ? 'var(--text)' : 'var(--text-muted)',
                  background:   selected ? 'var(--surface-2)' : 'transparent',
                }}
              >
                {depth > 0 ? '↳ ' : ''}{p.name}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function FilterButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background:   active ? 'var(--accent-dim)' : 'var(--surface-2)',
        border:       active ? '1px solid var(--accent)' : '1px solid var(--border-2)',
        borderRadius: 6,
        color:        active ? 'var(--accent)' : 'var(--text-muted)',
        fontSize:     12,
        fontWeight:   active ? 600 : 400,
        padding:      '3px 10px',
        cursor:       'pointer',
        whiteSpace:   'nowrap',
      }}
    >
      {label}
    </button>
  )
}
