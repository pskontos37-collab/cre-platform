import { useMemo } from 'react'
import { Widget } from './ui/Widget'
import { usePortfolioInvestorReturns } from '../hooks/usePortfolioInvestorReturns'
import { useDeals } from '../hooks/useDeals'

const usd = (n: number, dp = 0) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: dp })

const mult = (n: number | null | undefined) =>
  n == null || !isFinite(n) ? '—' : n.toFixed(2) + 'x'

const pct = (n: number | null | undefined) =>
  n == null || !isFinite(n) ? '—' : (n * 100).toFixed(1) + '%'

interface PortfolioInvestorReturnsWidgetProps {
  /** Property scope from the dashboard's global View filter; aggregates only
   *  deals whose property is in scope. Omit to aggregate every deal. */
  propertyIds?: string[]
  layer?: 1 | 2
}

export function PortfolioInvestorReturnsWidget({
  propertyIds,
  layer = 1,
}: PortfolioInvestorReturnsWidgetProps) {
  const title = layer === 1
    ? 'Portfolio — Layer 1 JV Returns (Realized, cash to date)'
    : 'Portfolio — Layer 2 Syndication Returns (Realized, cash to date)'

  const { data: allDeals } = useDeals()

  // Scope to the properties in the global View filter (falls back to all deals).
  const deals = useMemo(() => {
    if (!allDeals) return null
    if (!propertyIds || propertyIds.length === 0) return allDeals
    const inScope = new Set(propertyIds)
    return allDeals.filter(d => inScope.has(d.property_id))
  }, [allDeals, propertyIds])

  const returns = usePortfolioInvestorReturns(deals, layer)

  if (!deals || returns.length === 0) {
    return null
  }

  const tblStyle: React.CSSProperties = {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 13,
  }

  const th: React.CSSProperties = {
    padding: '8px 12px',
    textAlign: 'left',
    fontWeight: 600,
    borderBottom: '1px solid var(--border)',
  }

  const td: React.CSSProperties = {
    padding: '10px 12px',
    borderTop: '1px solid var(--border)',
  }

  return (
    <Widget title={title} fullWidth>
      <table style={tblStyle}>
        <thead>
          <tr style={{ color: 'var(--text-faint)', fontSize: 11 }}>
            <th style={th}>Investor</th>
            <th style={{ ...th, textAlign: 'right' }}>Properties</th>
            <th style={{ ...th, textAlign: 'right' }}>Capital Contributed</th>
            <th style={{ ...th, textAlign: 'right' }}>Distributions to Date</th>
            <th style={{ ...th, textAlign: 'right' }}>Realized Multiple</th>
            <th style={{ ...th, textAlign: 'right' }}>Realized IRR</th>
          </tr>
        </thead>
        <tbody>
          {returns.map(r => (
            <tr key={r.role}>
              <td style={{ ...td, fontWeight: 600 }}>{r.name}</td>
              <td style={{ ...td, textAlign: 'right' }}>{r.propertyCount}</td>
              <td style={{ ...td, textAlign: 'right' }}>{usd(r.totalContributed)}</td>
              <td style={{ ...td, textAlign: 'right' }}>{usd(r.totalDistributed)}</td>
              <td style={{ ...td, textAlign: 'right', color: r.totalMultiple ? 'var(--accent)' : 'var(--text-muted)' }}>
                {mult(r.totalMultiple)}
              </td>
              <td style={{ ...td, textAlign: 'right', color: r.totalIrr == null ? 'var(--text-muted)' : r.totalIrr < 0 ? 'var(--red)' : 'var(--accent)' }}>
                {pct(r.totalIrr)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-faint)' }}>
        Based on actual dated capital flows across {returns.reduce((s, r) => s + r.propertyCount, 0)} properties.
        Realized figures only — excludes unrealized equity value from current sold-today valuations.
      </div>
    </Widget>
  )
}
