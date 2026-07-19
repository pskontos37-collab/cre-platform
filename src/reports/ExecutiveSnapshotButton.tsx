import { useMemo, useState } from 'react'
import { PdfDownloadButton } from './PdfDownloadButton'
import type { PortfolioSnapshotInput, SnapshotPropertyDetail } from './PortfolioSnapshotReport'
import { useGlPnl } from '../hooks/useGlPnl'
import { useBudgetVariance } from '../hooks/useBudgetVariance'
import {
  useOccupancy, useLeaseRollover, useTenantConcentration, useDSCR,
  useCriticalDates, useCoTenancyFlags, useDelinquency, useHealthRatio,
  usePropertyTopTenants,
} from '../hooks/useDashboard'
import { useWorkOrders } from '../hooks/useWorkOrders'
import { useDeals } from '../hooks/useDeals'
import { usePortfolioReturnsByProperty } from '../hooks/usePortfolioInvestorReturns'
import { OPEN_STATUSES } from '../lib/workOrderMeta'

// One-click executive PDF: mounts the same hooks the dashboard widgets use so
// every figure ties to the on-screen numbers, gates the button until the core
// data resolves, then renders the branded snapshot on click. Scope follows the
// dashboard's global property filter (propertyIds).
export function ExecutiveSnapshotButton({ propertyIds, propertyNames, totalAccessible }: {
  propertyIds: string[]
  propertyNames: Record<string, string>
  totalAccessible: number
}) {
  const pnl        = useGlPnl(propertyIds)
  const bva        = useBudgetVariance(propertyIds)
  const occ        = useOccupancy(propertyIds, propertyNames)
  const roll       = useLeaseRollover(propertyIds)
  const tenants    = useTenantConcentration(propertyIds, propertyNames)
  const dscr       = useDSCR(propertyIds, propertyNames)
  const critical   = useCriticalDates(propertyIds, propertyNames, 90)
  const coTen      = useCoTenancyFlags(propertyIds)
  const delinq     = useDelinquency(propertyIds, propertyNames)
  const workOrders = useWorkOrders(propertyIds, propertyNames)
  const health     = useHealthRatio(propertyIds, propertyNames)
  const propTenants = usePropertyTopTenants(propertyIds, propertyNames)

  // Opt-in: append a full one-page mini-dashboard per property. Off by default
  // so the one-click stays a lean exec summary; on = the deep per-asset packet.
  const [includeDetail, setIncludeDetail] = useState(false)

  // Returns are computed from ALL deals then scoped by property in-memo.
  const dealsQ = useDeals()
  const allDeals = dealsQ.data
  const scopedDeals = useMemo(() => {
    if (!allDeals) return null
    const inScope = new Set(propertyIds)
    return allDeals.filter(d => inScope.has(d.property_id))
  }, [allDeals, propertyIds])
  const returns = usePortfolioReturnsByProperty(scopedDeals)

  // Wait for EVERY section's data before enabling the button — an exec report
  // must be complete, so we favor a slightly longer load over a snapshot that
  // captures half-loaded sections as empty. A hook that errors still resolves
  // loading=false (useQuery), so one failed query degrades that one section
  // rather than stalling the whole button.
  const anyLoading =
    pnl.loading || bva.loading || occ.loading || roll.loading || tenants.loading ||
    dscr.loading || critical.loading || coTen.loading || delinq.loading ||
    workOrders.loading || health.loading || propTenants.loading || dealsQ.loading
  const ready = propertyIds.length > 0 && !anyLoading

  const input: PortfolioSnapshotInput | null = useMemo(() => {
    if (!ready) return null

    const scopeLabel = propertyIds.length >= totalAccessible
      ? 'Entire portfolio'
      : `${propertyIds.length} of ${totalAccessible} properties`

    const pastDue = (delinq.data ?? []).reduce((s, d) => s + d.pastDue, 0)
    const openWos = (workOrders.data ?? []).filter(o => OPEN_STATUSES.includes(o.status))

    const roleOf = (r: { contributed: number; distributed: number; currentEquity: number | null; totalValueMultiple: number | null; totalValueIrr: number | null } | null) => ({
      contributed: r?.contributed ?? 0,
      distributed: r?.distributed ?? 0,
      currentEquity: r?.currentEquity ?? null,
      totalValueMultiple: r?.totalValueMultiple ?? null,
      totalValueIrr: r?.totalValueIrr ?? null,
    })

    // ── Per-property assembly ──
    // Occupancy's byProperty covers every property in scope; join the rest by id
    // (or by display name where a source only carries the name).
    const pickDscr = (name: string): { text: string; status: 'ok' | 'near' | 'breach' | null } => {
      const rows = (dscr.data ?? []).filter(d => d.propertyName === name)
      if (!rows.length) return { text: '—', status: null }
      const chosen = rows.find(d => d.isBreach) ?? rows.find(d => d.isNear) ?? rows[0]
      const status = chosen.isBreach ? 'breach' : chosen.isNear ? 'near' : 'ok'
      const dyText = chosen.debtYield != null ? `${(chosen.debtYield * 100).toFixed(1)}%` : '—'
      const text = chosen.covenantType === 'debt_yield'
        ? dyText
        : chosen.dscr != null ? `${chosen.dscr.toFixed(2)}x` : dyText
      return { text, status }
    }
    const mapDscrRow = (d: any) => ({
      propertyName: d.propertyName, loanLabel: d.loan.lender_name ?? d.propertyName,
      dscr: d.dscr, debtYield: d.debtYield, covenantType: d.covenantType,
      headroom: d.headroom, isNear: d.isNear, isBreach: d.isBreach,
    })

    const propRows = (occ.data?.byProperty ?? [])
      .map(o => {
        const pr = (pnl.data?.byProperty ?? []).find(bp => bp.propertyId === o.propertyId)
        const rollP = (roll.data?.byProperty ?? []).find(b => b.propertyId === o.propertyId)
        const tops = propTenants.data?.[o.propertyId] ?? []
        const ret = returns.properties.find(rp => rp.propertyId === o.propertyId) ?? null
        const propPastDue = (delinq.data ?? []).filter(d => d.propertyName === o.propertyName).reduce((s, d) => s + d.pastDue, 0)
        const openForProp = (workOrders.data ?? []).filter(w => w.propertyId === o.propertyId && OPEN_STATUSES.includes(w.status)).length
        const dsc = pickDscr(o.propertyName)
        return {
          propertyId: o.propertyId,
          propertyName: o.propertyName,
          t12Noi: pr ? pr.t12.noi : null,
          noiMargin: pr && pr.t12.revenue > 0 ? pr.t12.noi / pr.t12.revenue : null,
          occupancyPct: o.totalSf > 0 ? o.physicalPct : null,
          occupiedSf: o.occupiedSf,
          totalSf: o.totalSf,
          walt: rollP ? rollP.walt : null,
          topTenant: tops[0]?.tenantName ?? null,
          topTenantPct: tops[0]?.pctOfTotal ?? null,
          pastDue: propPastDue,
          dscrText: dsc.text,
          dscrStatus: dsc.status,
          openWos: openForProp,
          _pr: pr, _rollP: rollP, _tops: tops, _ret: ret,
        }
      })
      // Drop empty shells (no NOI, no SF, no A/R, no WOs) so unloaded entities don't clutter.
      .filter(r => r.t12Noi != null || r.totalSf > 0 || r.pastDue > 0.005 || r.openWos > 0)
      .sort((a, b) => (b.t12Noi ?? -Infinity) - (a.t12Noi ?? -Infinity))

    const byPropertyRows = propRows.map(r => ({
      propertyName: r.propertyName, t12Noi: r.t12Noi, noiMargin: r.noiMargin,
      occupancyPct: r.occupancyPct, occupiedSf: r.occupiedSf, totalSf: r.totalSf,
      walt: r.walt, topTenant: r.topTenant, topTenantPct: r.topTenantPct,
      pastDue: r.pastDue, dscrText: r.dscrText, dscrStatus: r.dscrStatus, openWos: r.openWos,
    }))

    // Per-property detail pages — only assembled when the user opts in.
    const propertyDetails: SnapshotPropertyDetail[] = includeDetail
      ? propRows.map(r => ({
          propertyName: r.propertyName,
          occupancyPct: r.occupancyPct, occupiedSf: r.occupiedSf, totalSf: r.totalSf,
          t12Noi: r.t12Noi, t12Revenue: r._pr?.t12.revenue ?? 0, t12Opex: r._pr?.t12.opex ?? 0,
          noiMargin: r.noiMargin, walt: r.walt, pastDue: r.pastDue, openWos: r.openWos,
          noiTrend: (r._pr?.trend ?? []).map(m => ({ year: m.year, month: m.month, noi: m.noi })),
          rollover: (r._rollP?.byYear ?? []).map(y => ({ year: y.year, sf: y.sf, count: y.count, pctOfTotal: y.pctOfTotal })),
          topTenants: r._tops.map(t => ({ tenantName: t.tenantName, propertyName: t.propertyName, annualRent: t.annualRent, pctOfTotal: t.pctOfTotal, leasedSf: t.leasedSf })),
          dscr: (dscr.data ?? []).filter(d => d.propertyName === r.propertyName).map(mapDscrRow),
          criticalDates: (critical.data ?? []).filter(c => c.propertyName === r.propertyName).map(c => ({
            propertyName: c.propertyName, tenantName: c.tenantName, dateType: c.dateType,
            dueDate: c.dueDate, daysUntil: c.daysUntil, description: c.description,
          })),
          coTenancy: (coTen.data ?? []).filter(f => (propertyNames[f.property_id] ?? '') === r.propertyName)
            .map(f => ({ propertyName: r.propertyName, triggerReason: f.trigger_reason })),
          delinquency: (delinq.data ?? []).filter(d => d.propertyName === r.propertyName)
            .map(d => ({ tenantName: d.tenantName, propertyName: d.propertyName, pastDue: d.pastDue })),
          // Only fully-covered tenants carry a real ratio into the report; an
          // incomplete-coverage tenant has ratio/band = null (deterministic guard).
          health: (health.data?.rows ?? []).filter(h => h.propertyName === r.propertyName && h.ratio != null && h.band != null).map(h => ({
            tenantName: h.tenantName, propertyName: h.propertyName, ratio: h.ratio!,
            baseRent: h.baseRent, recoveries: h.recoveries,
            occupancyCost: h.occupancyCost, ttmSales: h.ttmSales, band: h.band!, hasRecoveries: h.hasRecoveries,
          })),
          returns: r._ret ? { lp: roleOf(r._ret.lp), gp: roleOf(r._ret.gp), promoteEquity: r._ret.promote?.currentEquity ?? null } : null,
        }))
      : []

    return {
      scopeLabel,
      generatedAt: new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }),
      kpis: {
        propertyCount: propertyIds.length,
        occupancyPct: occ.data?.physicalPct ?? 0,
        occupiedSf: occ.data?.occupiedSf ?? 0,
        totalSf: occ.data?.totalSf ?? 0,
        t12Noi: pnl.data?.t12.noi ?? 0,
        t12Revenue: pnl.data?.t12.revenue ?? 0,
        t12Opex: pnl.data?.t12.opex ?? 0,
        walt: roll.data?.walt ?? 0,
        totalPastDueAr: pastDue,
        // Latest snapshot date across the delinquency rows (they can differ per
        // property); empty string sentinel keeps the reduce simple, null if none.
        arAsOf: (delinq.data ?? []).reduce((m, d) => (d.asOf > m ? d.asOf : m), '') || null,
      },
      noiTrend: (pnl.data?.trend ?? []).map(m => ({ year: m.year, month: m.month, noi: m.noi })),
      budget: bva.data
        ? { year: bva.data.year, throughMonth: bva.data.throughMonth, mixedClose: bva.data.mixedClose, noiActual: bva.data.noi.actual, noiBudget: bva.data.noi.budget }
        : null,
      occupancy: (occ.data?.byProperty ?? [])
        .filter(o => o.totalSf > 0)
        .sort((a, b) => b.totalSf - a.totalSf)
        .map(o => ({ propertyName: o.propertyName, physicalPct: o.physicalPct, occupiedSf: o.occupiedSf, totalSf: o.totalSf })),
      rollover: (roll.data?.byYear ?? []).map(y => ({ year: y.year, sf: y.sf, count: y.count, pctOfTotal: y.pctOfTotal })),
      topTenants: (tenants.data ?? []).map(t => ({ tenantName: t.tenantName, propertyName: t.propertyName, annualRent: t.annualRent, pctOfTotal: t.pctOfTotal, leasedSf: t.leasedSf })),
      dscr: (dscr.data ?? []).map(d => ({
        propertyName: d.propertyName,
        loanLabel: d.loan.lender_name ?? d.propertyName,
        dscr: d.dscr,
        debtYield: d.debtYield,
        covenantType: d.covenantType,
        headroom: d.headroom,
        isNear: d.isNear,
        isBreach: d.isBreach,
      })),
      criticalDates: (critical.data ?? []).map(c => ({
        propertyName: c.propertyName,
        tenantName: c.tenantName,
        dateType: c.dateType,
        dueDate: c.dueDate,
        daysUntil: c.daysUntil,
        description: c.description,
      })),
      coTenancy: (coTen.data ?? []).map(f => ({
        propertyName: propertyNames[f.property_id] ?? 'Unknown',
        triggerReason: f.trigger_reason,
      })),
      delinquency: (delinq.data ?? []).map(d => ({ tenantName: d.tenantName, propertyName: d.propertyName, pastDue: d.pastDue })),
      workOrders: workOrders.data
        ? {
            open: openWos.length,
            urgent: openWos.filter(o => o.priority === 'emergency' || o.priority === 'high').length,
            unassigned: openWos.filter(o => !o.assignedVendor).length,
          }
        : null,
      returns: returns.properties.length > 0
        ? {
            dealCount: returns.properties.length,
            lp: roleOf(returns.totals.lp),
            gp: roleOf(returns.totals.gp),
            promoteEquity: returns.totals.promote.currentEquity,
          }
        : null,
      health: (() => {
        // Fully-covered tenants only — an incomplete-coverage tenant has no ratio
        // and must not appear as a distorted number in the PDF (audit: D&B).
        const covered = (health.data?.rows ?? []).filter(h => h.ratio != null && h.band != null)
        return health.data && covered.length > 0
          ? {
              portfolioRatio: health.data.portfolioRatio,
              ttmLabel: health.data.ttmLabel,
              reporterCount: covered.length,
              rows: covered.map(h => ({
                tenantName: h.tenantName,
                propertyName: h.propertyName,
                ratio: h.ratio!,
                baseRent: h.baseRent,
                recoveries: h.recoveries,
                occupancyCost: h.occupancyCost,
                ttmSales: h.ttmSales,
                band: h.band!,
                hasRecoveries: h.hasRecoveries,
              })),
            }
          : null
      })(),
      byProperty: byPropertyRows,
      propertyDetails,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, includeDetail, propertyIds.join(','), totalAccessible, pnl.data, bva.data, occ.data, roll.data, tenants.data, dscr.data, critical.data, coTen.data, delinq.data, workOrders.data, health.data, propTenants.data, returns])

  const detailCount = input?.byProperty.length ?? 0

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <label
        title="Append a one-page detail dashboard for each property (longer PDF)"
        style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)', cursor: ready ? 'pointer' : 'default', whiteSpace: 'nowrap', opacity: ready ? 1 : 0.5 }}
      >
        <input type="checkbox" checked={includeDetail} disabled={!ready} onChange={e => setIncludeDetail(e.target.checked)} style={{ cursor: 'inherit' }} />
        Per-property detail{includeDetail && detailCount > 0 ? ` (+${detailCount}p)` : ''}
      </label>
      <PdfDownloadButton
        label="Executive snapshot"
        busyLabel="Building snapshot…"
        filename={`Wilkow-Portfolio-Snapshot-${new Date().toISOString().slice(0, 10)}.pdf`}
        disabled={!ready || !input}
        title={ready ? 'Download an executive portfolio snapshot (PDF)' : 'Loading portfolio data…'}
        build={async () => {
          if (!input) throw new Error('Portfolio data is still loading — try again in a moment.')
          const { buildPortfolioSnapshotPdf } = await import('./PortfolioSnapshotReport')
          return buildPortfolioSnapshotPdf(input)
        }}
      />
    </div>
  )
}
