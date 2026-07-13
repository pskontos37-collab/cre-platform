import { useMemo, useState, type CSSProperties } from 'react'
import {
  useTransactions, type Transaction, type TxnType,
  TXN_TYPE_LABEL, roleLabel,
} from '../hooks/useTransactions'
import { TransactionCard } from '../components/transactions/TransactionPieces'
import { WidgetSkeleton } from '../components/ui/Widget'
import { EmptyState } from '../components/ui/EmptyState'
import { DocAbstractsButton, type AbstractDocRef } from '../components/DocAbstractsButton'

// /transactions — the portfolio-wide record of closed deals (acquisitions,
// refinancings, recaps, dispositions). Institutional memory: every row anchors
// to its verified source documents. Design: docs/transactions-design.md.

const WILKOW_MIST = '#8fa2ad'
const SERIF = "'Frank Ruhl Libre', 'Cinzel', Georgia, serif"

const fmt$ = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

// The headline figure that represents each transaction type in the ledger totals.
const HEADLINE: Record<TxnType, string[]> = {
  acquisition: ['contract_price', 'gross_price', 'total_basis'],
  refinance:   ['loan_amount'],
  recap:       ['preferred_equity_amount', 'loan_amount'],
  disposition: ['net_proceeds', 'gross_price', 'contract_price'],
}
function headlineValue(t: Transaction): number | null {
  for (const label of HEADLINE[t.type]) {
    const f = t.figures.find(x => x.label === label)
    if (f) return f.value
  }
  return t.figures[0]?.value ?? null
}

const yearOf = (iso: string) => iso.slice(0, 4)

export function TransactionsPage() {
  const { data, loading, error } = useTransactions()
  const txns = data ?? []

  const [typeFilter, setTypeFilter] = useState<TxnType | ''>('')
  const [yearFilter, setYearFilter] = useState('')
  const [propFilter, setPropFilter] = useState('')
  const [verifiedOnly, setVerifiedOnly] = useState(false)

  const years = useMemo(
    () => Array.from(new Set(txns.map(t => yearOf(t.closeDate)))).sort((a, b) => b.localeCompare(a)),
    [txns],
  )
  const properties = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of txns) for (const p of t.properties) m.set(p.id, p.name)
    return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [txns])

  const filtered = txns.filter(t =>
    (!typeFilter || t.type === typeFilter) &&
    (!yearFilter || yearOf(t.closeDate) === yearFilter) &&
    (!propFilter || t.properties.some(p => p.id === propFilter)) &&
    (!verifiedOnly || t.verificationStatus === 'verified'),
  )

  // All ACTIVE (not superseded) closing documents for the selected property —
  // the input to the on-demand narrative-abstract pack. Requires a single
  // property so the AI run stays scoped.
  const selectedPropName = properties.find(p => p.id === propFilter)?.name ?? ''
  const abstractDocs = useMemo<AbstractDocRef[]>(() => {
    if (!propFilter) return []
    const seen = new Set<string>()
    const out: AbstractDocRef[] = []
    for (const t of txns) {
      if (!t.properties.some(p => p.id === propFilter)) continue
      for (const d of t.docs) {
        if (d.superseded || !d.documentId || seen.has(d.documentId)) continue
        seen.add(d.documentId)
        out.push({
          documentId: d.documentId,
          propertyId: propFilter,
          title: d.title ?? d.fileName ?? 'Document',
          docType: d.role ?? null,
          roleLabel: roleLabel(d.role),
          context: { transaction_type: t.type, counterparty: t.counterparty, close_date: t.closeDate, role: d.role },
        })
      }
    }
    return out
  }, [txns, propFilter])

  // Totals by type over the filtered set (each transaction counts once).
  const totals = useMemo(() => {
    const acc: Record<TxnType, { count: number; sum: number }> =
      { acquisition: { count: 0, sum: 0 }, refinance: { count: 0, sum: 0 }, recap: { count: 0, sum: 0 }, disposition: { count: 0, sum: 0 } }
    for (const t of filtered) {
      acc[t.type].count += 1
      const v = headlineValue(t)
      if (v != null) acc[t.type].sum += v
    }
    return acc
  }, [filtered])

  return (
    <div>
      {/* ── Header ── */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.22em', textTransform: 'uppercase', color: WILKOW_MIST }}>
          Capital Events
        </div>
        <h1 style={{ fontFamily: SERIF, fontSize: 24, fontWeight: 700, color: 'var(--text)', margin: '2px 0 0' }}>
          Transactions
        </h1>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
          Closed acquisitions, refinancings, recaps and dispositions — each tied to its verified source documents.
        </div>
      </div>

      {loading && <WidgetSkeleton />}
      {error && <div style={{ color: 'var(--red)', fontSize: 13 }}>{error}</div>}

      {!loading && !error && (
        <>
          {/* ── Totals by type ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
            {(Object.keys(TXN_TYPE_LABEL) as TxnType[]).map(k => (
              <div key={k} style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)', padding: '10px 12px' }}>
                <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
                  {TXN_TYPE_LABEL[k]}
                </div>
                <div style={{ fontFamily: SERIF, fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>
                  {totals[k].sum > 0 ? fmt$(totals[k].sum) : '—'}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                  {totals[k].count} {totals[k].count === 1 ? 'deal' : 'deals'}
                </div>
              </div>
            ))}
          </div>

          {/* ── Filters ── */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value as TxnType | '')} style={selectStyle}>
              <option value="">All types</option>
              {(Object.keys(TXN_TYPE_LABEL) as TxnType[]).map(k => <option key={k} value={k}>{TXN_TYPE_LABEL[k]}</option>)}
            </select>
            <select value={propFilter} onChange={e => setPropFilter(e.target.value)} style={selectStyle}>
              <option value="">All properties</option>
              {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select value={yearFilter} onChange={e => setYearFilter(e.target.value)} style={selectStyle}>
              <option value="">All years</option>
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
              <input type="checkbox" checked={verifiedOnly} onChange={e => setVerifiedOnly(e.target.checked)} />
              Verified only
            </label>
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
              <DocAbstractsButton
                kind="transaction"
                docs={abstractDocs}
                reportTitle={selectedPropName || 'Transactions'}
                reportSubtitle="Narrative abstracts of all active closing documents"
                scopeLabel={selectedPropName ? `${selectedPropName} · ${abstractDocs.length} active document${abstractDocs.length === 1 ? '' : 's'}` : ''}
                fileName={`Wilkow-Transaction-Abstracts-${(selectedPropName || 'property').replace(/[^\w.-]+/g, '-')}.pdf`}
                disabled={!propFilter}
                disabledReason="Choose a single property above to abstract its active closing documents"
              />
              <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
                {filtered.length} of {txns.length}
              </span>
            </span>
          </div>

          {/* ── List ── */}
          {filtered.length === 0 ? (
            <EmptyState icon="🧾" title={txns.length === 0 ? 'No transactions recorded yet.' : 'No transactions match these filters.'} />
          ) : (
            filtered.map(t => <TransactionCard key={t.id} t={t} defaultOpen={filtered.length <= 3} />)
          )}
        </>
      )}
    </div>
  )
}

const selectStyle: CSSProperties = {
  fontSize: 12, padding: '5px 8px', borderRadius: 6,
  border: '1px solid var(--border-2)', background: 'var(--surface)', color: 'var(--text)',
}
