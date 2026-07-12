import { useMemo } from 'react'
import { PdfDownloadButton } from './PdfDownloadButton'
import type { PortfolioSnapshotInput } from './PortfolioSnapshotReport'
import { useGlPnl } from '../hooks/useGlPnl'
import { useBudgetVariance } from '../hooks/useBudgetVariance'
import {
  useOccupancy, useLeaseRollover, useTenantConcentration, useDSCR,
  useCriticalDates, useCoTenancyFlags, useDelinquency, useHealthRatio,
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

  // Returns are computed from ALL deals then scoped by property in-memo.
  const { data: allDeals } = useDeals()
  const scopedDeals = useMemo(() => {
    if (!allDeals) return null
    const inScope = new Set(propertyIds)
    return allDeals.filter(d => inScope.has(d.property_id))
  }, [allDeals, propertyIds])
  const returns = usePortfolioReturnsByProperty(scopedDeals)

  // Gate on the essentials; optional sections (returns, work orders) render as
  // "no data" placeholders rather than blocking the button.
  const coreLoading = pnl.loading || occ.loading || roll.loading || dscr.loading || tenants.loading
  const ready = propertyIds.length > 0 && !coreLoading

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
        arAsOf: (delinq.data ?? [])[0]?.asOf ?? null,
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
      health: health.data && health.data.rows.length > 0
        ? {
            portfolioRatio: health.data.portfolioRatio,
            ttmLabel: health.data.ttmLabel,
            reporterCount: health.data.rows.length,
            rows: health.data.rows.map(h => ({
              tenantName: h.tenantName,
              propertyName: h.propertyName,
              ratio: h.ratio,
              occupancyCost: h.occupancyCost,
              ttmSales: h.ttmSales,
              band: h.band,
              hasRecoveries: h.hasRecoveries,
            })),
          }
        : null,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, propertyIds.join(','), totalAccessible, pnl.data, bva.data, occ.data, roll.data, tenants.data, dscr.data, critical.data, coTen.data, delinq.data, workOrders.data, health.data, returns])

  return (
    <PdfDownloadButton
      label="Executive snapshot"
      busyLabel="Building snapshot…"
      filename={`Wilkow-Portfolio-Snapshot-${new Date().toISOString().slice(0, 10)}.pdf`}
      disabled={!ready || !input}
      title={ready ? 'Download a one-page executive portfolio snapshot (PDF)' : 'Loading portfolio data…'}
      build={async () => {
        if (!input) throw new Error('Portfolio data is still loading — try again in a moment.')
        const { buildPortfolioSnapshotPdf } = await import('./PortfolioSnapshotReport')
        return buildPortfolioSnapshotPdf(input)
      }}
    />
  )
}
