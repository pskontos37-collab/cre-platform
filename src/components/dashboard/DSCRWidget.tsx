import { Widget, WidgetSkeleton } from '../ui/Widget'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map(row => <LoanRow key={row.loan.id} row={row} />)}
        </div>
      )}
    </Widget>
  )
}

function LoanRow({ row }: { row: LoanDSCRRow }) {
  const statusBadge = row.isBreach ? (
    <Badge variant="red">Breach</Badge>
  ) : row.isNear ? (
    <Badge variant="amber">Near Covenant</Badge>
  ) : row.dscr != null ? (
    <Badge variant="green">OK</Badge>
  ) : (
    <Badge variant="gray">No DSCR Data</Badge>
  )

  return (
    <div
      style={{
        padding:      '10px 12px',
        background:   'var(--surface-2)',
        borderRadius: 8,
        border:       `1px solid ${row.isBreach ? 'var(--red-border)' : row.isNear ? 'var(--amber-border)' : 'var(--border-2)'}`,
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
        <Stat label="DSCR" value={fmtNum(row.dscr)} covenant={row.loan.dscr_covenant ? `≥ ${fmtNum(row.loan.dscr_covenant)}x` : undefined} warn={row.isBreach || row.isNear} />
        <Stat label="Debt Yield" value={fmtPct(row.debtYield)} />
        <Stat label="T12 NOI" value={fmtDollar(row.t12Noi)} />
        <Stat label="Headroom" value={row.headroom != null ? fmtNum(row.headroom) + 'x' : '—'} />
      </div>

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
    </div>
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
