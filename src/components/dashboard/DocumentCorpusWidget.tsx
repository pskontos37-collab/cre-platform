import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Widget, WidgetSkeleton } from '../ui/Widget'
import { useDocCorpusCount } from '../../hooks/useFinancials'

export function DocumentCorpusWidget() {
  const { data: count, loading } = useDocCorpusCount()
  const [q, setQ] = useState('')
  const navigate = useNavigate()

  return (
    <Widget title="Document Corpus" chip="Semantic search">
      {loading && <WidgetSkeleton rows={3} />}
      {!loading && (
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--text)' }}>{(count ?? 0).toLocaleString('en-US')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>indexed documents</div>
          </div>
          <form
            onSubmit={e => { e.preventDefault(); if (q.trim()) navigate(`/documents?q=${encodeURIComponent(q.trim())}`) }}
            style={{ display: 'flex', gap: 6 }}
          >
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Ask the corpus…"
              style={{ flex: 1, background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 6,
                color: 'var(--text)', fontSize: 13, padding: '7px 10px', outline: 'none' }}
            />
            <button type="submit"
              style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6,
                padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              Search
            </button>
          </form>
          <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 8, lineHeight: 1.5 }}>
            Leases, estoppels, REAs, environmental reports & more — searchable by meaning, not just keywords.
          </div>
        </div>
      )}
    </Widget>
  )
}
