import { useQuery } from './useQuery'
import { supabase } from '../lib/supabase'

// Operations contact directory (tenant_contacts, migration 20240069). Billing /
// operational / legal-notice / corporate contacts per tenant per property. The
// /contacts page groups rows by tenant; legal-notice rows carry the mailing
// address pulled from the lease "Notices" clause (or entered by staff).

export type ContactType = 'billing' | 'operational' | 'legal_notice' | 'corporate' | 'general'

export const CONTACT_TYPES: { key: ContactType; label: string; short: string; icon: string }[] = [
  { key: 'legal_notice', label: 'Legal notice',      short: 'Notice',    icon: '⚖️' },
  { key: 'billing',      label: 'Billing / AP',      short: 'Billing',   icon: '💳' },
  { key: 'operational',  label: 'Operational',       short: 'Ops',       icon: '🔧' },
  { key: 'corporate',    label: 'Corporate / lease', short: 'Corporate', icon: '🏛' },
  { key: 'general',      label: 'General',           short: 'General',   icon: '📇' },
]

export const CONTACT_TYPE_LABEL: Record<ContactType, string> =
  Object.fromEntries(CONTACT_TYPES.map(t => [t.key, t.label])) as Record<ContactType, string>

export interface TenantContact {
  id: string
  propertyId: string
  tenantId: string | null
  leaseId: string | null
  tenantName: string
  contactType: ContactType
  contactName: string | null
  title: string | null
  company: string | null
  attn: string | null
  email: string | null
  phone: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  state: string | null
  zip: string | null
  country: string | null
  isPrimary: boolean
  copyTo: boolean
  source: 'manual' | 'ai_extraction' | 'mri' | 'import'
  sourceDocIds: string[] | null
  sourceSection: string | null
  verified: boolean
  notes: string | null
  updatedAt: string
}

const SELECT =
  'id, property_id, tenant_id, lease_id, tenant_name, contact_type, contact_name, title, ' +
  'company, attn, email, phone, address_line1, address_line2, city, state, zip, country, ' +
  'is_primary, copy_to, source, source_doc_ids, source_section, verified, notes, updated_at'

function mapRow(r: any): TenantContact {
  return {
    id:            r.id,
    propertyId:    r.property_id,
    tenantId:      r.tenant_id,
    leaseId:       r.lease_id,
    tenantName:    r.tenant_name,
    contactType:   r.contact_type,
    contactName:   r.contact_name,
    title:         r.title,
    company:       r.company,
    attn:          r.attn,
    email:         r.email,
    phone:         r.phone,
    addressLine1:  r.address_line1,
    addressLine2:  r.address_line2,
    city:          r.city,
    state:         r.state,
    zip:           r.zip,
    country:       r.country,
    isPrimary:     !!r.is_primary,
    copyTo:        !!r.copy_to,
    source:        r.source,
    sourceDocIds:  r.source_doc_ids,
    sourceSection: r.source_section,
    verified:      !!r.verified,
    notes:         r.notes,
    updatedAt:     r.updated_at,
  }
}

export function useTenantContacts(propertyIds: string[]) {
  return useQuery<TenantContact[]>(async () => {
    if (!propertyIds.length) return []
    const { data, error } = await supabase
      .from('tenant_contacts')
      .select(SELECT)
      .in('property_id', propertyIds)
      .order('tenant_name', { ascending: true })
    if (error) throw new Error(error.message)
    return ((data ?? []) as any[]).map(mapRow)
  }, [propertyIds.join(',')])
}

// Distinct tenants on the selected properties, for the "add contact" picker.
// Pulls from leases (the authoritative occupancy list) joined to tenants.
export interface TenantOption {
  propertyId: string
  tenantId: string | null
  leaseId: string
  tenantName: string
}

export function useTenantOptions(propertyIds: string[]) {
  return useQuery<TenantOption[]>(async () => {
    if (!propertyIds.length) return []
    const { data, error } = await supabase
      .from('leases')
      .select('id, property_id, tenant_id, tenants(name, trade_name)')
      .in('property_id', propertyIds)
    if (error) throw new Error(error.message)
    const seen = new Set<string>()
    const out: TenantOption[] = []
    for (const r of (data ?? []) as any[]) {
      const name = r.tenants?.trade_name || r.tenants?.name || 'Unknown tenant'
      const key = `${r.property_id}::${name.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ propertyId: r.property_id, tenantId: r.tenant_id ?? null, leaseId: r.id, tenantName: name })
    }
    return out.sort((a, b) => a.tenantName.localeCompare(b.tenantName))
  }, [propertyIds.join(',')])
}

// ── writes ──────────────────────────────────────────────────────────────────
export type ContactDraft = {
  propertyId: string
  tenantId?: string | null
  leaseId?: string | null
  tenantName: string
  contactType: ContactType
  contactName?: string | null
  title?: string | null
  company?: string | null
  attn?: string | null
  email?: string | null
  phone?: string | null
  addressLine1?: string | null
  addressLine2?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  country?: string | null
  isPrimary?: boolean
  copyTo?: boolean
  notes?: string | null
}

const nz = (v: string | null | undefined) => {
  const t = (v ?? '').trim()
  return t === '' ? null : t
}

function draftToRow(d: ContactDraft): Record<string, unknown> {
  return {
    property_id:   d.propertyId,
    tenant_id:     d.tenantId ?? null,
    lease_id:      d.leaseId ?? null,
    tenant_name:   d.tenantName.trim(),
    contact_type:  d.contactType,
    contact_name:  nz(d.contactName),
    title:         nz(d.title),
    company:       nz(d.company),
    attn:          nz(d.attn),
    email:         nz(d.email),
    phone:         nz(d.phone),
    address_line1: nz(d.addressLine1),
    address_line2: nz(d.addressLine2),
    city:          nz(d.city),
    state:         nz(d.state),
    zip:           nz(d.zip),
    country:       nz(d.country),
    is_primary:    !!d.isPrimary,
    copy_to:       !!d.copyTo,
    notes:         nz(d.notes),
  }
}

export async function createContact(d: ContactDraft): Promise<void> {
  const { error } = await supabase
    .from('tenant_contacts')
    .insert({ ...draftToRow(d), source: 'manual' })
  if (error) throw new Error(error.message)
}

export async function updateContact(id: string, d: ContactDraft): Promise<void> {
  // Any edit marks an AI-extracted row as verified (a human has reviewed it).
  const { error } = await supabase
    .from('tenant_contacts')
    .update({ ...draftToRow(d), verified: true, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

export async function setContactVerified(id: string, verified: boolean): Promise<void> {
  const { error } = await supabase
    .from('tenant_contacts')
    .update({ verified, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

export async function deleteContact(id: string): Promise<void> {
  const { error } = await supabase.from('tenant_contacts').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

// One-line postal address from the parts, for display / copy-to-clipboard.
export function formatAddress(c: TenantContact): string {
  const cityLine = [c.city, c.state].filter(Boolean).join(', ')
  const cityZip = [cityLine, c.zip].filter(Boolean).join(' ')
  return [c.company, c.attn ? `Attn: ${c.attn}` : null, c.addressLine1, c.addressLine2, cityZip, c.country]
    .filter(Boolean)
    .join('\n')
}
