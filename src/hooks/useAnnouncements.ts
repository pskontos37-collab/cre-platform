import { useQuery } from './useQuery'
import { supabase } from '../lib/supabase'

// Tenant Announcements (/announcements, migration 20240085). Managers email
// all tenants of a property or a selected subset. The recipient pool is the
// union of two sources the platform already maintains:
//   tenant_contacts          — the /contacts directory (rows with an email)
//   work_order_portal_users  — active tenant-portal logins (always have one)
// deduped by email. Sends go through the announcement-send edge function
// (Resend, one personal email per recipient); these hooks also read the
// audit-trail tables for the history panel.

export interface AnnouncementRecipient {
  key: string                       // lowercased email (dedupe key)
  email: string
  name: string | null
  tenantName: string
  tenantId: string | null
  source: 'tenant_contacts' | 'portal_user'
  sourceLabel: string               // e.g. "Billing / AP contact", "Portal user"
}

export interface RecipientPool {
  recipients: AnnouncementRecipient[]        // sorted by tenant, deduped by email
  tenantsWithoutEmail: string[]              // leased tenants with no address anywhere
}

// All addressable recipients at one property, plus the coverage gap (tenants
// on the rent roll with no email in either source — surfaced so the manager
// knows who an "all tenants" blast will NOT reach).
export function useAnnouncementRecipients(propertyId: string | null) {
  return useQuery<RecipientPool>(async () => {
    if (!propertyId) return { recipients: [], tenantsWithoutEmail: [] }

    const [contactsRes, portalRes, leasesRes] = await Promise.all([
      supabase
        .from('tenant_contacts')
        .select('tenant_id, tenant_name, contact_name, contact_type, email')
        .eq('property_id', propertyId)
        .not('email', 'is', null),
      supabase
        .from('work_order_portal_users')
        .select('tenant_name, contact_name, email')
        .eq('property_id', propertyId)
        .eq('is_active', true),
      supabase
        .from('leases')
        .select('tenant_id, tenants(name, trade_name)')
        .eq('property_id', propertyId),
    ])
    for (const r of [contactsRes, portalRes, leasesRes]) {
      if (r.error) throw new Error(r.error.message)
    }

    const typeLabel: Record<string, string> = {
      billing: 'Billing / AP contact', operational: 'Operational contact',
      legal_notice: 'Legal-notice contact', corporate: 'Corporate contact', general: 'Contact',
    }

    const byEmail = new Map<string, AnnouncementRecipient>()
    for (const r of (contactsRes.data ?? []) as any[]) {
      const email = String(r.email ?? '').trim().toLowerCase()
      if (!email || byEmail.has(email)) continue
      byEmail.set(email, {
        key: email, email,
        name: r.contact_name ?? null,
        tenantName: r.tenant_name ?? 'Unknown tenant',
        tenantId: r.tenant_id ?? null,
        source: 'tenant_contacts',
        sourceLabel: typeLabel[r.contact_type] ?? 'Contact',
      })
    }
    for (const r of (portalRes.data ?? []) as any[]) {
      const email = String(r.email ?? '').trim().toLowerCase()
      if (!email || byEmail.has(email)) continue
      byEmail.set(email, {
        key: email, email,
        name: r.contact_name ?? null,
        tenantName: r.tenant_name ?? 'Unknown tenant',
        tenantId: null,
        source: 'portal_user',
        sourceLabel: 'Work-order portal user',
      })
    }

    const recipients = Array.from(byEmail.values())
      .sort((a, b) => a.tenantName.localeCompare(b.tenantName) || a.email.localeCompare(b.email))

    // Coverage gap: leased tenants whose name never appears on a recipient.
    const covered = new Set(recipients.map(r => r.tenantName.toLowerCase()))
    const gap = new Set<string>()
    for (const r of (leasesRes.data ?? []) as any[]) {
      const name = r.tenants?.trade_name || r.tenants?.name
      if (name && !covered.has(name.toLowerCase())) gap.add(name)
    }

    return { recipients, tenantsWithoutEmail: Array.from(gap).sort() }
  }, [propertyId])
}

// ── send ─────────────────────────────────────────────────────────────────────
export interface SendAnnouncementInput {
  propertyId: string
  propertyName: string
  subject: string
  message: string
  recipientMode: 'all' | 'selected'
  recipients: AnnouncementRecipient[]
  ccSender: boolean
}

export interface SendResult { id: string; status: 'sent' | 'partial' | 'failed'; sent: number; failed: number }

export async function sendAnnouncement(input: SendAnnouncementInput): Promise<SendResult> {
  const { data, error } = await supabase.functions.invoke('announcement-send', {
    body: {
      propertyId: input.propertyId,
      propertyName: input.propertyName,
      subject: input.subject,
      message: input.message,
      recipientMode: input.recipientMode,
      ccSender: input.ccSender,
      recipients: input.recipients.map(r => ({
        email: r.email, name: r.name, tenantName: r.tenantName, tenantId: r.tenantId, source: r.source,
      })),
    },
  })
  if (error) throw new Error((data as any)?.error || error.message)
  if ((data as any)?.error) throw new Error((data as any).error)
  return data as SendResult
}

// ── history ──────────────────────────────────────────────────────────────────
export interface Announcement {
  id: string
  propertyId: string
  subject: string
  body: string
  sentByName: string | null
  recipientMode: 'all' | 'selected'
  status: 'sent' | 'partial' | 'failed'
  sentCount: number
  failedCount: number
  createdAt: string
}

export function useAnnouncementHistory(propertyIds: string[]) {
  return useQuery<Announcement[]>(async () => {
    if (!propertyIds.length) return []
    const { data, error } = await supabase
      .from('tenant_announcements')
      .select('id, property_id, subject, body, sent_by_name, recipient_mode, status, sent_count, failed_count, created_at')
      .in('property_id', propertyIds)
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) {
      // Table absent until migration 20240084 is applied — degrade to empty.
      if (/tenant_announcements/.test(error.message)) return []
      throw new Error(error.message)
    }
    return ((data ?? []) as any[]).map(r => ({
      id: r.id,
      propertyId: r.property_id,
      subject: r.subject,
      body: r.body,
      sentByName: r.sent_by_name,
      recipientMode: r.recipient_mode,
      status: r.status,
      sentCount: r.sent_count,
      failedCount: r.failed_count,
      createdAt: r.created_at,
    }))
  }, [propertyIds.join(',')])
}

export interface AnnouncementRecipientRow {
  tenantName: string | null
  contactName: string | null
  email: string
  status: 'sent' | 'failed'
  error: string | null
}

// On-demand (expanding a history row), not a hook.
export async function fetchAnnouncementRecipients(announcementId: string): Promise<AnnouncementRecipientRow[]> {
  const { data, error } = await supabase
    .from('tenant_announcement_recipients')
    .select('tenant_name, contact_name, email, status, error')
    .eq('announcement_id', announcementId)
    .order('tenant_name', { ascending: true })
  if (error) throw new Error(error.message)
  return ((data ?? []) as any[]).map(r => ({
    tenantName: r.tenant_name, contactName: r.contact_name, email: r.email, status: r.status, error: r.error,
  }))
}
