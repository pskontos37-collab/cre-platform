// Vendor directory for the /services/new generator — remembers a vendor's
// name / business / notice address / email so they auto-populate on re-use.
// All writes are best-effort: if the table isn't migrated yet, the builder
// still works and the directory is simply empty.

import { supabase } from '../lib/supabase'
import { useQuery } from './useQuery'

export interface VendorRecord {
  id: string
  name_key: string
  name: string
  business: string | null
  address_lines: string[]
  email: string | null
}

export const vendorKey = (name: string) => name.trim().toLowerCase()

export function useServiceAgreementVendors() {
  return useQuery<VendorRecord[]>(async () => {
    const { data, error } = await supabase
      .from('service_agreement_vendors')
      .select('id, name_key, name, business, address_lines, email')
      .order('name')
    if (error) {
      console.warn('[svc-vendors] list unavailable:', error.message)
      return []
    }
    return (data ?? []) as VendorRecord[]
  }, [])
}

/** Best-effort upsert of a vendor's details. Never throws. No-op on blank name. */
export async function upsertVendor(v: {
  name: string
  business?: string
  addressLines?: string[]
  email?: string
}): Promise<void> {
  const name = v.name.trim()
  if (!name) return
  try {
    const { data: auth } = await supabase.auth.getUser()
    const address = (v.addressLines ?? []).map(s => (s ?? '').trim()).filter(Boolean)
    const row = {
      name_key: vendorKey(name),
      name,
      business: (v.business ?? '').trim() || null,
      address_lines: address,
      email: (v.email ?? '').trim() || null,
      created_by: auth?.user?.id ?? null,
      updated_at: new Date().toISOString(),
    }
    const { error } = await supabase
      .from('service_agreement_vendors')
      .upsert(row, { onConflict: 'name_key' })
    if (error) console.warn('[svc-vendors] upsert skipped:', error.message)
  } catch (e) {
    console.warn('[svc-vendors] upsert error:', e instanceof Error ? e.message : String(e))
  }
}
