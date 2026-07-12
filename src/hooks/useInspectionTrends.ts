import { supabase } from '../lib/supabase'
import { useQuery } from './useQuery'
import { sectionAverages, type SectionResponse } from '../lib/inspection'
import type { FormKind } from '../lib/inspectionTemplates'

export interface TrendPoint {
  id: string
  date: string
  kind: FormKind | null
  overall: number | null
  flagged: number | null
}

export interface SectionTrend {
  title: string
  latest: number | null
  prior: number | null
  delta: number | null      // latest - prior (same form kind)
}

export interface InspectionTrends {
  points: TrendPoint[]       // chronological (oldest → newest), submitted only
  overallDelta: number | null
  sections: SectionTrend[]   // from the two most-recent same-kind inspections
  count: number
}

// Trend analytics for one property, computed client-side from the stored
// per-item responses (few inspections per property, so no server rollup needed).
export function useInspectionTrends(propertyId: string | null, bump = 0) {
  return useQuery<InspectionTrends>(async () => {
    const empty: InspectionTrends = { points: [], overallDelta: null, sections: [], count: 0 }
    if (!propertyId) return empty
    const { data, error } = await supabase
      .from('inspections')
      .select('id, inspection_date, form_kind, average_score, items_flagged, responses, created_at')
      .eq('property_id', propertyId)
      .eq('status', 'submitted')
      .order('inspection_date', { ascending: true })
      .order('created_at', { ascending: true })
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as {
      id: string; inspection_date: string; form_kind: FormKind | null
      average_score: number | null; items_flagged: number | null
      responses: SectionResponse[] | null
    }[]
    if (!rows.length) return empty

    const points: TrendPoint[] = rows.map(r => ({
      id: r.id,
      date: r.inspection_date,
      kind: r.form_kind,
      overall: r.average_score != null ? Number(r.average_score) : null,
      flagged: r.items_flagged,
    }))

    const overallDelta = points.length >= 2 && points[points.length - 1].overall != null && points[points.length - 2].overall != null
      ? (points[points.length - 1].overall as number) - (points[points.length - 2].overall as number)
      : null

    // Per-section: compare the latest inspection to the most recent PRIOR one of
    // the same form kind (retail/office items differ, so only compare like-for-like).
    const latest = rows[rows.length - 1]
    const prior = [...rows].slice(0, -1).reverse().find(r => r.form_kind === latest.form_kind)
    const latestSecs = latest.responses ? sectionAverages(latest.responses) : []
    const priorSecs = prior?.responses ? sectionAverages(prior.responses) : []
    const priorByTitle = new Map(priorSecs.map(s => [s.title, s.average]))
    const sections: SectionTrend[] = latestSecs.map(s => {
      const priorAvg = priorByTitle.get(s.title) ?? null
      const delta = s.average != null && priorAvg != null ? s.average - priorAvg : null
      return { title: s.title, latest: s.average, prior: priorAvg, delta }
    })

    return { points, overallDelta, sections, count: rows.length }
  }, [propertyId, bump])
}
