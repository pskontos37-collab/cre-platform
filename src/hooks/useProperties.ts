import { supabase } from '../lib/supabase'
import type { Property, Portfolio } from '../types/database'
import { useQuery } from './useQuery'

export interface PropertyWithPortfolio extends Property {
  portfolio: Pick<Portfolio, 'id' | 'name'> | null
}

export function useProperties() {
  return useQuery<PropertyWithPortfolio[]>(async () => {
    const { data, error } = await supabase
      .from('properties')
      .select('*, portfolio:portfolios(id, name)')
      .order('name')
    if (error) throw new Error(error.message)
    return (data ?? []) as PropertyWithPortfolio[]
  }, [])
}

export function usePortfolios() {
  return useQuery<Portfolio[]>(async () => {
    const { data, error } = await supabase
      .from('portfolios')
      .select('*')
      .order('name')
    if (error) throw new Error(error.message)
    return data ?? []
  }, [])
}
