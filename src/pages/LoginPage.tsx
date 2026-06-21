import { useState, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { isSupabaseConfigured } from '../lib/supabase'

export default function LoginPage() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
          borderRadius: 12,
          padding:      32,
        }}
      >
        {/* Logo */}
        <div style={{ marginBottom: 28, textAlign: 'center' }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🏗️</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', margin: 0, lineHeight: 1.2 }}>
            CRE Platform
          </h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '6px 0 0' }}>
            Internal Asset Management
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
              color:        loading || !isSupabaseConfigured ? 'var(--text-faint)' : '#fff',
              border:       'none',
              borderRadius: 7,
              fontSize:     14,
              fontWeight:   600,
              padding:      '11px',
              cursor:       loading || !isSupabaseConfigured ? 'not-allowed' : 'pointer',
              marginTop:    4,
            }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
