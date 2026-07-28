import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { useProperties } from '../hooks/useProperties'
import { useAuth } from '../contexts/AuthContext'
import { Widget, WidgetSkeleton } from '../components/ui/Widget'
import { EmptyState } from '../components/ui/EmptyState'
import {
  usePcfVersions, usePcfGrid, useLineDetail, computeTotals,
  createPcfVersion, savePcfCell, clearPcfCell, publishPcfVersion, latestClosedMonth,
} from '../hooks/usePcf'
import type { PcfRow, PcfSection, CashBasis, PcfTotals } from '../hooks/usePcf'

// /pcf - Projected Cash Flow for OWNED properties. One grid per property-fiscal-
// year, split by a moving ACTUAL|FORECAST boundary. Replaces the save-a-copy-of-
// last-month's-workbook cycle, and with it the formula-drift error class found in
// the reference workbook (a variance reversed on two rows, a SUM range that
// dropped the mortgage interest line for every forward month, comments carried
// forward from a prior year).

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const SUBSECTION_LABEL: Record<string, string> = {
  utilities: 'Utilities', repairs_maintenance: 'Repairs & Maintenance', cleaning: 'Cleaning',
  grounds_lot: 'Grounds & Lot', security: 'Security', insurance: 'Insurance',
  property_taxes: 'Property Taxes', administrative: 'Administrative', management_fee: 'Management Fee',
}

// Accounting presentation: negatives in parentheses, no cents at this altitude.
function fmt(v: number | null): string {
  if (v === null) return '—'
  const r = Math.round(v)
  if (r === 0) return '0'
  const s = Math.abs(r).toLocaleString('en-US')
  return r < 0 ? `(${s})` : s
}

type DisplayRow =
  | { kind: 'section'; label: string }
  | { kind: 'line'; row: PcfRow }
  | { kind: 'subtotal'; label: string; values: number[]; strong?: boolean }
  | { kind: 'spacer' }

function buildDisplayRows(rows: PcfRow[], totals: PcfTotals): DisplayRow[] {
  const out: DisplayRow[] = []
  const bySection = (s: PcfSection) => rows.filter(r => r.section === s)

  out.push({ kind: 'section', label: 'Income' })
  for (const r of bySection('income')) out.push({ kind: 'line', row: r })
  out.push({ kind: 'subtotal', label: 'Total income', values: totals.totalIncome })

  out.push({ kind: 'spacer' })
  out.push({ kind: 'section', label: 'Operating expenses' })
  const opex = bySection('opex')
  const subs = [...new Set(opex.map(r => r.subsection ?? 'other'))]
  for (const sub of subs) {
    const lines = opex.filter(r => (r.subsection ?? 'other') === sub)
    if (!lines.length) continue
    out.push({ kind: 'section', label: SUBSECTION_LABEL[sub] ?? sub })
    for (const r of lines) out.push({ kind: 'line', row: r })
  }
  out.push({ kind: 'subtotal', label: 'Total operating expenses', values: totals.totalOpex })
  out.push({ kind: 'subtotal', label: 'Net operating income', values: totals.noi, strong: true })

  out.push({ kind: 'spacer' })
  out.push({ kind: 'section', label: 'Non-operating' })
  for (const r of bySection('non_operating')) out.push({ kind: 'line', row: r })
  out.push({ kind: 'subtotal', label: 'Net income', values: totals.netIncome, strong: true })

  out.push({ kind: 'spacer' })
  out.push({ kind: 'section', label: 'Capital expenditures' })
  for (const r of bySection('capital')) out.push({ kind: 'line', row: r })
  out.push({ kind: 'subtotal', label: 'Total capital', values: totals.capital })

  out.push({ kind: 'spacer' })
  out.push({ kind: 'section', label: 'Other balance sheet' })
  for (const r of bySection('balance_sheet')) out.push({ kind: 'line', row: r })
  out.push({ kind: 'subtotal', label: 'Total other balance sheet', values: totals.balanceSheet })
  out.push({ kind: 'subtotal', label: 'Net monthly cash', values: totals.netMonthlyCash, strong: true })

  out.push({ kind: 'spacer' })
  out.push({ kind: 'section', label: 'Equity' })
  for (const r of bySection('equity')) out.push({ kind: 'line', row: r })
  out.push({ kind: 'subtotal', label: 'Net cash', values: totals.netCash, strong: true })

  out.push({ kind: 'spacer' })
  out.push({ kind: 'section', label: 'Cash recap' })
  out.push({ kind: 'subtotal', label: 'Beginning cash', values: totals.beginningCash })
  out.push({ kind: 'subtotal', label: 'Change in cash', values: totals.netCash })
  out.push({ kind: 'subtotal', label: 'Ending cash', values: totals.endingCash, strong: true })

  return out
}

