// Runtime shape of a filled inspection + scoring helpers. Kept separate from
// inspectionTemplates.ts (pure form data) so the composer, the submit hook and
// the PDF report can share these without import cycles.

import { templateFor, type FormKind } from './inspectionTemplates'

export type YesNo = 'yes' | 'no'

export interface ItemResponse {
  n: number
  label: string
  na: boolean
  yn: YesNo | null
  score: number | null        // 1-5, null until set
  detail: string
  photos: string[]            // storage keys, populated on submit
}

export interface SectionResponse {
  title: string
  items: ItemResponse[]
}

export interface ScoreSummary {
  average: number | null      // mean of scored, non-N/A items
  scored: number              // count of items with a score (N/A excluded)
  flagged: number             // count of 1/2/5 scores (form says these need a note)
  needNote: number            // subset of flagged that still have no detail note
}

/** A blank, fully-expanded response set for a form kind. */
export function blankResponses(kind: FormKind): SectionResponse[] {
  return templateFor(kind).sections.map(s => ({
    title: s.title,
    items: s.items.map(it => ({
      n: it.n, label: it.label, na: false, yn: null, score: null, detail: '', photos: [],
    })),
  }))
}

export function scoreOf(sections: SectionResponse[]): ScoreSummary {
  let sum = 0, scored = 0, flagged = 0, needNote = 0
  for (const sec of sections) {
    for (const it of sec.items) {
      if (it.na || it.score == null) continue
      sum += it.score
      scored += 1
      if (it.score === 1 || it.score === 2 || it.score === 5) {
        flagged += 1
        if (!it.detail.trim()) needNote += 1
      }
    }
  }
  return { average: scored ? sum / scored : null, scored, flagged, needNote }
}

/** Map an average 1-5 score to the DB condition_rating enum. */
export function ratingFor(average: number | null): 'excellent' | 'good' | 'fair' | 'poor' | null {
  if (average == null) return null
  if (average >= 4.5) return 'excellent'
  if (average >= 3.5) return 'good'
  if (average >= 2.5) return 'fair'
  return 'poor'
}

export interface SectionAverage {
  title: string
  average: number | null
  scored: number
}

/** Per-section average (N/A and unscored items excluded), in template order. */
export function sectionAverages(sections: SectionResponse[]): SectionAverage[] {
  return sections.map(sec => {
    let sum = 0, scored = 0
    for (const it of sec.items) {
      if (it.na || it.score == null) continue
      sum += it.score; scored += 1
    }
    return { title: sec.title, average: scored ? sum / scored : null, scored }
  })
}

export function scoreColor(score: number | null): string {
  switch (score) {
    case 1: return '#8e3d3d'
    case 2: return '#c25b52'
    case 3: return '#c2a35a'
    case 4: return '#4e8f60'
    case 5: return '#3f7d54'
    default: return 'var(--border-2)'
  }
}
