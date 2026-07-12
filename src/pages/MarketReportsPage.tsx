import { useState, useEffect } from 'react'
import { useProperties } from '../hooks/useProperties'
import { useQuery } from '../hooks/useQuery'
import { supabase } from '../lib/supabase'
import { Widget, WidgetSkeleton } from '../components/ui/Widget'
import { EmptyState } from '../components/ui/EmptyState'

const FN_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`

interface ReportRow {
  id: string
  market: string
  title: string
  publisher: string | null
  period: string | null
  url: string
  summary: string | null
  report_type: string | null
  fetched_at: string
}

const TYPE_LABEL: Record<string, string> = {
  market_report: 'Market report',
  research_note: 'Research',
  news: 'News',
  data_page: 'Data',
}
const TYPE_ORDER: Record<string, number> = { market_report: 0, research_note: 1, data_page: 2, news: 3 }

function useReports(propertyId: string | null, bump: number) {
  return useQuery<ReportRow[]>(async () => {
    if (!propertyId) return []
    const { data, error } = await supabase
      .from('market_reports')
      .select('id, market, title, publisher, period, url, summary, report_type, fetched_at')
      .eq('property_id', propertyId)
    if (error) throw new Error(error.message)
    return ((data ?? []) as ReportRow[]).slice().sort((a, b) =>
      (TYPE_ORDER[a.report_type ?? ''] ?? 9) - (TYPE_ORDER[b.report_type ?? ''] ?? 9)
      || (a.publisher ?? '').localeCompare(b.publisher ?? ''))
  }, [propertyId, bump])
}

export function MarketReportsPage() {
  const { data: properties } = useProperties()
  const [propertyId, setPropertyId] = useState<string | null>(null)
  useEffect(() => { if (!propertyId && properties?.length) setPropertyId(properties[0].id) }, [properties, propertyId])

  const [bump, setBump] = useState(0)
  const reports = useReports(propertyId, bump)
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  async function fetchReports() {
    if (!propertyId || fetching) return
    setFetchError(null)
    setFetching(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${FN_BASE}/market-reports`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token ?? ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.error) throw new Error(json.error ?? `Request failed (${res.status})`)
      setBump(b => b + 1)
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e))
    } finally {
      setFetching(false)
    }
  }

  const rows = reports.data ?? []
  const lastFetched = rows.length ? rows[0].fetched_at : null
  const market = rows.length ? rows[0].market : null

  return (
    <div style={{ padding: '24px 32px', maxWidth: 900 }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>Market Reports</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 18 }}>
        Third-party market research found on the public web for this property's metro — brokerage quarterly
        reports, national outlooks, and local CRE news. Fetch runs a live web search (~1 minute) and replaces
        the list with the freshest editions.
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <select value={propertyId ?? ''} onChange={e => setPropertyId(e.target.value)}
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 6, color: 'var(--text)', fontSize: 13, padding: '7px 10px' }}>
          {(properties ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button onClick={() => void fetchReports()} disabled={fetching || !propertyId}
          style={{
            fontSize: 12, fontWeight: 600, padding: '7px 16px', borderRadius: 6, border: 'none',
            background: fetching ? 'var(--surface-2)' : 'var(--accent)',
            color: fetching ? 'var(--text-muted)' : '#fff', cursor: fetching ? 'default' : 'pointer',
          }}>
          {fetching ? 'Searching the web (~1 min)…' : rows.length ? 'Refresh reports' : 'Fetch latest reports'}
        </button>
        {lastFetched && !fetching && (
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            {market} · last fetched {new Date(lastFetched).toLocaleString()}
          </span>
        )}
      </div>

      {fetchError && <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 10 }}>{fetchError}</div>}

      {reports.loading && <Widget title="Reports"><WidgetSkeleton rows={6} /></Widget>}
      {reports.error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{reports.error}</div>}

      {!reports.loading && rows.length === 0 && (
        <Widget title="Reports">
          <EmptyState icon="🌐" title="No reports fetched yet"
            subtitle="Click Fetch latest reports — a live web search finds the current brokerage research for this market" />
        </Widget>
      )}

      {rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map(r => (
            <a key={r.id} href={r.url} target="_blank" rel="noopener noreferrer"
              style={{
                display: 'block', textDecoration: 'none', padding: '12px 16px', borderRadius: 8,
                border: '1px solid var(--border)', background: 'var(--surface)',
              }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
                <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--accent)' }}>{r.title}</span>
                <span style={{
                  fontSize: 10, color: 'var(--text-faint)', border: '1px solid var(--border-2)',
                  borderRadius: 10, padding: '1px 8px', whiteSpace: 'nowrap',
                }}>
                  {TYPE_LABEL[r.report_type ?? ''] ?? r.report_type}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 6 }}>
                {[r.publisher, r.period].filter(Boolean).join(' · ')}
              </div>
              {r.summary && <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>{r.summary}</div>}
            </a>
          ))}
          <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 4 }}>
            Links open the publisher's site in a new tab. Some reports ask for a name/email before download —
            that's the publisher's gate, not ours.
          </div>
        </div>
      )}
    </div>
  )
}
