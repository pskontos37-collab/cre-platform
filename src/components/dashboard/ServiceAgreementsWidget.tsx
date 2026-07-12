import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Widget, WidgetSkeleton, ChipSelect, WidgetPropertyChip, usePropertyChip } from '../ui/Widget'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { useServiceAgreements, type ServiceAgreement } from '../../hooks/useServiceAgreements'

// Surfaces the governing service contract per vendor+category that is expiring
// within the chosen horizon (soonest first), so renewals don't lapse unnoticed.
// Mirrors the /services grouping: latest contract per relationship governs.

interface Props {
  propertyIds: string[]
  propertyNames: Record<string, string>
}

const rankOf = (a: ServiceAgreement) => a.endDate ?? a.agreementDate ?? a.startDate ?? ''

const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const MAX_ROWS = 5

export function ServiceAgreementsWidget({ propertyIds, propertyNames }: Props) {
  const [days, setDays] = useState(120)
  const { sel, setSel, effectiveIds } = usePropertyChip(propertyIds)
  const { data, loading, error } = useServiceAgreements(effectiveIds, propertyNames)
  const agreements = data ?? []

  const todayMs = Date.parse(new Date().toISOString().slice(0, 10))

  const { upcoming, expiredCount } = useMemo(() => {
    // latest contract governs per property+vendor+category
    const latest = new Map<string, ServiceAgreement>()
    for (const a of agreements) {
      const key = `${a.propertyId}|${a.vendor.toLowerCase().replace(/[^a-z0-9]/g, '')}|${a.category}`
      const cur = latest.get(key)
      if (!cur || rankOf(a) > rankOf(cur)) latest.set(key, a)
    }
    // resolved relationships (marked completed/cancelled/ignored) don't count as lapse risk
    const governing = [...latest.values()].filter(a => a.status !== 'terminated' && a.status !== 'superseded' && !a.resolution)

    let expired = 0
    const soon: Array<{ a: ServiceAgreement; daysUntil: number }> = []
    for (const a of governing) {
      if (!a.endDate) continue                        // evergreen / no-term: not a lapse risk here
      const d = Math.round((Date.parse(a.endDate) - todayMs) / 86_400_000)
      if (d < 0) expired++
      else if (d <= days) soon.push({ a, daysUntil: d })
    }
    soon.sort((x, y) => x.daysUntil - y.daysUntil)
    return { upcoming: soon, expiredCount: expired }
  }, [agreements, days, todayMs])

  const shown = upcoming.slice(0, MAX_ROWS)

  return (
    <Widget
      title="Service Agreement Renewals"
      href="/services?status=expiring"
      hrefLabel="All →"
      chip={
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {propertyIds.length > 1 && (
            <WidgetPropertyChip scopeIds={propertyIds} propertyNames={propertyNames} value={sel} onChange={setSel} />
          )}
          <ChipSelect
            value={String(days)}
            onChange={v => setDays(Number(v))}
            options={[
              { value: '60',  label: 'Next 60 days' },
              { value: '90',  label: 'Next 90 days' },
              { value: '120', label: 'Next 120 days' },
              { value: '180', label: 'Next 180 days' },
            ]}
          />
        </span>
      }
    >
      {loading && <WidgetSkeleton rows={3} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && upcoming.length === 0 && (
        <EmptyState icon="✅" title="No renewals due" subtitle={`Nothing expiring in the next ${days} days`} />
      )}
      {!loading && !error && upcoming.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {shown.map(({ a, daysUntil }) => (
            <div
              key={a.id}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 10px',
                background: 'var(--surface-2)', borderRadius: 7,
                border: `1px solid ${urgencyBorder(daysUntil)}`,
              }}
            >
              <div style={{ minWidth: 36, textAlign: 'center', paddingTop: 2 }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: urgencyColor(daysUntil), lineHeight: 1 }}>{daysUntil}</div>
                <div style={{ fontSize: 9, color: 'var(--text-faint)' }}>days</div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 500, lineHeight: 1.4 }}>
                  {a.vendor}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 3 }}>
                  {a.propertyName} · expires {fmtDate(a.endDate!)}
                </div>
              </div>
              <Badge variant={urgencyBadge(daysUntil)}>{a.category}</Badge>
            </div>
          ))}
          {upcoming.length > MAX_ROWS && (
            <Link to="/services?status=expiring" style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none', padding: '2px 2px' }}>
              +{upcoming.length - MAX_ROWS} more expiring →
            </Link>
          )}
        </div>
      )}

      {!loading && !error && expiredCount > 0 && (
        <div style={{ marginTop: 10, paddingTop: 9, borderTop: '1px solid var(--border)' }}>
          <Link to="/services?status=expired" style={{ fontSize: 11, color: 'var(--text-muted)', textDecoration: 'none' }}>
            ⚠ {expiredCount} agreement{expiredCount === 1 ? '' : 's'} already expired — review →
          </Link>
        </div>
      )}
    </Widget>
  )
}

function urgencyColor(days: number) {
  if (days <= 30) return 'var(--red)'
  if (days <= 60) return 'var(--amber)'
  return 'var(--text-muted)'
}
function urgencyBorder(days: number) {
  if (days <= 30) return 'var(--red-border)'
  if (days <= 60) return 'var(--amber-border)'
  return 'var(--border-2)'
}
function urgencyBadge(days: number): 'red' | 'amber' | 'gray' {
  if (days <= 30) return 'red'
  if (days <= 60) return 'amber'
  return 'gray'
}
