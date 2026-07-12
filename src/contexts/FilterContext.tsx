import { createContext, useContext, useState, ReactNode } from 'react'

export type FilterScope = 'all' | 'portfolio' | 'property' | 'custom'

export interface GlobalFilter {
  scope: FilterScope
  id: string | null
  label: string
  ids?: string[]          // scope 'custom': an arbitrary combination of properties
}

interface FilterContextType {
  filter: GlobalFilter
  setFilter: (f: GlobalFilter) => void
  asOfDate: Date
  setAsOfDate: (d: Date) => void
}

const FilterContext = createContext<FilterContextType | null>(null)

export function FilterProvider({ children }: { children: ReactNode }) {
  const [filter, setFilter] = useState<GlobalFilter>({
    scope: 'all',
    id: null,
    label: 'All properties',
  })
  const [asOfDate, setAsOfDate] = useState<Date>(new Date())

  return (
    <FilterContext.Provider value={{ filter, setFilter, asOfDate, setAsOfDate }}>
      {children}
    </FilterContext.Provider>
  )
}

export function useFilter() {
  const ctx = useContext(FilterContext)
  if (!ctx) throw new Error('useFilter must be used within FilterProvider')
  return ctx
}
