import { supabase } from '../lib/supabase'
import { useQuery } from './useQuery'

export interface PropertyDataStatus {
  property_id: string
  active_leases: number
  gl_months: number
  data_loaded: boolean
}

/**
 * Per-property data-load status (v_property_data_status): whether an asset has
 * active leases or GL history yet. Drives the "Onboarding" treatment so
 * not-yet-loaded properties read as pending rather than broken.
 */
export function usePropertyDataStatus() {
  return useQuery<Record<string, PropertyDataStatus>>(async () => {
    const { data, error } = await supabase.from('v_property_data_status').select('*')
    if (error) throw new Error(error.message)
    return Object.fromEntries(
      ((data ?? []) as PropertyDataStatus[]).map(r => [r.property_id, r])
    )
  }, [])
}
