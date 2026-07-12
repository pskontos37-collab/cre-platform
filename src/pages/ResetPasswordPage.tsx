import { useState, useEffect, type FormEvent, type ReactNode, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { BrandMark, BrandWordmark } from '../components/ui/BrandMark'

// Landing page for the password-reset email link. Supabase redirects here with a
// recovery token in the URL hash; the supabase-js client (detectSessionInUrl,
// on by default) turns that into a session and fires a PASSWORD_RECOVERY event.
// Once we have that session the user can set a new password via updateUser.
export default function ResetPasswordPage() {
  const navigate = useNavigate()
  const { updatePassword } = useAuth()

  // 'checking' until we know whether the link produced a valid recovery session.
  const [phase, setPhase] = useState<'checking' | 'ready' | 'invalid'>('checking')
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    let settled = false
    const markReady = () => { if (!settled) { settled = true; setPhase('ready') } }

    // The recovery event fires once the client parses the token out of the URL.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || session) markReady()
    })

    // Fallback: the token may already be parsed by the time we subscribe.
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) markReady()
      else setTimeout(() => { if (!settled) { settled = true; setPhase('invalid') } }, 1500)
    })

    return () => subscription.unsubscribe()
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
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
    <Shell>
      {phase === 'checking' && (
        <p style={{ fontSize: 13, color: 'var(--text-faint)', textAlign: 'center', margin: 0 }}>
          Verifying reset link…
        </p>
      )}

      {phase === 'invalid' && (
        <>
          <div style={notice('red')}>
            This password-reset link is invalid or has expired. Request a new one from the sign-in
            screen.
          </div>
          <button style={primaryBtn} onClick={() => navigate('/login', { replace: true })}>
            Back to sign in
          </button>
        </>
      )}

      {phase === 'ready' && !done && (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 4px', textAlign: 'center' }}>
            Choose a new password (at least 8 characters).
          </p>
          <Field label="New password" value={pw1} onChange={setPw1} />
          <Field label="Confirm new password" value={pw2} onChange={setPw2} />
          {error && <div style={notice('red')}>{error}</div>}
          <button type="submit" disabled={busy} style={primaryBtn}>
            {busy ? 'Saving…' : 'Set new password'}
          </button>
        </form>
      )}

      {done && (
        <>
          <div style={notice('green')}>Your password has been updated.</div>
          <button style={primaryBtn} onClick={() => navigate('/', { replace: true })}>
            Continue to app
          </button>
        </>
      )}
    </Shell>
  )
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100vh', background: 'var(--bg)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: '0 16px',
      }}
    >
      <div
        style={{
          width: '100%', maxWidth: 400, background: 'var(--surface)',
          border: '1px solid var(--border)', borderRadius: 16, padding: 36,
          boxShadow: 'var(--shadow, none)',
        }}
      >
        <div style={{ marginBottom: 26, textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
            <BrandMark size={56} />
          </div>
          <h1 style={{ margin: 0, lineHeight: 1.2 }}>
            <BrandWordmark size={21} />
          </h1>
          <p
            style={{
              fontSize: 10, fontWeight: 600, letterSpacing: '0.28em', textTransform: 'uppercase',
              color: 'var(--text-faint)', margin: '9px 0 0',
            }}
          >
            Reset Password
          </p>
        </div>
        {children}
      </div>
    </div>
  )
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
        {label}
      </label>
      <input
        type="password"
        required
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="••••••••"
        autoComplete="new-password"
        style={{
          width: '100%', padding: '9px 12px', background: 'var(--surface-2)',
          border: '1px solid var(--border-2)', borderRadius: 7, color: 'var(--text)',
          fontSize: 13, outline: 'none', boxSizing: 'border-box',
        }}
      />
    </div>
  )
}

const primaryBtn: CSSProperties = {
  background: 'var(--accent)', color: 'var(--bg)', border: 'none', borderRadius: 9,
  fontSize: 14, fontWeight: 700, padding: '11px', cursor: 'pointer', marginTop: 4,
}

function notice(kind: 'red' | 'green'): CSSProperties {
  return {
    padding: '10px 14px',
    background: kind === 'red' ? 'var(--red-bg)' : 'var(--green-bg, var(--surface-2))',
    border: `1px solid ${kind === 'red' ? 'var(--red-border)' : 'var(--green-border, var(--border-2))'}`,
    borderRadius: 7, marginBottom: 14, fontSize: 12,
    color: kind === 'red' ? 'var(--red)' : 'var(--green, var(--text))',
  }
}
