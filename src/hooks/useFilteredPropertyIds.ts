import { useMemo } from 'react'
import { useFilter } from '../contexts/FilterContext'
import { usePortfolios, portfolioSubtreeIds, type PropertyWithPortfolio } from './useProperties'

export function useFilteredPropertyIds(properties: PropertyWithPortfolio[] | null): string[] {
  const { filter } = useFilter()
  const { data: portfolios } = usePortfolios()

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
  }, [properties, filter.scope, filter.id, (filter.ids ?? []).join(','), portfolios])
}

export function usePropertyNameMap(properties: PropertyWithPortfolio[] | null): Record<string, string> {
  return useMemo(() => {
    if (!properties) return {}
    return Object.fromEntries(properties.map(p => [p.id, p.name]))
  }, [properties])
}
