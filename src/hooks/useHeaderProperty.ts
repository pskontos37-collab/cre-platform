import { useMemo, useState } from 'react'
import { useFilter } from '../contexts/FilterContext'
import { useProperties } from './useProperties'
import { useFilteredPropertyIds } from './useFilteredPropertyIds'

export interface HeaderPropertyOption {
  id: string
  name: string
}

// One convention for every single-property page (Financials pioneered it):
// the global header "View:" filter is the source of truth.
//  - Header names ONE property  -> that property governs; the page shows no
//    picker of its own (showPicker = false).
//  - Header is All / portfolio / custom -> the header can't name a single
//    asset, so the page picker appears, scoped to the header's property set.
//  - Header names a property the page has no data for (not in `eligible`) ->
//    fall back to the page picker over all eligible properties, and expose
//    `headerMismatchName` so the page can say why it fell back.
//
// `eligible` is the page's own universe (properties with deals, with loaded
// data, with site plans…). Pass [] while it loads — activeId stays null.
export function useHeaderProperty(eligible: HeaderPropertyOption[]) {
  const { filter } = useFilter()
  const { data: properties } = useProperties()
  const filteredIds = useFilteredPropertyIds(properties ?? null)
  const headerSingleId = filter.scope === 'property' && filter.id ? filter.id : null

  // Header-scoped subset of the page's universe; never dead-end into an empty
  // picker — if the header scope excludes everything eligible, offer all of it.
  const options = useMemo(() => {
    const scoped = eligible.filter(p => filteredIds.includes(p.id))
    return scoped.length ? scoped : eligible
  }, [eligible, filteredIds])

  const headerGoverns = !!headerSingleId && eligible.some(p => p.id === headerSingleId)

  const [localId, setLocalId] = useState<string | null>(null)
  const activeId = headerGoverns
    ? headerSingleId
    : (localId && options.some(p => p.id === localId))
      ? localId
      : (options[0]?.id ?? null)

  const activeName = eligible.find(p => p.id === activeId)?.name
    ?? (properties ?? []).find(p => p.id === activeId)?.name
    ?? null

  const headerMismatchName = headerSingleId && !headerGoverns
    ? ((properties ?? []).find(p => p.id === headerSingleId)?.name ?? filter.label)
    : null

  return {
    activeId,
    activeName,
    // true -> render the page's own <select>/chips over `options`
    showPicker: !headerGoverns,
    options,
    pick: setLocalId,
    headerMismatchName,
  }
}

// For list pages (transactions, work orders, clause library…): the set of
// property ids the header currently puts in scope, plus whether the header
// already narrowed to a single property (page-level property filters should
// disappear in that case — the header IS the filter).
export function useHeaderScope() {
  const { filter } = useFilter()
  const { data: properties } = useProperties()
  const ids = useFilteredPropertyIds(properties ?? null)
  return {
    ids,
    idSet: useMemo(() => new Set(ids), [ids]),
    isSingle: filter.scope === 'property' && !!filter.id,
    isAll: filter.scope === 'all',
    label: filter.label,
    properties: properties ?? null,
  }
}
