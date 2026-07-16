// acqAlerts.ts — shared "deadlines & stalled deals" computation for the pipeline
// board strip and the dashboard widget, so both agree on the same thresholds.
// Pure; operates on a minimal deal shape.

import { isActiveStage, type Stage } from '../hooks/usePipeline'

export const DEADLINE_SOON_DAYS = 45   // surface target closes within this window (or overdue)
export const STALE_DAYS = 21           // active deals with no edit in this long are flagged
const DAY_MS = 86400000

export interface AlertDeal {
  id: string
  name: string
  stage: Stage
  targetCloseDate: string | null
  updatedAt: string
  bidText?: string | null
}
export interface AlertItem<T> { d: T; days: number }

/** Split active deals into upcoming/overdue close deadlines and no-recent-activity (stalled). */
export function computeAcqAlerts<T extends AlertDeal>(deals: T[], now: number): { deadlines: AlertItem<T>[]; stalled: AlertItem<T>[] } {
  const active = deals.filter(d => isActiveStage(d.stage))
  const deadlines = active
    .filter(d => d.targetCloseDate)
    .map(d => ({ d, days: Math.round((new Date(d.targetCloseDate!).getTime() - now) / DAY_MS) }))
    .filter(x => x.days <= DEADLINE_SOON_DAYS)
    .sort((a, b) => a.days - b.days)
  const stalled = active
    .map(d => ({ d, days: Math.round((now - new Date(d.updatedAt).getTime()) / DAY_MS) }))
    .filter(x => x.days >= STALE_DAYS)
    .sort((a, b) => b.days - a.days)
  return { deadlines, stalled }
}
