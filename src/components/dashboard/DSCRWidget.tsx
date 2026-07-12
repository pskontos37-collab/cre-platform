import { Link } from 'react-router-dom'
import { Widget, WidgetSkeleton } from '../ui/Widget'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { Hero, StatusPill, Gauge } from '../ui/Kpi'
import { useDSCR, type LoanDSCRRow } from '../../hooks/useDashboard'

const fmtPct = (n: number | null) => (n != null ? (n * 100).toFixed(1) + '%' : '—')
const fmtNum = (n: number | null, dp = 2) => (n != null ? n.toFixed(dp) : '—')
const fmtDollar = (n: number | null) =>
  n != null ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : '—'

interface DSCRWidgetProps {
  propertyIds: string[]
  propertyNames: Record<string, string>
}

export function DSCRWidget({ propertyIds, propertyNames }: DSCRWidgetProps) {
  const { data, loading, error } = useDSCR(propertyIds, propertyNames)

  const rows = data ?? []

  return (
    <Widget title="Debt Service Coverage" chip={rows.length > 0 ? `${rows.length} loan${rows.length !== 1 ? 's' : ''}` : undefined}>
      {loading && <WidgetSkeleton rows={3} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && rows.length === 0 && (
        <EmptyState title="No loans" subtitle="Add loan records to calculate DSCR" />
      )}
      {!loading && !error && rows.length > 0 && (
        <div>
          <PortfolioHero rows={rows} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rows.map(row => <LoanRow key={row.loan.id} row={row} />)}
          </div>
        </div>
      )}
    </Widget>
  )
}

// Portfolio-level coverage: combined T12 NOI over combined debt service across
// loans that have both, with a pill for the worst covenant state in scope.
function PortfolioHero({ rows }: { rows: LoanDSCRRow[] }) {
  const covered = rows.filter(r => r.t12Noi != null && r.loan.annual_debt_service)
  const noi = covered.reduce((s, r) => s + (r.t12Noi ?? 0), 0)
  const ads = covered.reduce((s, r) => s + (r.loan.annual_debt_service ?? 0), 0)
  const portfolio = ads > 0 ? noi / ads : null

  const tested = rows.filter(r => r.covenantType != null)
  const pill = tested.length === 0 ? undefined
    : tested.some(r => r.isBreach) ? <StatusPill tone="bad">Covenant breach</StatusPill>
    : tested.some(r => r.isNear) ? <StatusPill tone="warn">Near covenant</StatusPill>
    : <StatusPill tone="ok">✓ Above covenants</StatusPill>

  if (portfolio == null) return null
  return (
    <div style={{ marginBottom: 10 }}>
      <Hero label="Portfolio DSCR" value={fmtNum(portfolio) + 'x'} pill={pill} />
    </div>
  )
}

function LoanRow({ row }: { row: LoanDSCRRow }) {
  const statusBadge = row.isBreach ? (
    <Badge variant="red">Breach</Badge>
  ) : row.isNear ? (
    <Badge variant="amber">Near Covenant</Badge>
  ) : row.covenantType != null ? (
    <Badge variant="green">OK</Badge>
  ) : (
    <Badge variant="gray">No NOI Data</Badge>
  )

  // Describe the covenant package this loan is actually held to.
  const covenantParts: string[] = []
  if (row.loan.debt_yield_covenant != null) covenantParts.push(`Debt Yield ≥ ${fmtPct(row.loan.debt_yield_covenant)}`)
  if (row.loan.dscr_covenant != null) covenantParts.push(`DSCR ≥ ${fmtNum(row.loan.dscr_covenant)}x`)
  if (row.loan.ltv_covenant != null) covenantParts.push(`LTV ≤ ${fmtPct(row.loan.ltv_covenant)}`)

  return (
    <Link
      to={`/properties/${row.loan.property_id}`}
      title="Open property page"
      style={{
        display:      'block',
        padding:      '10px 12px',
        background:   'var(--surface-2)',
        borderRadius: 8,
        border:       `1px solid ${row.isBreach ? 'var(--red-border)' : row.isNear ? 'var(--amber-border)' : 'var(--border-2)'}`,
        textDecoration: 'none',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{row.propertyName}</div>
          <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>{row.loan.lender_name ?? 'Unknown lender'}</div>
        </div>
        {statusBadge}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        <Stat label="Debt Yield" value={fmtPct(row.debtYield)}
              covenant={row.loan.debt_yield_covenant != null ? `≥ ${fmtPct(row.loan.debt_yield_covenant)}` : undefined}
              warn={row.covenantType === 'debt_yield' && (row.isBreach || row.isNear)} />
        <Stat label="LTV" value={fmtPct(row.ltv)}
              covenant={row.loan.ltv_covenant != null ? `≤ ${fmtPct(row.loan.ltv_covenant)}` : undefined} />
        <Stat label="DSCR" value={row.dscr != null ? fmtNum(row.dscr) + 'x' : '—'}
              covenant={row.loan.dscr_covenant != null ? `≥ ${fmtNum(row.loan.dscr_covenant)}x` : undefined}
              warn={row.covenantType === 'dscr' && (row.isBreach || row.isNear)} />
        <Stat label="T12 NOI" value={fmtDollar(row.t12Noi)} />
      </div>

      {/* Coverage gauge vs the governing covenant. Track spans 0 → 1.5× the
          covenant level, so the tick (the covenant itself) sits at 2/3. */}
      {row.covenantType != null && (() => {
        const metric = row.covenantType === 'dscr' ? row.dscr : row.debtYield
        const covenant = row.covenantType === 'dscr' ? row.loan.dscr_covenant : row.loan.debt_yield_covenant
        if (metric == null || covenant == null || covenant <= 0) return null
        const color = row.isBreach ? 'var(--red)' : row.isNear ? 'var(--amber)' : 'var(--green)'
        return (
          <div style={{ marginTop: 8 }}>
            <Gauge frac={metric / (covenant * 1.5)} tick={1 / 1.5} color={color} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-faint)', marginTop: 2 }}>
              <span>{row.covenantType === 'dscr' ? 'coverage' : 'debt yield'}</span>
              <span>covenant {row.covenantType === 'dscr' ? `${fmtNum(covenant)}x` : fmtPct(covenant)}</span>
            </div>
          </div>
        )
      })()}

      {covenantParts.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-faint)' }}>
          Covenants: <span style={{ color: 'var(--text-muted)' }}>{covenantParts.join(' · ')}</span>
        </div>
      )}

      {row.loan.outstanding_balance != null && (
        <div style={{ marginTop: 6, display: 'flex', gap: 16 }}>
          <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>
            Balance: <span style={{ color: 'var(--text-muted)' }}>{fmtDollar(row.loan.outstanding_balance)}</span>
          </span>
          {row.loan.maturity_date && (
            <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>
              Matures: <span style={{ color: 'var(--text-muted)' }}>{row.loan.maturity_date}</span>
            </span>
          )}
        </div>
      )}
    </Link>
  )
}

function Stat({ label, value, covenant, warn }: { label: string; value: string; covenant?: string; warn?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--text-faint)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: warn ? 'var(--amber)' : 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {covenant && <div style={{ fontSize: 9, color: 'var(--text-faint)' }}>{covenant}</div>}
    </div>
  )
}
