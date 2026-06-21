import { Widget, WidgetSkeleton } from '../ui/Widget'
import { EmptyState } from '../ui/EmptyState'
import { useNOI, type NOILineRow } from '../../hooks/useDashboard'

const fmt = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

const pctStr = (a: number | null, b: number | null) => {
  if (a == null || b == null || b === 0) return null
  const d = ((a - b) / Math.abs(b)) * 100
  return { value: d, label: `${d >= 0 ? '+' : ''}${d.toFixed(1)}%` }
}

interface NOIWidgetProps {
  propertyIds: string[]
}

export function NOIWidget({ propertyIds }: NOIWidgetProps) {
  const { data, loading, error } = useNOI(propertyIds)

  return (
    <Widget title="Net Operating Income" chip="Trailing 12-Month">
      {loading && <WidgetSkeleton rows={6} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && !data && <EmptyState title="No financial data" subtitle="Add financial periods to see NOI" />}
      {!loading && !error && data && (
        <div>
          {/* Headline KPIs */}
          <div style={{ display: 'flex', gap: 24, marginBottom: 16 }}>
            <KPI label="T12 NOI" value={fmt(data.t12Noi)} />
            <KPI
              label="Current Year"
              value={fmt(data.currentNoi)}
              delta={pctStr(data.currentNoi, data.priorYearNoi)}
            />
            {data.budgetNoi != null && (
              <KPI
                label="vs. Budget"
                value={fmt(data.currentNoi)}
                delta={pctStr(data.currentNoi, data.budgetNoi)}
              />
            )}
          </div>

          {/* Income lines */}
          <SectionHeader label="Income" total={data.totalIncome} />
          {data.incomeLines.map(row => <LineRow key={row.category} row={row} />)}

          <div style={{ borderTop: '1px solid var(--border)', margin: '8px 0' }} />

          {/* Expense lines */}
          <SectionHeader label="Expenses" total={data.totalExpenses} isExpense />
          {data.expenseLines.map(row => <LineRow key={row.category} row={row} />)}

          {/* NOI total */}
          <div style={{ borderTop: '1px solid var(--border-2)', marginTop: 8, paddingTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>NOI</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: data.currentNoi >= 0 ? 'var(--green)' : 'var(--red)' }}>
              {fmt(data.currentNoi)}
            </span>
          </div>
        </div>
      )}
    </Widget>
  )
}

function KPI({ label, value, delta }: { label: string; value: string; delta?: { value: number; label: string } | null }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>{value}</div>
      {delta && (
        <div style={{ fontSize: 10, color: delta.value >= 0 ? 'var(--green)' : 'var(--red)', marginTop: 1 }}>
          {delta.label} vs prior
        </div>
      )}
    </div>
  )
}

function SectionHeader({ label, total, isExpense }: { label: string; total: number; isExpense?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
      <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-faint)' }}>{label}</span>
      <span style={{ fontSize: 11, fontWeight: 600, color: isExpense ? 'var(--red)' : 'var(--green)' }}>
        {isExpense ? '-' : ''}{('' + Math.abs(total).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }))}
      </span>
    </div>
  )
}

function LineRow({ row }: { row: NOILineRow }) {
  const delta = pctStr(row.actual, row.budget)
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0' }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{row.label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {delta && (
          <span style={{ fontSize: 10, color: delta.value >= 0 ? 'var(--green)' : 'var(--amber)' }}>
            {delta.label}
          </span>
        )}
        <span style={{ fontSize: 12, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
          {row.actual.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}
        </span>
      </div>
    </div>
  )
}
