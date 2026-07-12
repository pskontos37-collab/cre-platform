import { Widget } from './ui/Widget'
import { useInvestorReturns } from '../hooks/useInvestorReturns'
import type { DealRow } from '../hooks/useDeals'

const usd = (n: number, dp = 0) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: dp })

const pct = (n: number | null | undefined, dp = 1) =>
  n == null || !isFinite(n) ? '—' : (n * 100).toFixed(dp) + '%'

const mult = (n: number | null | undefined) =>
  n == null || !isFinite(n) ? '—' : n.toFixed(2) + 'x'

interface InvestorReturnsWidgetProps {
  deal: DealRow | null
  propertyName?: string
  asOfDate?: string
  soldTodayMap?: Record<string, number> // role -> sale proceeds value, e.g. { lp: 1000000, gp: 500000 }
  layer?: 1 | 2
}

export function InvestorReturnsWidget({
  deal,
  propertyName = 'Property',
  asOfDate = new Date().toISOString().slice(0, 10),
  soldTodayMap = {},
  layer = 1,
}: InvestorReturnsWidgetProps) {
  const title = layer === 1
    ? `${propertyName} — Layer 1 JV Returns`
    : `${propertyName} — Layer 2 Syndication Returns`

  const chip = `As of ${asOfDate}`

  // Get returns for this layer
  const returns = useInvestorReturns(deal, asOfDate, soldTodayMap)
    .filter(r => {
      if (layer === 1) return r.role === 'lp' || r.role === 'gp'
      return r.role !== 'lp' && r.role !== 'gp'
    })

  if (!deal || returns.length === 0) {
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
    <Widget title={title} chip={chip} fullWidth>
      <table style={tblStyle}>
        <thead>
          <tr style={{ color: 'var(--text-faint)', fontSize: 11 }}>
            <th style={th}>Investor</th>
            <th style={{ ...th, textAlign: 'right' }}>Contributed</th>
            <th style={{ ...th, textAlign: 'right' }}>Distributed to Date</th>
            <th style={{ ...th, textAlign: 'right' }}>Sold-Today Proceeds</th>
            <th style={{ ...th, textAlign: 'right' }}>Total Return</th>
            <th style={{ ...th, textAlign: 'right' }}>IRR</th>
            <th style={{ ...th, textAlign: 'right' }}>Multiple</th>
          </tr>
        </thead>
        <tbody>
          {returns.map(r => (
            <tr key={r.role}>
              <td style={{ ...td, fontWeight: 600 }}>{r.name}</td>
              <td style={{ ...td, textAlign: 'right' }}>{usd(r.contributed)}</td>
              <td style={{ ...td, textAlign: 'right' }}>{usd(r.distributed)}</td>
              <td style={{ ...td, textAlign: 'right' }}>{usd(r.soldTodayValue)}</td>
              <td style={{ ...td, textAlign: 'right' }}>{usd(r.distributed + r.soldTodayValue)}</td>
              <td style={{ ...td, textAlign: 'right', color: r.irr ? 'var(--accent)' : 'var(--text-muted)' }}>
                {pct(r.irr)}
              </td>
              <td style={{ ...td, textAlign: 'right', color: r.em ? 'var(--accent)' : 'var(--text-muted)' }}>
                {mult(r.em)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Widget>
  )
}
