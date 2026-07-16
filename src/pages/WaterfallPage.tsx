import { useState, useMemo, useEffect, type CSSProperties, type ReactNode } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useDeals, type DealRow, type SellTodayConfig } from '../hooks/useDeals'
import { getWaterfallDefaults, useGlNca } from '../hooks/useWaterfallDefaults'
import { Widget, WidgetSkeleton } from '../components/ui/Widget'
import { EmptyState } from '../components/ui/EmptyState'
import {
  computeSellToday, xirr,
  type SellTodayInput, type SellTodayResult, type IrrPosition, type DatedFlow, type SeniorClassPosition,
} from '../lib/waterfall'
import { PdfDownloadButton } from '../reports/PdfDownloadButton'
import type { WaterfallXlsxInput, WfClass } from '../reports/waterfallExcel'
import { AgreementQaBadge, AgreementQaPanel } from '../components/AgreementQaPanel'
import { AgreementAbstractPanel } from '../components/AgreementAbstractPanel'
import { AgreementAbstractPdfButton } from '../reports/AgreementAbstractPdfButton'

const usd = (n: number, dp = 0) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: dp })
const usdM = (n: number) => '$' + (n / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + 'M'
const pct = (n: number | null | undefined, dp = 1) =>
  n == null || !isFinite(n) ? '—' : (n * 100).toFixed(dp) + '%'
const mult = (n: number | null | undefined) =>
  n == null || !isFinite(n) ? '—' : n.toFixed(2) + 'x'
const todayIso = () => new Date().toISOString().slice(0, 10)

// ── assemble engine input from a property's L1/L2 deals ───────────────────

interface PropertyGroup {
  propertyId: string
  name: string
  l1: DealRow
  l2: DealRow | null
}

interface Inputs {
  grossValue: number
  closingPct: number      // percent, e.g. 1.5
  nca: number
  payoff: number
  payoffLabel: string
  entityCash: number
  asOf: string
}

function defaultInputs(g: PropertyGroup, glNca: number | null): Inputs {
  const c1: SellTodayConfig = g.l1.selltoday ?? {}
  const c2: SellTodayConfig = g.l2?.selltoday ?? {}
  const stored = getWaterfallDefaults(g.l1)

  return {
    grossValue: c1.gross_value ?? 0,
    closingPct: (c1.closing_cost_pct ?? stored.closingCostPct / 100) * 100,
    // GL-derived NCA wins; the stored config value is the fallback when no GL is loaded.
    nca: glNca ?? c1.nca ?? stored.nca,
    payoff: c1.payoff ?? stored.payoff,
    payoffLabel: c1.payoff_label ?? stored.payoffLabel,
    entityCash: c2.entity_cash ?? 0,
    asOf: todayIso(),
  }
}

const CLOSING_PRESETS = [0.5, 1.0, 1.5, 2.0]

function flowsByRoles(d: DealRow, roles: string[]): DatedFlow[] {
  return d.capital_flows
    .filter(f => roles.includes(f.role))
    .map(f => ({ date: f.flow_date, amount: Number(f.amount) }))
}

function runSellToday(g: PropertyGroup, inp: Inputs): SellTodayResult | null {
  const c1: SellTodayConfig = g.l1.selltoday ?? {}
  const lpFlows = flowsByRoles(g.l1, ['lp'])
  if (lpFlows.length === 0) return null
  const positions: IrrPosition[] = [
    { investorId: 'lp', type: 'lp', flows: lpFlows },
    { investorId: 'gp', type: 'gp', flows: flowsByRoles(g.l1, ['gp']) },
  ]
  let l2: SellTodayInput['l2']
  if (g.l2) {
    const c2: SellTodayConfig = g.l2.selltoday ?? {}
    const dFlows = flowsByRoles(g.l2, ['class_d'])
    const seniorClasses: SeniorClassPosition[] = dFlows.length > 0
      ? [{ investorId: 'class_d', flows: dFlows, irrCap: c2.class_d_caps?.irr ?? 0.15, emCap: c2.class_d_caps?.em ?? 2.0 }]
      : []
    l2 = {
      entityCash: inp.entityCash,
      lpFlows: flowsByRoles(g.l2, ['class_a', 'class_ac', 'class_c']),
      gpFlows: flowsByRoles(g.l2, ['class_b']),
      seniorClasses,
      tiers: g.l2.waterfall_tiers,
    }
  }
  return computeSellToday({
    asOfDate: inp.asOf,
    grossValue: inp.grossValue,
    closingCostPct: inp.closingPct / 100,
    netCurrentAssets: inp.nca,
    payoff: inp.payoff,
    l1: {
      positions,
      tiers: g.l1.waterfall_tiers,
      freezeDate: c1.freeze_date ?? null,
      saleOverride: c1.override ? { threshold: c1.override.threshold, lpShare: c1.override.lp, gpShare: c1.override.gp } : null,
      cashSplit: c1.cash_split ? { lpShare: c1.cash_split.lp, gpShare: c1.cash_split.gp } : null,
    },
    l2,
  })
}

// ── page ──────────────────────────────────────────────────────────────────

export function WaterfallPage() {
  const { appUser } = useAuth()
  const { data: deals, loading, error } = useDeals()

  const groups = useMemo<PropertyGroup[]>(() => {
    const byProp = new Map<string, PropertyGroup>()
    for (const d of deals ?? []) {
      const key = d.property_id
      const g = byProp.get(key) ?? { propertyId: key, name: d.properties?.name ?? 'Unknown', l1: null as unknown as DealRow, l2: null }
      if (d.layer === 2) g.l2 = d
      else g.l1 = d
      byProp.set(key, g)
    }
    return [...byProp.values()].filter(g => g.l1 && g.l1.capital_flows.some(f => f.role === 'lp'))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [deals])

  const [propId, setPropId] = useState<string | null>(null)
  useEffect(() => {
    if (!propId && groups.length > 0) setPropId(groups[0].propertyId)
  }, [groups, propId])
  const sel = useMemo(() => groups.find(g => g.propertyId === propId) ?? null, [groups, propId])

  const { data: glNca } = useGlNca(propId)
  // useQuery retains the prior property's data until the new fetch resolves, so `glNca`
  // may momentarily belong to the previously selected property. Only ever treat it as the
  // current property's figure once its propertyId matches — otherwise a Gateway NCA leaks
  // into Knightdale (which has no GL) and inflates its sold-today math.
  const glForSel = sel && glNca && glNca.propertyId === sel.propertyId ? glNca : null
  const [inputs, setInputs] = useState<Inputs | null>(null)
  const [ncaTouched, setNcaTouched] = useState(false)
  // On every tab switch, re-seed from the new property's own defaults (stored config unless a
  // matching GL figure is already in hand) and clear any prior manual override.
  useEffect(() => {
    if (sel) { setInputs(defaultInputs(sel, glForSel?.nca ?? null)); setNcaTouched(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel])
  // When the GL figure for THIS property arrives after the initial seed, adopt it unless the
  // user has typed an override. Gating on glForSel (not glNca) prevents the stale prior-property
  // figure from being applied during the refetch window.
  useEffect(() => {
    if (glForSel && !ncaTouched) {
      setInputs(i => (i && i.nca !== glForSel.nca ? { ...i, nca: glForSel.nca } : i))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glForSel, sel])

  const result = useMemo(() => (sel && inputs ? runSellToday(sel, inputs) : null), [sel, inputs])

  const sensitivity = useMemo(() => {
    if (!sel || !inputs || !inputs.grossValue) return []
    return [0.9, 0.95, 1.0, 1.05, 1.1].map(m => ({
      m,
      gross: inputs.grossValue * m,
      r: runSellToday(sel, { ...inputs, grossValue: inputs.grossValue * m }),
    }))
  }, [sel, inputs])

  // Per-class return metrics (contributed / distributed / sale take / pro-forma IRR / multiple)
  const classMetrics = useMemo(() => {
    if (!sel?.l2 || !result?.l2 || !inputs) return null
    const mk = (flows: DatedFlow[], take: number) => {
      const contrib = flows.filter(f => f.amount < 0).reduce((s, f) => s - f.amount, 0)
      const prior = flows.filter(f => f.amount > 0).reduce((s, f) => s + f.amount, 0)
      return {
        contrib, prior, take,
        irr: contrib > 0 ? xirr([...flows, { date: inputs.asOf, amount: take }]) : null,
        em: contrib > 0 ? (prior + take) / contrib : null,
      }
    }
    const dFlows = flowsByRoles(sel.l2, ['class_d'])
    return {
      d: dFlows.length > 0 ? mk(dFlows, Object.values(result.l2.seniorClassValues).reduce((s, v) => s + v, 0)) : null,
      a: mk(flowsByRoles(sel.l2, ['class_a', 'class_ac', 'class_c']), result.l2.classAValue),
      b: mk(flowsByRoles(sel.l2, ['class_b']), result.l2.classBValue),
    }
  }, [sel, result, inputs])

  // B-unit breakeven: the gross value at which Class B starts (or stops) receiving.
  const bBreakeven = useMemo(() => {
    if (!sel?.l2 || !inputs || !result?.l2 || !inputs.grossValue) return null
    const bAt = (gv: number) => runSellToday(sel, { ...inputs, grossValue: gv })?.l2?.classBValue ?? 0
    if (result.l2.classBValue > 0.5) {
      let lo = 1, hi = inputs.grossValue
      if (bAt(lo) > 0.5) return { kind: 'always' as const, gross: null }
      for (let i = 0; i < 44; i++) { const m = (lo + hi) / 2; if (bAt(m) > 0.5) hi = m; else lo = m }
      return { kind: 'itm' as const, gross: hi }
    }
    let hi = inputs.grossValue
    let found = false
    for (let i = 0; i < 14; i++) { hi *= 1.25; if (bAt(hi) > 0.5) { found = true; break } }
    if (!found) return { kind: 'far' as const, gross: null }
    let lo = inputs.grossValue
    for (let i = 0; i < 44; i++) { const m = (lo + hi) / 2; if (bAt(m) > 0.5) hi = m; else lo = m }
    return { kind: 'otm' as const, gross: hi }
  }, [sel, inputs, result])

  if (appUser?.role !== 'admin' && appUser?.role !== 'asset_manager') {
    return (
      <div style={{ padding: '40px 32px', color: 'var(--text-muted)', fontSize: 14 }}>
        You need admin or asset manager access to view the waterfall.
      </div>
    )
  }

  const c1 = sel?.l1.selltoday ?? {}
  const units = sel?.l2?.selltoday?.units ?? {}
  const seniorUnits = units['AC'] ?? units['A'] ?? 0
  const lpName = sel?.l1.capital_flows.find(f => f.role === 'lp')?.party ?? 'Institutional partner'
  const l2Name = sel?.l2 ? (sel.l2.name.match(/M&J [A-Za-z ]*Investors/)?.[0] ?? 'M&J entity') : null

  // Assemble the Excel payload from the live engine result (see reports/waterfallExcel.ts).
  function buildWaterfallPayload(): WaterfallXlsxInput | null {
    if (!sel || !inputs || !result) return null
    const roc = result.l1.lineItems
      .filter(li => li.tierType === 'return_of_capital' && li.investorType === 'lp')
      .reduce((s, li) => s + li.amount, 0)
    const classes: WfClass[] = []
    if (sel.l2 && result.l2 && classMetrics) {
      const seniorLabel = units['AC'] != null ? 'A/C' : 'A'
      if (classMetrics.d) classes.push({ key: 'D', label: 'Class D (senior)', contrib: classMetrics.d.contrib, prior: classMetrics.d.prior, take: classMetrics.d.take, irr: classMetrics.d.irr, unitKey: 'D', flows: flowsByRoles(sel.l2, ['class_d']) })
      classes.push({ key: 'A', label: `Class ${seniorLabel}`, contrib: classMetrics.a.contrib, prior: classMetrics.a.prior, take: classMetrics.a.take, irr: classMetrics.a.irr, unitKey: units['AC'] != null ? 'AC' : 'A', flows: flowsByRoles(sel.l2, ['class_a', 'class_ac', 'class_c']) })
      classes.push({ key: 'B', label: 'Class B (promote)', contrib: classMetrics.b.contrib, prior: classMetrics.b.prior, take: classMetrics.b.take, irr: null, unitKey: 'B', flows: flowsByRoles(sel.l2, ['class_b']) })
    }
    return {
      propertyName: sel.name,
      asOf: inputs.asOf,
      deemedDate: c1.freeze_date ?? inputs.asOf,
      generatedAt: new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }),
      lpName,
      l2Name,
      inputs: {
        grossValue: inputs.grossValue, closingPct: inputs.closingPct, nca: inputs.nca,
        payoff: inputs.payoff, payoffLabel: inputs.payoffLabel, entityCash: inputs.entityCash,
      },
      override: c1.override ? { threshold: c1.override.threshold, lp: c1.override.lp, gp: c1.override.gp } : null,
      cashSplit: c1.cash_split ? { lp: c1.cash_split.lp, gp: c1.cash_split.gp } : null,
      freezeDate: c1.freeze_date ?? null,
      result: {
        priceNetOfCosts: result.priceNetOfCosts,
        overrideExcess: result.overrideExcess, overrideLp: result.overrideLp, overrideGp: result.overrideGp,
        cashLp: result.cashLp, cashGp: result.cashGp, ladderPool: result.ladderPool,
        ladderLpTake: result.l1.lpTake, ladderGpTake: result.l1.gpTake,
        returnOfCapital: roc, residualCash: result.l1.residualCash,
        l1LpContrib: result.l1LpContrib, l1LpPriorDist: result.l1LpPriorDist,
        l1LpTotal: result.l1LpTotal, l1LpIrr: result.l1LpIrr, l1GpTotal: result.l1GpTotal,
        tiers: result.l1.tierResults.map(t => ({
          order: t.tierOrder, lpSplit: t.lpSplit, gpSplit: t.gpSplit,
          hurdleIrr: t.hurdleIrr, hurdleEm: t.hurdleEm, lp: t.lp, gp: t.gp,
          reachedHurdle: t.reachedHurdle, emGoverned: t.emGoverned,
        })),
      },
      l1LpFlows: flowsByRoles(sel.l1, ['lp']),
      l1GpFlows: flowsByRoles(sel.l1, ['gp']),
      l2: sel.l2 && result.l2 ? { pool: result.l2.pool, units, classes } : null,
      sensitivity: sensitivity.map(s => ({
        m: s.m, gross: s.gross,
        l1LpTotal: s.r?.l1LpTotal ?? 0, l1LpIrr: s.r?.l1LpIrr ?? null, l1GpTotal: s.r?.l1GpTotal ?? 0,
        classBValue: s.r?.l2?.classBValue ?? null,
        bPerUnit: units['B'] && s.r?.l2 ? (s.r.l2.classBValue) / units['B'] : null,
      })),
    }
  }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1160 }}>
      <div style={{ marginBottom: 4, fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>Waterfall — Sold Today</div>
      <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--text-muted)' }}>
        Where the promote and returns land if the property sold at the as-of date — computed on each partner's
        actual dated capital flows, through both waterfall layers, down to per-unit values in the M&J entity.
      </div>

      {loading && <WidgetSkeleton rows={6} />}
      {error && <EmptyState title="Couldn't load deals" subtitle={error} />}
      {!loading && groups.length === 0 && (
        <EmptyState title="No sell-today deals" subtitle="Load capital_flows history for at least one JV deal." />
      )}

      {sel && inputs && (
        <>
          {/* Property tabs */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
            {groups.map(g => (
              <button key={g.propertyId} onClick={() => setPropId(g.propertyId)} style={{
                padding: '7px 14px', fontSize: 13, fontWeight: 600, borderRadius: 8, cursor: 'pointer',
                border: '1px solid ' + (g.propertyId === propId ? 'var(--accent)' : 'var(--border)'),
                background: g.propertyId === propId ? 'var(--accent-soft, rgba(59,130,246,0.12))' : 'var(--surface)',
                color: g.propertyId === propId ? 'var(--accent)' : 'var(--text-muted)',
              }}>
                {g.name}
              </button>
            ))}
            <span style={{ flex: 1 }} />
            <PdfDownloadButton
              label="⬇ Excel (formulas)"
              busyLabel="Generating Excel…"
              filename={`Wilkow-Waterfall-${sel.name.replace(/[^\w.-]+/g, '-')}-${inputs.asOf}.xlsx`}
              disabled={!result}
              title={!result ? 'Set a gross value to compute the waterfall first' : 'Download a live Excel workbook (Sources & Uses formulas, XIRR, methodology)'}
              build={async () => {
                const payload = buildWaterfallPayload()
                if (!payload) throw new Error('Waterfall not computed yet')
                const { buildWaterfallXlsx } = await import('../reports/waterfallExcel')
                return buildWaterfallXlsx(payload)
              }}
            />
          </div>

          {/* Governing operating agreements — the verified brief-synthesis
              abstract behind each JV layer's modeled waterfall, plus the
              independent verification verdict (agreement-abstract/verify
              kind=jv). Backs the "tier terms verified against the executed
              operating agreements" note below. */}
          {(sel.l1.abstract || sel.l2?.abstract) && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 8 }}>
                Governing operating agreements
              </div>
              {[sel.l1, sel.l2].filter((d): d is DealRow => !!d && !!d.abstract).map(d => (
                <div key={d.id} style={{ marginBottom: 10, padding: '11px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{d.name}</span>
                    <AgreementQaBadge status={d.qa_status} />
                    <span style={{ flex: 1 }} />
                    <AgreementAbstractPdfButton kind="jv" name={d.name} abstract={d.abstract} qa={d.qa} qaStatus={d.qa_status} qaAt={d.qa_at} />
                  </div>
                  <AgreementAbstractPanel kind="jv" abstract={d.abstract} />
                  {d.qa && <AgreementQaPanel qa={d.qa} qaStatus={d.qa_status} qaAt={d.qa_at} />}
                </div>
              ))}
            </div>
          )}

          {/* Inputs */}
          <div style={{ display: 'flex', gap: 14, rowGap: 12, flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: 18 }}>
            <Field label="Gross value ($)"><NumInput value={inputs.grossValue} step={1_000_000} onChange={v => setInputs({ ...inputs, grossValue: v })} wide /></Field>
            <Field label="Closing costs">
              <select
                value={CLOSING_PRESETS.includes(inputs.closingPct) ? String(inputs.closingPct) : 'custom'}
                onChange={e => { if (e.target.value !== 'custom') setInputs({ ...inputs, closingPct: parseFloat(e.target.value) }) }}
                style={selectStyle}
              >
                {CLOSING_PRESETS.map(p => <option key={p} value={String(p)}>{p.toFixed(2)}%</option>)}
                {!CLOSING_PRESETS.includes(inputs.closingPct) && <option value="custom">{inputs.closingPct.toFixed(2)}% (custom)</option>}
              </select>
            </Field>
            <Field
              label="Net current assets ($)"
              caption={glForSel
                ? (inputs.nca === glForSel.nca ? `from GL balance sheet (${glForSel.gl_year})` : 'manual override')
                : 'stored default (no GL)'}
            >
              <div style={{ display: 'flex', gap: 4 }}>
                <NumInput value={inputs.nca} step={50_000} onChange={v => { setNcaTouched(true); setInputs({ ...inputs, nca: v }) }} wide />
                {glForSel && inputs.nca !== glForSel.nca && (
                  <button
                    title={`Reset to GL: ${usd(glForSel.nca)}`}
                    onClick={() => { setNcaTouched(false); setInputs({ ...inputs, nca: glForSel.nca }) }}
                    style={{ ...resetStyle, padding: '4px 8px' }}
                  >GL ↺</button>
                )}
              </div>
            </Field>
            <Field label={inputs.payoffLabel + ' ($)'}><NumInput value={inputs.payoff} step={500_000} min={0} onChange={v => setInputs({ ...inputs, payoff: v })} wide /></Field>
            {sel.l2 && <Field label="Entity cash ($)"><NumInput value={inputs.entityCash} step={10_000} onChange={v => setInputs({ ...inputs, entityCash: v })} wide /></Field>}
            <Field label="As of">
              <input type="date" value={inputs.asOf} onChange={e => setInputs({ ...inputs, asOf: e.target.value })} style={dateStyle} />
            </Field>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'transparent' }}>.</span>
              <button onClick={() => { setInputs(defaultInputs(sel, glForSel?.nca ?? null)); setNcaTouched(false) }} style={resetStyle}>Reset defaults</button>
            </div>
          </div>

          {result && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14, marginBottom: 16 }}>
                {/* Sources & uses */}
                <Widget title="Sale proceeds" chip={usdM(inputs.grossValue) + ' gross'}>
                  <Row k="Gross value" v={usd(inputs.grossValue)} />
                  <Row k={`Closing costs (${inputs.closingPct.toFixed(2)}%)`} v={'−' + usd(inputs.grossValue - result.priceNetOfCosts)} />
                  {result.overrideExcess > 0.5 && c1.override && (
                    <Row k={`Excess over ${usdM(c1.override.threshold)} → ${pct(c1.override.lp, 0)}/${pct(c1.override.gp, 0)}`} v={'−' + usd(result.overrideExcess)} accent />
                  )}
                  <Row k={inputs.payoffLabel} v={'−' + usd(inputs.payoff)} />
                  {c1.cash_split
                    ? <Row k={`Net current assets → ${pct(c1.cash_split.lp, 0)}/${pct(c1.cash_split.gp, 0)} (per JV agreement)`} v={usd(inputs.nca)} />
                    : <Row k="Net current assets (into pool)" v={(inputs.nca < 0 ? '−' : '+') + usd(Math.abs(inputs.nca))} />}
                  <div style={{ height: 1, background: 'var(--border)', margin: '8px 0' }} />
                  <Row k="Waterfall pool" v={usd(result.ladderPool)} accent />
                </Widget>

                {/* Layer 1 */}
                <Widget title="Layer 1 — JV waterfall" chip={c1.freeze_date ? `hurdles frozen ${c1.freeze_date}` : 'IRR hurdles live'}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)', marginBottom: 2 }}>{lpName}</div>
                  <Row k="Contributed / distributed to date" v={`${usd(result.l1LpContrib)} / ${usd(result.l1LpPriorDist)}`} />
                  <Row k="Sale distribution" v={usd(result.l1LpTotal)} />
                  <Row k="IRR / multiple (if sold today)" v={`${pct(result.l1LpIrr)} / ${mult(result.l1LpEm)}`} />
                  <div style={{ height: 1, background: 'var(--border)', margin: '8px 0' }} />
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)', marginBottom: 2 }}>M&J Wilkow (sponsor)</div>
                  <Row k="Sale distribution (all legs)" v={usd(result.l1GpTotal)} accent />
                  {result.overrideGp > 0.5 && <Row k="· of which sale-price override" v={usd(result.overrideGp)} />}
                  {result.cashGp > 0.5 && <Row k="· of which cash-on-hand split" v={usd(result.cashGp)} />}
                  <Row k="Share of total" v={pct(result.l1LpTotal + result.l1GpTotal > 0 ? result.l1GpTotal / (result.l1LpTotal + result.l1GpTotal) : 0)} />
                </Widget>

              </div>

              {/* Layer 2 — class returns */}
              {sel.l2 && result.l2 && classMetrics && (
                <div style={{ marginBottom: 16 }}>
                  <Widget title={`Layer 2 — ${l2Name} class returns`} chip={`${usd(result.l2.pool)} pool (MJW take + entity cash)`} fullWidth>
                    <table style={tblStyle}>
                      <thead>
                        <tr style={{ textAlign: 'left', color: 'var(--text-faint)', fontSize: 11 }}>
                          <th style={th}>Class</th>
                          <th style={{ ...th, textAlign: 'right' }}>Contributed</th>
                          <th style={{ ...th, textAlign: 'right' }}>Distributed to date</th>
                          <th style={{ ...th, textAlign: 'right' }}>Sold-today proceeds</th>
                          <th style={{ ...th, textAlign: 'right' }}>IRR (if sold today)</th>
                          <th style={{ ...th, textAlign: 'right' }}>Multiple</th>
                          <th style={{ ...th, textAlign: 'right' }}>Per unit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {classMetrics.d && (
                          <tr style={{ borderTop: '1px solid var(--border)' }}>
                            <td style={td}>Class D (senior)</td>
                            <td style={{ ...td, textAlign: 'right' }}>{usd(classMetrics.d.contrib)}</td>
                            <td style={{ ...td, textAlign: 'right' }}>{usd(classMetrics.d.prior)}</td>
                            <td style={{ ...td, textAlign: 'right' }}>{usd(classMetrics.d.take)}</td>
                            <td style={{ ...td, textAlign: 'right' }}>{pct(classMetrics.d.irr)}</td>
                            <td style={{ ...td, textAlign: 'right' }}>{mult(classMetrics.d.em)}</td>
                            <td style={{ ...td, textAlign: 'right' }}>{units['D'] ? usd(classMetrics.d.take / units['D'], 2) : '—'}</td>
                          </tr>
                        )}
                        <tr style={{ borderTop: '1px solid var(--border)' }}>
                          <td style={td}>Class {units['AC'] != null ? 'A/C' : 'A'}</td>
                          <td style={{ ...td, textAlign: 'right' }}>{usd(classMetrics.a.contrib)}</td>
                          <td style={{ ...td, textAlign: 'right' }}>{usd(classMetrics.a.prior)}</td>
                          <td style={{ ...td, textAlign: 'right' }}>{usd(classMetrics.a.take)}</td>
                          <td style={{ ...td, textAlign: 'right' }}>{pct(classMetrics.a.irr)}</td>
                          <td style={{ ...td, textAlign: 'right' }}>{mult(classMetrics.a.em)}</td>
                          <td style={{ ...td, textAlign: 'right' }}>{seniorUnits ? usd(classMetrics.a.take / seniorUnits, 2) : '—'}</td>
                        </tr>
                        <tr style={{ borderTop: '1px solid var(--border)', fontWeight: 600 }}>
                          <td style={{ ...td, color: 'var(--accent)' }}>Class B (promote)</td>
                          <td style={{ ...td, textAlign: 'right' }}>{usd(classMetrics.b.contrib)}</td>
                          <td style={{ ...td, textAlign: 'right' }}>{usd(classMetrics.b.prior)}</td>
                          <td style={{ ...td, textAlign: 'right', color: 'var(--accent)' }}>{usd(classMetrics.b.take)}</td>
                          <td style={{ ...td, textAlign: 'right', color: 'var(--text-faint)' }}>—</td>
                          <td style={{ ...td, textAlign: 'right', color: 'var(--text-faint)' }}>—</td>
                          <td style={{ ...td, textAlign: 'right', color: 'var(--accent)' }}>{units['B'] ? usd(classMetrics.b.take / units['B'], 2) : '—'}</td>
                        </tr>
                      </tbody>
                    </table>
                    {bBreakeven && (
                      <div style={{ marginTop: 10, padding: '9px 12px', borderRadius: 8, fontSize: 12, lineHeight: 1.5,
                                    background: 'var(--accent-soft, rgba(59,130,246,0.10))', color: 'var(--text)' }}>
                        {bBreakeven.kind === 'otm' && bBreakeven.gross != null && (
                          <>💡 B units go into the money at a gross value of about <b>{usdM(bBreakeven.gross)}</b>
                          {' '}({pct(bBreakeven.gross / inputs.grossValue - 1, 0)} above the current {usdM(inputs.grossValue)}) —
                          the point where {classMetrics.d ? 'Class D and ' : ''}Class {units['AC'] != null ? 'A/C' : 'A'} clear their preferences at sale.</>
                        )}
                        {bBreakeven.kind === 'itm' && bBreakeven.gross != null && (
                          <>💡 B units are <b>in the money</b> at the current value — they hold value down to a gross value of
                          about <b>{usdM(bBreakeven.gross)}</b> ({pct(1 - bBreakeven.gross / inputs.grossValue, 0)} below the current {usdM(inputs.grossValue)}).</>
                        )}
                        {bBreakeven.kind === 'far' && (
                          <>B units stay out of the money even at several multiples of the current value under these inputs.</>
                        )}
                        {bBreakeven.kind === 'always' && (
                          <>B units hold value across the tested value range.</>
                        )}
                      </div>
                    )}
                  </Widget>
                </div>
              )}

              {/* Tier detail */}
              <Widget title="Layer 1 tier detail" chip={`${result.l1.tierResults.length} tiers evaluated`} fullWidth>
                <table style={tblStyle}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--text-faint)', fontSize: 11 }}>
                      <th style={th}>Leg</th><th style={th}>Split (LP/MJW)</th><th style={th}>Hurdle</th>
                      <th style={{ ...th, textAlign: 'right' }}>{lpName}</th>
                      <th style={{ ...th, textAlign: 'right' }}>MJW</th>
                      <th style={th}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.l1.lineItems.filter(li => li.tierType === 'return_of_capital').length > 0 && (
                      <tr style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={td}>Return of capital</td><td style={td}>100/0</td><td style={td}>—</td>
                        <td style={{ ...td, textAlign: 'right' }}>{usd(result.l1.lineItems.filter(li => li.tierType === 'return_of_capital').reduce((s, li) => s + li.amount, 0))}</td>
                        <td style={{ ...td, textAlign: 'right' }}>—</td><td style={td} />
                      </tr>
                    )}
                    {result.l1.tierResults.map(t => (
                      <tr key={t.tierOrder} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={td}>Tier {t.tierOrder}</td>
                        <td style={td}>{Math.round(t.lpSplit * 100)}/{Math.round(t.gpSplit * 100)}</td>
                        <td style={td}>
                          {t.hurdleIrr == null && t.hurdleEm == null ? 'residual'
                            : [t.hurdleIrr != null ? pct(t.hurdleIrr, 0) + ' IRR' : null, t.hurdleEm != null ? t.hurdleEm.toFixed(2) + 'x' : null]
                                .filter(Boolean).join(' / ')}
                        </td>
                        <td style={{ ...td, textAlign: 'right' }}>{usd(t.lp)}</td>
                        <td style={{ ...td, textAlign: 'right', color: 'var(--accent)' }}>{usd(t.gp)}</td>
                        <td style={{ ...td, color: t.reachedHurdle ? 'var(--text-faint)' : 'var(--warn, #b45309)' }}>
                          {t.hurdleIrr == null && t.hurdleEm == null ? 'residual'
                            : t.reachedHurdle ? (t.emGoverned ? 'met (EM governed)' : 'met') : 'cash exhausted'}
                        </td>
                      </tr>
                    ))}
                    {result.overrideExcess > 0.5 && (
                      <tr style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={td}>Sale-price override</td>
                        <td style={td}>{c1.override ? `${Math.round(c1.override.lp * 100)}/${Math.round(c1.override.gp * 100)}` : ''}</td>
                        <td style={td}>&gt; {usdM(c1.override?.threshold ?? 0)}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{usd(result.overrideLp)}</td>
                        <td style={{ ...td, textAlign: 'right', color: 'var(--accent)' }}>{usd(result.overrideGp)}</td>
                        <td style={{ ...td, color: 'var(--text-faint)' }}>outside IRR ladder</td>
                      </tr>
                    )}
                    {(result.cashLp > 0.5 || result.cashGp > 0.5) && (
                      <tr style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={td}>Cash on hand</td>
                        <td style={td}>{c1.cash_split ? `${Math.round(c1.cash_split.lp * 100)}/${Math.round(c1.cash_split.gp * 100)}` : ''}</td>
                        <td style={td}>—</td>
                        <td style={{ ...td, textAlign: 'right' }}>{usd(result.cashLp)}</td>
                        <td style={{ ...td, textAlign: 'right', color: 'var(--accent)' }}>{usd(result.cashGp)}</td>
                        <td style={{ ...td, color: 'var(--text-faint)' }}>Net Cash Flow leg</td>
                      </tr>
                    )}
                  </tbody>
                </table>
                {result.l1.residualCash > 0.5 && (
                  <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-faint)' }}>Residual (undistributed): {usd(result.l1.residualCash)}</div>
                )}
              </Widget>

              {/* Per-investor roster — secondary detail, collapsed by default */}
              {sel.l2 && result.l2 && sel.l2.entity_investors.length > 0 && (
                <details style={{ marginTop: 14 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', padding: '4px 2px' }}>
                    Per-investor detail — Class A holders ({sel.l2.entity_investors.length})
                  </summary>
                  <div style={{ marginTop: 8 }}>
                    <InvestorAccounts
                      l2={sel.l2}
                      l2Name={l2Name ?? 'M&J entity'}
                      classAValue={result.l2.classAValue}
                      classBValue={result.l2.classBValue}
                      seniorClassValues={result.l2.seniorClassValues}
                      units={units}
                    />
                  </div>
                </details>
              )}

              {/* Sensitivity */}
              <div style={{ marginTop: 14 }}>
                <Widget title="Value sensitivity" chip="gross value ±10%" fullWidth>
                  <table style={tblStyle}>
                    <thead>
                      <tr style={{ textAlign: 'left', color: 'var(--text-faint)', fontSize: 11 }}>
                        <th style={th}>Gross value</th>
                        <th style={{ ...th, textAlign: 'right' }}>{lpName}</th>
                        <th style={{ ...th, textAlign: 'right' }}>LP IRR</th>
                        <th style={{ ...th, textAlign: 'right' }}>MJW take</th>
                        {sel.l2 && <th style={{ ...th, textAlign: 'right' }}>Class B value</th>}
                        {sel.l2 && <th style={{ ...th, textAlign: 'right' }}>B / unit</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {sensitivity.map(({ m, gross, r }) => r && (
                        <tr key={m} style={{ borderTop: '1px solid var(--border)', fontWeight: m === 1 ? 600 : 400 }}>
                          <td style={td}>{usdM(gross)}{m === 1 ? ' (current)' : ` (${m > 1 ? '+' : ''}${Math.round((m - 1) * 100)}%)`}</td>
                          <td style={{ ...td, textAlign: 'right' }}>{usd(r.l1LpTotal)}</td>
                          <td style={{ ...td, textAlign: 'right' }}>{pct(r.l1LpIrr)}</td>
                          <td style={{ ...td, textAlign: 'right', color: 'var(--accent)' }}>{usd(r.l1GpTotal)}</td>
                          {sel.l2 && <td style={{ ...td, textAlign: 'right' }}>{usd(r.l2?.classBValue ?? 0)}</td>}
                          {sel.l2 && <td style={{ ...td, textAlign: 'right', color: 'var(--accent)' }}>{units['B'] ? usd((r.l2?.classBValue ?? 0) / units['B'], 0) : '—'}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Widget>
              </div>

              {/* Agreement notes */}
              <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.6 }}>
                {c1.freeze_date && (
                  <div>· IRR hurdles and the sale distribution are deemed made as of <b>{c1.freeze_date}</b> per the JV amendment (the "IRR clock freeze"), regardless of the as-of date.</div>
                )}
                {c1.override && (
                  <div>· Proceeds above {usdM(c1.override.threshold)} (measured on price net of closing costs, per the workbook convention) split {pct(c1.override.lp, 0)}/{pct(c1.override.gp, 0)} outside the IRR ladder. The amendment's literal "Net Proceeds" definition nets debt payoff first — flagged for legal review.</div>
                )}
                {c1.cash_split && (
                  <div>· Cash on hand at closing splits {pct(c1.cash_split.lp, 0)}/{pct(c1.cash_split.gp, 0)} as Net Cash Flow, outside the waterfall, per the JV amendment.</div>
                )}
                {sel.l2?.waterfall_tiers.some(t => t.hurdle_em != null) && (
                  <div>· Layer 2 Class A preferences are the <b>lesser</b> of the IRR hurdle and the equity-multiple cap — prior distributions count toward the multiple, so the EM leg can govern.</div>
                )}
                <div>· Tier terms verified against the executed operating agreements ({sel.name} corpus documents). Flow history sourced from the PS Samples / Knightdale v3 workbooks and the quarterly distribution workbook — pending final vetting against JV statements.</div>
              </div>
              {sel.l1.notes && (
                <div style={{ marginTop: 10, padding: '12px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  <span style={{ fontWeight: 600 }}>Deal notes · </span>{sel.l1.notes}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

// ── investor accounts drill-down ──────────────────────────────────────────

function InvestorAccounts({ l2, l2Name, classAValue, classBValue, seniorClassValues, units }: {
  l2: DealRow
  l2Name: string
  classAValue: number
  classBValue: number
  seniorClassValues: Record<string, number>
  units: Record<string, number>
}) {
  const roster = useMemo(
    () => [...l2.entity_investors].sort((a, b) => b.units - a.units || a.name.localeCompare(b.name)),
    [l2.entity_investors],
  )
  // Cumulative senior-common distributions per unit, from the loaded flow history (gross of withholding).
  const seniorUnits = units['AC'] ?? units['A'] ?? 0
  const distPerUnit = useMemo(() => {
    if (!seniorUnits) return 0
    const total = l2.capital_flows
      .filter(f => ['class_a', 'class_ac', 'class_c'].includes(f.role) && Number(f.amount) > 0)
      .reduce((s, f) => s + Number(f.amount), 0)
    return total / seniorUnits
  }, [l2.capital_flows, seniorUnits])
  const valuePerUnit = seniorUnits ? classAValue / seniorUnits : 0
  const bUnits = units['B'] ?? 0
  const dUnits = units['D'] ?? 0
  const dValue = Object.values(seniorClassValues).reduce((s, v) => s + v, 0)

  if (roster.length === 0) {
    return (
      <Widget title={`Investor accounts — ${l2Name}`} chip="roster pending" fullWidth>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 0' }}>
          No per-investor roster loaded for this entity yet — it wasn't in the Q1-26 distribution
          workbook (no distribution that quarter). Send the member schedule and it drops in here.
        </div>
      </Widget>
    )
  }

  const totalUnits = roster.reduce((s, r) => s + Number(r.units), 0)
  return (
    <Widget title={`Investor accounts — ${l2Name}`} chip={`${roster.length} Class A holders`} fullWidth>
      <table style={tblStyle}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--text-faint)', fontSize: 11 }}>
            <th style={th}>Investor</th>
            <th style={{ ...th, textAlign: 'right' }}>Units</th>
            <th style={{ ...th, textAlign: 'right' }}>% of class</th>
            <th style={{ ...th, textAlign: 'right' }}>Distributions to date</th>
            <th style={{ ...th, textAlign: 'right' }}>Sold-today value</th>
            <th style={{ ...th, textAlign: 'right' }}>Total outcome</th>
          </tr>
        </thead>
        <tbody>
          {roster.map(r => {
            const u = Number(r.units)
            return (
              <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={td}>{r.name}</td>
                <td style={{ ...td, textAlign: 'right' }}>{u.toLocaleString()}</td>
                <td style={{ ...td, textAlign: 'right' }}>{pct(seniorUnits ? u / seniorUnits : 0, 2)}</td>
                <td style={{ ...td, textAlign: 'right' }}>{usd(u * distPerUnit)}</td>
                <td style={{ ...td, textAlign: 'right', color: 'var(--accent)' }}>{usd(u * valuePerUnit)}</td>
                <td style={{ ...td, textAlign: 'right' }}>{usd(u * (distPerUnit + valuePerUnit))}</td>
              </tr>
            )
          })}
          <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 600 }}>
            <td style={td}>Class A total</td>
            <td style={{ ...td, textAlign: 'right' }}>{totalUnits.toLocaleString()}</td>
            <td style={{ ...td, textAlign: 'right' }}>{pct(seniorUnits ? totalUnits / seniorUnits : 0, 0)}</td>
            <td style={{ ...td, textAlign: 'right' }}>{usd(totalUnits * distPerUnit)}</td>
            <td style={{ ...td, textAlign: 'right', color: 'var(--accent)' }}>{usd(totalUnits * valuePerUnit)}</td>
            <td style={{ ...td, textAlign: 'right' }}>{usd(totalUnits * (distPerUnit + valuePerUnit))}</td>
          </tr>
          {dUnits > 0 && (
            <tr style={{ borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }}>
              <td style={td}>Class D holders (aggregate)</td>
              <td style={{ ...td, textAlign: 'right' }}>{dUnits.toLocaleString()}</td>
              <td style={{ ...td, textAlign: 'right' }}>—</td>
              <td style={{ ...td, textAlign: 'right' }}>{usd(0)}</td>
              <td style={{ ...td, textAlign: 'right' }}>{usd(dValue)}</td>
              <td style={{ ...td, textAlign: 'right' }}>{usd(dValue)}</td>
            </tr>
          )}
          {bUnits > 0 && (
            <tr style={{ borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }}>
              <td style={td}>Class B holders (aggregate, promote)</td>
              <td style={{ ...td, textAlign: 'right' }}>{bUnits.toLocaleString()}</td>
              <td style={{ ...td, textAlign: 'right' }}>—</td>
              <td style={{ ...td, textAlign: 'right' }}>{usd(l2.capital_flows.filter(f => f.role === 'class_b' && Number(f.amount) > 0).reduce((s, f) => s + Number(f.amount), 0))}</td>
              <td style={{ ...td, textAlign: 'right', color: 'var(--accent)' }}>{usd(classBValue)}</td>
              <td style={{ ...td, textAlign: 'right' }}>{usd(classBValue)}</td>
            </tr>
          )}
        </tbody>
      </table>
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-faint)' }}>
        Distributions are gross of withholding, allocated pro-rata within Class A from the loaded flow
        history. Sold-today value = units × the class per-unit value from the cascade above (includes
        this entity's share of cash on hand). B and D unit holders aren't itemized in the quarterly
        workbook — shown in aggregate.
      </div>
    </Widget>
  )
}

// ── small presentational helpers ──
const tblStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 }
const th: CSSProperties = { padding: '4px 8px', fontWeight: 600 }
const td: CSSProperties = { padding: '6px 8px', color: 'var(--text)' }
// shared control base — one height, one border, box-sizing so every input lines up
const controlBase: CSSProperties = {
  height: 38, padding: '0 10px', fontSize: 13, borderRadius: 6, boxSizing: 'border-box',
  border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)',
}
const CONTROL_W = 150
const dateStyle: CSSProperties = { ...controlBase, width: CONTROL_W }
const selectStyle: CSSProperties = { ...controlBase, width: CONTROL_W }
const resetStyle: CSSProperties = {
  ...controlBase, width: 'auto', fontSize: 12, fontWeight: 600, cursor: 'pointer',
  color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center',
}

function Field({ label, caption, children }: { label: string; caption?: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-faint)' }}>{label}</span>
      {children}
      {caption && <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{caption}</span>}
    </label>
  )
}
function NumInput({ value, onChange, step, min, max, wide }: { value: number; onChange: (n: number) => void; step?: number; min?: number; max?: number; wide?: boolean }) {
  // text input so we can show thousands separators; edit the raw number while focused, reformat on blur
  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState('')
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))
  const display = focused
    ? draft
    : (Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '')
  return (
    <input
      type="text" inputMode="decimal" value={display}
      onFocus={() => { setDraft(Number.isFinite(value) ? String(value) : ''); setFocused(true) }}
      onChange={e => {
        const raw = e.target.value.replace(/,/g, '')
        setDraft(raw)
        if (raw === '' || raw === '-' || raw === '.' || raw === '-.') return
        const n = parseFloat(raw)
        if (!isNaN(n)) onChange(n)
      }}
      onBlur={() => { setFocused(false); const n = parseFloat(draft.replace(/,/g, '')); if (!isNaN(n)) onChange(clamp(n)) }}
      onKeyDown={e => {
        if (!step || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
        e.preventDefault()
        const n = clamp((Number.isFinite(value) ? value : 0) + (e.key === 'ArrowUp' ? step : -step))
        onChange(n); setDraft(String(n))
      }}
      style={{ ...controlBase, width: wide ? CONTROL_W : 120 }}
    />
  )
}
function Row({ k, v, sub, accent }: { k: string; v: string; sub?: string; accent?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '3px 0', gap: 12 }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{k}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: accent ? 'var(--accent)' : 'var(--text)', whiteSpace: 'nowrap' }}>
        {v}{sub && <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-faint)', marginLeft: 6 }}>{sub}</span>}
      </span>
    </div>
  )
}
