import { useQuery } from './useQuery'
import { supabase } from '../lib/supabase'

// Asset-management relationship directory (am_contacts, migration 20240070).
// The AM rolodex: tenant RE departments, leasing brokers, attorneys, lenders,
// capital partners, consultants, municipal contacts — built up during
// negotiations. Restricted to asset managers + admin (RLS enforces it).

export type AmCategory =
  | 'real_estate_dept' | 'broker' | 'attorney' | 'lender'
  | 'partner_lp' | 'consultant' | 'municipality' | 'other'

export const AM_CATEGORIES: { key: AmCategory; label: string; icon: string }[] = [
  { key: 'real_estate_dept', label: 'Tenant RE dept',   icon: '🏬' },
  { key: 'broker',           label: 'Leasing broker',   icon: '🤝' },
  { key: 'attorney',         label: 'Attorney',         icon: '⚖️' },
  { key: 'lender',           label: 'Lender',           icon: '🏦' },
  { key: 'partner_lp',       label: 'Capital partner',  icon: '💰' },
  { key: 'consultant',       label: 'Consultant',       icon: '🧭' },
  { key: 'municipality',     label: 'Municipality',     icon: '🏛' },
  { key: 'other',            label: 'Other',            icon: '📇' },
]

export const AM_CATEGORY_LABEL: Record<AmCategory, string> =
  Object.fromEntries(AM_CATEGORIES.map(c => [c.key, c.label])) as Record<AmCategory, string>

export interface AmContact {
  id: string
  category: AmCategory
  contactName: string | null
  title: string | null
  company: string | null
  represents: string | null
  email: string | null
  phone: string | null
  mobile: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  state: string | null
  zip: string | null
  market: string | null
  specialty: string | null
  tags: string[] | null
  dealId: string | null
  dealName: string | null
  propertyIds: string[] | null
  isFavorite: boolean
  lastContacted: string | null
  source: string | null
  notes: string | null
  updatedAt: string
}

const SELECT =
  'id, category, contact_name, title, company, represents, email, phone, mobile, ' +
  'address_line1, address_line2, city, state, zip, market, specialty, tags, deal_id, ' +
  'property_ids, is_favorite, last_contacted, source, notes, updated_at, pipeline_deals(name)'

function mapRow(r: any): AmContact {
  return {
    id:            r.id,
    category:      r.category,
    contactName:   r.contact_name,
    title:         r.title,
    company:       r.company,
    represents:    r.represents,
    email:         r.email,
    phone:         r.phone,
    mobile:        r.mobile,
    addressLine1:  r.address_line1,
    addressLine2:  r.address_line2,
    city:          r.city,
    state:         r.state,
    zip:           r.zip,
    market:        r.market,
    specialty:     r.specialty,
    tags:          r.tags,
    dealId:        r.deal_id,
    dealName:      r.pipeline_deals?.name ?? null,
    propertyIds:   r.property_ids,
    isFavorite:    !!r.is_favorite,
    lastContacted: r.last_contacted,
    source:        r.source,
    notes:         r.notes,
    updatedAt:     r.updated_at,
  }
}

export function useAmContacts(enabled: boolean) {
  return useQuery<AmContact[]>(async () => {
    if (!enabled) return []
    const { data, error } = await supabase
      .from('am_contacts')
      .select(SELECT)
      .order('is_favorite', { ascending: false })
      .order('company', { ascending: true })
    if (error) throw new Error(error.message)
    return ((data ?? []) as any[]).map(mapRow)
  }, [enabled])
}

// Lightweight pipeline-deal list for the deal-link picker.
export interface DealOption { id: string; name: string }
export function useDealOptions(enabled: boolean) {
  return useQuery<DealOption[]>(async () => {
    if (!enabled) return []
    const { data, error } = await supabase
      .from('pipeline_deals')
      .select('id, name')
      .order('name', { ascending: true })
    if (error) throw new Error(error.message)
    return ((data ?? []) as any[]).map(r => ({ id: r.id, name: r.name }))
  }, [enabled])
}

// ── writes ──────────────────────────────────────────────────────────────────
export interface AmContactDraft {
  category: AmCategory
  contactName?: string | null
  title?: string | null
  company?: string | null
  represents?: string | null
  email?: string | null
  phone?: string | null
  mobile?: string | null
  addressLine1?: string | null
  addressLine2?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  market?: string | null
  specialty?: string | null
  tags?: string[] | null
  dealId?: string | null
  propertyIds?: string[] | null
  isFavorite?: boolean
  lastContacted?: string | null
  source?: string | null
  notes?: string | null
}

const nz = (v: string | null | undefined) => {
  const t = (v ?? '').trim()
  return t === '' ? null : t
}

function draftToRow(d: AmContactDraft): Record<string, unknown> {
  return {
    category:      d.category,
    contact_name:  nz(d.contactName),
    title:         nz(d.title),
    company:       nz(d.company),
    represents:    nz(d.represents),
    email:         nz(d.email),
    phone:         nz(d.phone),
    mobile:        nz(d.mobile),
    address_line1: nz(d.addressLine1),
    address_line2: nz(d.addressLine2),
    city:          nz(d.city),
    state:         nz(d.state),
    zip:           nz(d.zip),
    market:        nz(d.market),
    specialty:     nz(d.specialty),
    tags:          d.tags && d.tags.length ? d.tags : null,
    deal_id:       d.dealId ?? null,
    property_ids:  d.propertyIds && d.propertyIds.length ? d.propertyIds : null,
    is_favorite:   !!d.isFavorite,
    last_contacted: nz(d.lastContacted),
    source:        nz(d.source),
    notes:         nz(d.notes),
  }
}

export async function createAmContact(d: AmContactDraft): Promise<void> {
  const { error } = await supabase.from('am_contacts').insert(draftToRow(d))
  if (error) throw new Error(error.message)
}

export async function updateAmContact(id: string, d: AmContactDraft): Promise<void> {
  const { error } = await supabase
    .from('am_contacts')
    .update({ ...draftToRow(d), updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

export async function toggleAmFavorite(id: string, isFavorite: boolean): Promise<void> {
  const { error } = await supabase
    .from('am_contacts')
    .update({ is_favorite: isFavorite, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

export async function deleteAmContact(id: string): Promise<void> {
  const { error } = await supabase.from('am_contacts').delete().eq('id', id)
  if (error) throw new Error(error.message)
}
