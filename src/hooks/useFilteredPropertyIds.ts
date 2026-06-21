import { useMemo } from 'react'
import { useFilter } from '../contexts/FilterContext'
import type { PropertyWithPortfolio } from './useProperties'

export function useFilteredPropertyIds(properties: PropertyWithPortfolio[] | null): string[] {
  const { filter } = useFilter()

  return useMemo(() => {
    if (!properties?.length) return []

    switch (filter.scope) {
      case 'property':
        return filter.id ? [filter.id] : []
      case 'portfolio':
        return filter.id
          ? properties.filter(p => p.portfolio_id === filter.id).map(p => p.id)
          : properties.map(p => p.id)
      case 'all':
      default:
        return properties.map(p => p.id)
    }
  }, [properties, filter.scope, filter.id])
}

export function usePropertyNameMap(properties: PropertyWithPortfolio[] | null): Record<string, string> {
  return useMemo(() => {
    if (!properties) return {}
    return Object.fromEntries(properties.map(p => [p.id, p.name]))
  }, [properties])
}
