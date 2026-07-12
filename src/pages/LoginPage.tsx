import { useState, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { BrandMark, BrandWordmark } from '../components/ui/BrandMark'

export default function LoginPage() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resetMsg, setResetMsg] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    const { error: err } = await signIn(email, password)
    setLoading(false)
    if (err) {
      setError(err)
    } else {
      navigate('/', { replace: true })
    }
  }

  // Sends the Supabase password-reset email. The link lands on /reset-password,
  // where the user picks a new password. We always show the same confirmation
  // regardless of whether the email exists (avoids leaking valid accounts).
  async function handleForgotPassword() {
    setError(null)
    setResetMsg(null)
    if (!email) {
      setError('Enter your email above first, then click "Forgot password?".')
      return
    }
    setResetting(true)
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    setResetting(false)
    setResetMsg(`If an account exists for ${email}, a password-reset link is on its way. Check your inbox.`)
  }

  return (
    <div
      style={{
        minHeight:      '100vh',
        background:     'var(--bg)',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        padding:        '0 16px',
      }}
    >
      <div
        style={{
          width:        '100%',
          maxWidth:     400,
          background:   'var(--surface)',
          border:       '1px solid var(--border)',
          borderRadius: 16,
          padding:      36,
          boxShadow:    'var(--shadow, none)',
        }}
      >
        {/* Brand */}
        <div style={{ marginBottom: 30, textAlign: 'center' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
            <BrandMark size={56} />
          </div>
          <h1 style={{ margin: 0, lineHeight: 1.2 }}>
            <BrandWordmark size={21} />
          </h1>
          <p
            style={{
              fontSize:      10,
              fontWeight:    600,
              letterSpacing: '0.28em',
              textTransform: 'uppercase',
              color:         'var(--text-faint)',
              margin:        '9px 0 0',
            }}
          >
            Asset Management Platform
          </p>
        </div>

        {/* Supabase not configured warning */}
        {!isSupabaseConfigured && (
          <div
            style={{
              padding:      '10px 14px',
              background:   'var(--amber-bg)',
              border:       '1px solid var(--amber-border)',
              borderRadius: 7,
              marginBottom: 20,
              fontSize:     12,
              color:        'var(--amber)',
            }}
          >
            <strong>Supabase not configured.</strong> Set <code>VITE_SUPABASE_URL</code> and{' '}
            <code>VITE_SUPABASE_ANON_KEY</code> in your environment.
          </div>
        )}

        {/* Error */}
        {error && (
          <div
            style={{
              padding:      '10px 14px',
              background:   'var(--red-bg)',
              border:       '1px solid var(--red-border)',
              borderRadius: 7,
              marginBottom: 16,
              fontSize:     12,
              color:        'var(--red)',
            }}
          >
            {error}
          </div>
        )}

        {/* Password-reset confirmation */}
        {resetMsg && (
          <div
            style={{
              padding:      '10px 14px',
              background:   'var(--green-bg, var(--surface-2))',
              border:       '1px solid var(--green-border, var(--border-2))',
              borderRadius: 7,
              marginBottom: 16,
              fontSize:     12,
              color:        'var(--green, var(--text))',
            }}
          >
            {resetMsg}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
              Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoComplete="email"
              style={{
                width:        '100%',
                padding:      '9px 12px',
                background:   'var(--surface-2)',
                border:       '1px solid var(--border-2)',
                borderRadius: 7,
                color:        'var(--text)',
                fontSize:     13,
                outline:      'none',
                boxSizing:    'border-box',
              }}
            />
          </div>

          <div>
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>
              Password
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              style={{
                width:        '100%',
                padding:      '9px 12px',
                background:   'var(--surface-2)',
                border:       '1px solid var(--border-2)',
                borderRadius: 7,
                color:        'var(--text)',
                fontSize:     13,
                outline:      'none',
                boxSizing:    'border-box',
              }}
            />
          </div>

          <button
            type="submit"
            disabled={loading || !isSupabaseConfigured}
            style={{
              background:   loading || !isSupabaseConfigured ? 'var(--surface-2)' : 'var(--accent)',
              color:        loading || !isSupabaseConfigured ? 'var(--text-faint)' : 'var(--bg)',
              border:       'none',
              borderRadius: 9,
              fontSize:     14,
              fontWeight:   700,
              padding:      '11px',
              cursor:       loading || !isSupabaseConfigured ? 'not-allowed' : 'pointer',
              marginTop:    4,
            }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>

          <button
            type="button"
            onClick={handleForgotPassword}
            disabled={resetting || !isSupabaseConfigured}
            style={{
              background:  'none',
              border:      'none',
              color:       'var(--text-muted)',
              fontSize:    12,
              cursor:      resetting || !isSupabaseConfigured ? 'not-allowed' : 'pointer',
              textAlign:   'center',
              padding:     0,
              marginTop:   2,
            }}
          >
            {resetting ? 'Sending reset link…' : 'Forgot password?'}
          </button>
        </form>
      </div>
    </div>
  )
}
