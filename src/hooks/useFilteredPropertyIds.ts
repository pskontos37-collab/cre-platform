import { useMemo } from 'react'
import { useFilter } from '../contexts/FilterContext'
import { usePortfolios, portfolioSubtreeIds, type PropertyWithPortfolio } from './useProperties'

export function useFilteredPropertyIds(properties: PropertyWithPortfolio[] | null): string[] {
  const { filter } = useFilter()
  const { data: portfolios } = usePortfolios()

  // Keyed on the ids joined into a string, not on `filter.ids` itself: the filter
  // context hands back a fresh array on every update, so depending on the array
  // would recompute this list - and re-fire every query downstream of it - on
  // renders where the selection did not actually change.
  const idsKey = (filter.ids ?? []).join(',')

  return useMemo(() => {
    if (!properties?.length) return []

    switch (filter.scope) {
      case 'property':
        return filter.id ? [filter.id] : []
      case 'custom': {
        const valid = new Set(properties.map(p => p.id))
        return (filter.ids ?? []).filter(id => valid.has(id))
      }
      case 'portfolio': {
        if (!filter.id) return properties.map(p => p.id)
        // Roll up: a parent portfolio includes every descendant's assets.
        const subtree = portfolioSubtreeIds(portfolios ?? [], filter.id)
        return properties
          .filter(p => p.portfolio_id != null && subtree.has(p.portfolio_id))
          .map(p => p.id)
      }
      case 'all':
      default:
        return properties.map(p => p.id)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- idsKey covers filter.ids by VALUE (see above); listing the array itself would defeat the point
  }, [properties, filter.scope, filter.id, idsKey, portfolios])
}

export function usePropertyNameMap(properties: PropertyWithPortfolio[] | null): Record<string, string> {
  return useMemo(() => {
    if (!properties) return {}
    return Object.fromEntries(properties.map(p => [p.id, p.name]))
  }, [properties])
}