const cellBase: CSSProperties = {
  padding: '4px 8px', textAlign: 'right', fontSize: 12, whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
}
const labelCell: CSSProperties = {
  padding: '4px 10px', fontSize: 12, whiteSpace: 'nowrap', position: 'sticky', left: 0,
  background: 'var(--surface)', zIndex: 1, minWidth: 240,
}

export function PcfPage() {
  const { user } = useAuth()
  const { data: properties, loading: propsLoading } = useProperties()
  const [propertyId, setPropertyId] = useState<string | null>(null)
  const [versionId, setVersionId] = useState<string | null>(null)
  const [drillLine, setDrillLine] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ lineKey: string; month: number } | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editNote, setEditNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [pubBasis, setPubBasis] = useState<CashBasis>('cumulative')
  const [pubOpening, setPubOpening] = useState('')

  const activeProperty = propertyId ?? properties?.[0]?.id ?? null
  const { data: versions, refetch: refetchVersions } = usePcfVersions(activeProperty)
  const activeVersionId = versionId ?? versions?.[0]?.id ?? null
  const version = versions?.find(v => v.id === activeVersionId) ?? null
  const { data: grid, loading: gridLoading, refetch: refetchGrid } = usePcfGrid(activeVersionId)
  const { data: detail } = useLineDetail(activeProperty, drillLine, grid?.fiscalYear ?? new Date().getFullYear())

  const openingCash = version?.opening_cash ?? 0
  const totals = useMemo(
    () => (grid ? computeTotals(grid.rows, openingCash) : null),
    [grid, openingCash],
  )
  const displayRows = useMemo(
    () => (grid && totals ? buildDisplayRows(grid.rows, totals) : []),
    [grid, totals],
  )

  const isDraft = version?.status === 'draft'
  const asOf = grid?.asOfMonth ?? 0

  async function handleNewVersion() {
    if (!activeProperty) return
    const year = new Date().getFullYear()
    setBusy(true); setErr(null)
    try {
      // The boundary is read from the GL, not typed - a closed month is a fact.
      const asOfM = await latestClosedMonth(activeProperty, year)
      const id = await createPcfVersion(activeProperty, year, asOfM, null)
      setVersionId(id)
      refetchVersions()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create the version')
    } finally { setBusy(false) }
  }

  async function commitEdit() {
    if (!editing || !activeVersionId) return
    const raw = editValue.replace(/[^0-9.-]/g, '').trim()
    setBusy(true); setErr(null)
    try {
      if (raw === '') {
        // Empty means "unset this month", not "zero". Number('') is 0, which would
        // quietly put a real zero into the bridge.
        await clearPcfCell(activeVersionId, editing.lineKey, editing.month)
      } else {
        const parsed = Number(raw)
        if (Number.isNaN(parsed)) { setErr('That is not a number.'); return }
        await savePcfCell(activeVersionId, editing.lineKey, editing.month, parsed, editNote || null, user?.id ?? null)
      }
      setEditing(null); setEditNote('')
      refetchGrid()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the cell')
    } finally { setBusy(false) }
  }

  // Publishing never guesses the cash convention. bank_balance and cumulative are
  // different quantities and the firm's own two PCFs disagree, so the basis is
  // chosen explicitly here rather than defaulted into the frozen snapshot.
  async function handlePublish() {
    if (!activeVersionId) return
    setBusy(true); setErr(null)
    try {
      const opening = pubBasis === 'bank_balance' ? Number(pubOpening.replace(/[^0-9.-]/g, '')) : 0
      await publishPcfVersion(activeVersionId, pubBasis, opening, user?.id ?? null)
      setPublishing(false)
      refetchVersions()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not publish')
    } finally { setBusy(false) }
  }

  if (propsLoading) return <WidgetSkeleton />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Projected cash flow</h1>
        <select
          value={activeProperty ?? ''}
          onChange={e => { setPropertyId(e.target.value); setVersionId(null); setDrillLine(null) }}
          style={{ fontSize: 13, padding: '5px 8px' }}
        >
          {(properties ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select
          value={activeVersionId ?? ''}
          onChange={e => { setVersionId(e.target.value); setDrillLine(null) }}
          style={{ fontSize: 13, padding: '5px 8px' }}
        >
          {(versions ?? []).map(v => (
            <option key={v.id} value={v.id}>
              FY{v.fiscal_year} - actuals through {v.as_of_month === 0 ? 'none' : MONTH_ABBR[v.as_of_month - 1]}
              {v.status === 'published' ? ' (published)' : ''}
            </option>
          ))}
        </select>
        <button onClick={handleNewVersion} disabled={busy || !activeProperty} style={{ fontSize: 12, padding: '5px 10px' }}>
          New version
        </button>
        {version && isDraft && (
          <button
            onClick={() => { setPubBasis(version.cash_basis ?? 'cumulative'); setPubOpening(version.opening_cash === null ? '' : String(version.opening_cash)); setPublishing(true) }}
            disabled={busy}
            style={{ fontSize: 12, padding: '5px 10px' }}
          >
            Publish
          </button>
        )}
        {version?.status === 'published' && (
          <span style={{ fontSize: 11, padding: '3px 9px', borderRadius: 99, background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
            Published - frozen
          </span>
        )}
      </div>

      {err && (
        <div style={{ fontSize: 12, padding: '8px 12px', borderRadius: 8, background: 'var(--surface-2)', color: 'var(--red, #b91c1c)' }}>
          {err}
        </div>
      )}

      {publishing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12, padding: '10px 12px', borderRadius: 8, background: 'var(--surface-2)' }}>
          <span style={{ fontWeight: 500 }}>Publish freezes this version permanently.</span>
          <label>Cash basis</label>
          <select value={pubBasis} onChange={e => setPubBasis(e.target.value as CashBasis)} style={{ fontSize: 12, padding: '4px 6px' }}>
            <option value="cumulative">Cumulative cash generated (opens at 0)</option>
            <option value="bank_balance">Bank balance (opens at a real balance)</option>
          </select>
          {pubBasis === 'bank_balance' && (
            <input
              value={pubOpening}
              onChange={e => setPubOpening(e.target.value)}
              placeholder="Opening cash"
              style={{ fontSize: 12, padding: '4px 6px', width: 130 }}
            />
          )}
          <button onClick={handlePublish} disabled={busy} style={{ fontSize: 12, padding: '4px 10px' }}>Confirm publish</button>
          <button onClick={() => setPublishing(false)} disabled={busy} style={{ fontSize: 12, padding: '4px 10px' }}>Cancel</button>
        </div>
      )}

      {editing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12, padding: '10px 12px', borderRadius: 8, background: 'var(--surface-2)' }}>
          <span style={{ fontWeight: 500 }}>
            {grid?.rows.find(r => r.lineKey === editing.lineKey)?.label} - {MONTH_ABBR[editing.month - 1]}
          </span>
          <input
            value={editNote}
            onChange={e => setEditNote(e.target.value)}
            placeholder="Reason for the override (optional)"
            style={{ fontSize: 12, padding: '4px 6px', flex: 1, minWidth: 200 }}
          />
          <button onClick={commitEdit} disabled={busy} style={{ fontSize: 12, padding: '4px 10px' }}>Save</button>
          <button onClick={() => setEditing(null)} disabled={busy} style={{ fontSize: 12, padding: '4px 10px' }}>Cancel</button>
        </div>
      )}

      {!versions?.length && !gridLoading && (
        <Widget title="No projected cash flow yet">
          <EmptyState
            icon="📈"
            title="Create the first version"
            subtitle="Forward months seed from the approved budget, and balance-sheet lines from last complete year's actuals. Everything stays editable."
          />
        </Widget>
      )}

      {gridLoading && <WidgetSkeleton />}

      {grid && totals && (
        <Widget title={`FY${grid.fiscalYear}`} fullWidth>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ ...labelCell, textAlign: 'left', fontWeight: 500, color: 'var(--text-muted)' }}>Line</th>
                  {MONTH_ABBR.map((m, i) => (
                    <th key={m} style={{
                      ...cellBase, fontWeight: 500,
                      color: i + 1 <= asOf ? 'var(--accent)' : 'var(--text-muted)',
                      borderBottom: '1px solid var(--border)',
                      borderRight: i + 1 === asOf ? '2px solid var(--accent)' : undefined,
                    }}>
                      {m}
                      <div style={{ fontSize: 9, fontWeight: 400, letterSpacing: '.04em' }}>
                        {i + 1 <= asOf ? 'actual' : 'forecast'}
                      </div>
                    </th>
                  ))}
                  <th style={{ ...cellBase, fontWeight: 500, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>FY</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((dr, idx) => {
                  if (dr.kind === 'spacer') return <tr key={idx}><td colSpan={14} style={{ height: 10 }} /></tr>
                  if (dr.kind === 'section') return (
                    <tr key={idx}>
                      <td style={{ ...labelCell, fontWeight: 500, color: 'var(--text-muted)', fontSize: 11, letterSpacing: '.03em', paddingTop: 8 }}>
                        {dr.label}
                      </td>
                      <td colSpan={13} />
                    </tr>
                  )
                  if (dr.kind === 'subtotal') return (
                    <tr key={idx} style={{ borderTop: '1px solid var(--border)', background: dr.strong ? 'var(--surface-2)' : undefined }}>
                      <td style={{ ...labelCell, fontWeight: 500, background: dr.strong ? 'var(--surface-2)' : 'var(--surface)' }}>{dr.label}</td>
                      {dr.values.map((v, i) => (
                        <td key={i} style={{ ...cellBase, fontWeight: 500, borderRight: i + 1 === asOf ? '2px solid var(--accent)' : undefined }}>{fmt(v)}</td>
                      ))}
                      <td style={{ ...cellBase, fontWeight: 500 }}>{fmt(dr.values.reduce((s, v) => s + v, 0))}</td>
                    </tr>
                  )

                  const row = dr.row
                  return (
                    <tr key={row.lineKey} style={{ background: drillLine === row.lineKey ? 'var(--surface-2)' : undefined }}>
                      <td style={{ ...labelCell, background: drillLine === row.lineKey ? 'var(--surface-2)' : 'var(--surface)' }}>
                        <button
                          onClick={() => setDrillLine(drillLine === row.lineKey ? null : row.lineKey)}
                          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', color: 'var(--text)', textAlign: 'left' }}
                        >
                          {row.label}
                        </button>
                        {!row.hasBudgetSeed && (
                          <span title="No budget line maps to this row, so forward months start blank" style={{ marginLeft: 6, fontSize: 10, color: 'var(--amber, #b45309)' }}>
                            no budget coverage
                          </span>
                        )}
                        {row.isNonCash && (
                          <span title="In net income, excluded from the cash bridge" style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-faint)' }}>
                            non-cash
                          </span>
                        )}
                      </td>
                      {row.cells.map((c, i) => {
                        const isEditing = editing?.lineKey === row.lineKey && editing?.month === c.month
                        const editable = isDraft && !c.isActual
                        if (isEditing) return (
                          <td key={i} style={{ ...cellBase, padding: 2 }}>
                            {/* No commit-on-blur: the reason field lives outside this cell,
                                and blurring into it must not save the value first. */}
                            <input
                              autoFocus
                              value={editValue}
                              onChange={e => setEditValue(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') commitEdit()
                                if (e.key === 'Escape') setEditing(null)
                              }}
                              style={{ width: 72, fontSize: 12, textAlign: 'right', padding: '2px 4px' }}
                            />
                          </td>
                        )
                        return (
                          <td
                            key={i}
                            onClick={() => {
                              if (!editable) return
                              setEditing({ lineKey: row.lineKey, month: c.month })
                              setEditValue(c.amount === null ? '' : String(Math.round(c.amount)))
                              setEditNote(c.note ?? '')
                            }}
                            title={
                              c.method === 'derived_schedule' && c.derivedFromYear
                                ? `Seeded from ${c.derivedFromYear} actuals - editable`
                                : c.method === 'budget' ? 'Seeded from the approved budget - editable'
                                : c.method === 'manual' ? (c.note ? `Override: ${c.note}` : 'Manual override')
                                : c.isActual ? 'Closed month, from the GL' : undefined
                            }
                            style={{
                              ...cellBase,
                              cursor: editable ? 'text' : 'default',
                              color: c.amount === null ? 'var(--text-faint)' : 'var(--text)',
                              background: c.method === 'manual' ? 'var(--surface-2)' : undefined,
                              borderRight: c.month === asOf ? '2px solid var(--accent)' : undefined,
                            }}
                          >
                            {fmt(c.amount)}
                            {c.method === 'manual' && <span style={{ marginLeft: 3, fontSize: 9, color: 'var(--text-faint)' }}>*</span>}
                          </td>
                        )
                      })}
                      <td style={{ ...cellBase, color: 'var(--text-muted)' }}>{fmt(row.fyTotal)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Widget>
      )}

      {drillLine && detail && (
        <Widget title={`Behind this line: ${grid?.rows.find(r => r.lineKey === drillLine)?.label ?? drillLine}`} fullWidth>
          {!detail.accounts.length ? (
            <EmptyState
              icon="🔎"
              title="No GL accounts map here yet"
              subtitle="This line has no posted history at this property, so a forward month has to be entered from judgment."
            />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 20 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                  Mapped GL accounts ({detail.accounts.length})
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>
                    {detail.accounts.map(a => (
                      <tr key={a.accountCode}>
                        <td style={{ fontSize: 11, padding: '3px 0', color: 'var(--text-muted)', fontFamily: 'var(--font-mono, monospace)' }}>{a.accountCode}</td>
                        <td style={{ fontSize: 11, padding: '3px 8px' }}>{a.accountName}</td>
                        <td style={{ ...cellBase, fontSize: 11, padding: '3px 0' }}>{fmt(a.cashEffect)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                  Trailing history ({detail.history.length} months)
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>
                    {detail.history.slice(-12).map(h => (
                      <tr key={`${h.year}-${h.month}`}>
                        <td style={{ fontSize: 11, padding: '3px 0', color: 'var(--text-muted)' }}>
                          {MONTH_ABBR[h.month - 1]} {h.year}
                        </td>
                        <td style={{ ...cellBase, fontSize: 11, padding: '3px 0' }}>{fmt(h.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Widget>
      )}
    </div>
  )
}
