import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Widget, WidgetSkeleton, ChipSelect, WidgetPropertyChip, usePropertyChip, ExpandToggle } from '../ui/Widget'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { useCriticalDates, type CriticalDateRow } from '../../hooks/useDashboard'
import { supabase } from '../../lib/supabase'
import { downloadIcs, googleCalendarUrl, outlookWebUrl, type CalendarEvent } from '../../lib/calendar'

// Keyed on the critical-event ledger's event_type (P1d-c). Legacy critical_dates
// date_type keys retained so nothing regresses during the transition.
const DATE_LABELS: Record<string, string> = {
  // ledger event types
  lease_expiration:        'Lease Exp.',
  option_notice:           'Option Notice',
  loan_maturity:           'Loan Maturity',
  mgmt_termination_notice: 'PMA Notice',
  recurring_obligation:    'Recurring',
  // legacy date_type keys
  option_notice_deadline:  'Option Notice',
  rent_commencement:       'Rent Comm.',
  free_rent_end:           'Free Rent End',
  escalation:              'Escalation',
  tax_appeal_deadline:     'Tax Appeal',
  inspection_due:          'Inspection',
  other:                   'Other',
}

// Resolution choices are contextual to the date type. Choosing one closes the
// item (drops off the widget, which filters is_completed=false) unless keepsOpen
// — e.g. a tax appeal marked "In progress" stays visible. needsReason prompts
// for a note (stored in critical_dates.resolution_note) before writing.
type StatusOpt = { value: string; label: string; needsReason?: boolean; keepsOpen?: boolean }

const OPTION_NOTICE_OPTS: StatusOpt[] = [
  { value: 'exercised', label: 'Exercised' },
  { value: 'lapsed',    label: 'Lapsed' },
  { value: 'waived',    label: 'Waived', needsReason: true },
  { value: 'ignored',   label: 'Ignored', needsReason: true },
]
const STATUS_OPTIONS: Record<string, StatusOpt[]> = {
  // ledger event types
  lease_expiration: [
    { value: 'renewed',   label: 'Renewed' },
    { value: 'moved_out', label: 'Moved out' },
  ],
  option_notice: OPTION_NOTICE_OPTS,
  loan_maturity: [
    { value: 'refinanced', label: 'Refinanced' },
    { value: 'paid_off',   label: 'Paid off' },
    { value: 'in_progress', label: 'In progress', keepsOpen: true },
  ],
  mgmt_termination_notice: [
    { value: 'renewed',    label: 'Renewed' },
    { value: 'terminated', label: 'Terminated' },
    { value: 'waived',     label: 'Waived', needsReason: true },
  ],
  recurring_obligation: [
    { value: 'completed',   label: 'Completed' },
    { value: 'in_progress', label: 'In progress', keepsOpen: true },
    { value: 'waived',      label: 'Waived', needsReason: true },
  ],
  // legacy date_type keys (transition)
  option_notice_deadline: OPTION_NOTICE_OPTS,
  rent_commencement: [{ value: 'completed', label: 'Completed' }],
  free_rent_end:     [{ value: 'completed', label: 'Completed' }],
  escalation:        [{ value: 'completed', label: 'Completed' }],
  tax_appeal_deadline: [
    { value: 'completed',   label: 'Completed' },
    { value: 'in_progress', label: 'In progress', keepsOpen: true },
  ],
  inspection_due: [
    { value: 'ok',     label: 'OK' },
    { value: 'waived', label: 'Waived', needsReason: true },
  ],
  other: [
    { value: 'completed', label: 'Completed' },
    { value: 'ignored',   label: 'Ignored', needsReason: true },
    { value: 'waived',    label: 'Waived', needsReason: true },
  ],
}
const DEFAULT_STATUS_OPTIONS: StatusOpt[] = [
  { value: 'completed', label: 'Completed' },
  { value: 'waived',    label: 'Waived', needsReason: true },
]
const optionsFor = (dateType: string): StatusOpt[] => STATUS_OPTIONS[dateType] ?? DEFAULT_STATUS_OPTIONS

// Map a resolution CHOICE to the critical_events lifecycle status. The specific
// choice (Exercised/Renewed/…) is preserved in resolution_note.
const CHOICE_TO_STATUS: Record<string, 'completed' | 'waived' | 'in_progress' | 'not_applicable'> = {
  exercised: 'completed', renewed: 'completed', completed: 'completed', ok: 'completed',
  approved: 'completed', moved_out: 'completed', lapsed: 'completed', terminated: 'completed',
  refinanced: 'completed', paid_off: 'completed',
  waived: 'waived', ignored: 'waived',
  in_progress: 'in_progress', not_applicable: 'not_applicable',
}

function toCalendarEvent(row: CriticalDateRow): CalendarEvent {
  const label = DATE_LABELS[row.dateType] ?? row.dateType
  return {
    title:       `${label} — ${row.propertyName}`,
    date:        row.dueDate,
    description: row.description ?? undefined,
    url:         `${window.location.origin}/properties/${row.propertyId}`,
  }
}

function addToCalendar(row: CriticalDateRow, target: string) {
  const ev = toCalendarEvent(row)
  if (target === 'outlook') window.open(outlookWebUrl(ev), '_blank', 'noopener')
  else if (target === 'google') window.open(googleCalendarUrl(ev), '_blank', 'noopener')
  else if (target === 'ics') downloadIcs(ev, row.id)
}

interface CriticalDatesWidgetProps {
  propertyIds: string[]
  propertyNames: Record<string, string>
}

const COLLAPSED = 4

export function CriticalDatesWidget({ propertyIds, propertyNames }: CriticalDatesWidgetProps) {
  const [days, setDays] = useState(90)
  const [expanded, setExpanded] = useState(false)
  const { sel, setSel, effectiveIds } = usePropertyChip(propertyIds)
  const { data, loading, error, refetch } = useCriticalDates(effectiveIds, propertyNames, days)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // A resolution that needs a reason parks here until the manager types one.
  const [pending, setPending] = useState<{ rowId: string; opt: StatusOpt } | null>(null)
  const [reason, setReason] = useState('')
  const rows = data ?? []
  const visible = expanded ? rows : rows.slice(0, COLLAPSED)

  async function applyStatus(row: CriticalDateRow, opt: StatusOpt, note: string | null) {
    setBusy(row.id); setActionError(null)
    // P1d-c: resolve against the critical_events ledger. Map the choice to the
    // ledger's lifecycle status; keep the specific choice + any reason in
    // resolution_note. A non-keepsOpen status leaves the active view (the widget
    // reads active_critical_events, which excludes completed/waived/N-A).
    const status = CHOICE_TO_STATUS[opt.value] ?? (opt.keepsOpen ? 'in_progress' : 'completed')
    const patch: Record<string, unknown> = {
      status,
      resolution_note: note ?? opt.label,
      updated_at: new Date().toISOString(),
    }
    if (status !== 'in_progress') patch.completed_date = new Date().toISOString().slice(0, 10)
    const { error: err } = await supabase.from('critical_events').update(patch).eq('id', row.id)
    setBusy(null); setPending(null); setReason('')
    if (err) setActionError(`Couldn't update: ${err.message}`)
    else refetch()
  }

  function chooseStatus(row: CriticalDateRow, value: string) {
    const opt = optionsFor(row.dateType).find(o => o.value === value)
    if (!opt) return
    if (opt.needsReason) { setPending({ rowId: row.id, opt }); setReason('') }
    else void applyStatus(row, opt, null)
  }

  return (
    <Widget
      title="Critical Dates"
      chip={
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {propertyIds.length > 1 && (
            <WidgetPropertyChip scopeIds={propertyIds} propertyNames={propertyNames} value={sel} onChange={setSel} />
          )}
          <ChipSelect
            value={String(days)}
            onChange={v => setDays(Number(v))}
            options={[
              { value: '30', label: 'Next 30 days' },
              { value: '60', label: 'Next 60 days' },
              { value: '90', label: 'Next 90 days' },
            ]}
          />
        </span>
      }
    >
      {loading && <WidgetSkeleton rows={3} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {actionError && <div style={{ fontSize: 11, color: 'var(--red)', marginBottom: 6 }}>{actionError}</div>}
      {!loading && !error && rows.length === 0 && (
        <EmptyState icon="✅" title="No upcoming dates" subtitle={`Nothing open in the next ${days} days`} />
      )}
      {!loading && !error && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {visible.map(row => (
            <div
              key={row.id}
              style={{
                display:       'flex',
                flexDirection: 'column',
                gap:           6,
                padding:       '8px 10px',
                background:    'var(--surface-2)',
                borderRadius:  7,
                border:        `1px solid ${urgencyBorder(row.daysUntil)}`,
                opacity:       busy === row.id ? 0.5 : 1,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <div style={{ minWidth: 36, textAlign: 'center', paddingTop: 2 }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: urgencyColor(row.daysUntil), lineHeight: 1 }}>
                  {row.daysUntil}
                </div>
                <div style={{ fontSize: 9, color: 'var(--text-faint)' }}>days</div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 500, lineHeight: 1.45, whiteSpace: 'normal', wordBreak: 'break-word' }}>
                  {row.description ?? DATE_LABELS[row.dateType] ?? row.dateType}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 3 }}>
                  <Link to={`/properties/${row.propertyId}`} style={{ color: 'var(--accent)', textDecoration: 'none' }} title="Open property page">
                    {row.propertyName}
                  </Link>
                  {' '}· due {row.dueDate}
                </div>
                {/* Landlord reminder-notice provision: this lease obliges the
                    landlord to remind the tenant before the option window — flag
                    it so the manager prepares a notice to tenant. */}
                {row.requiresLandlordReminder && (row.dateType === 'option_notice' || row.dateType === 'option_notice_deadline') && (
                  <div style={{ marginTop: 5 }}>
                    <Badge variant="blue">⚑ Prepare tenant notice</Badge>
                  </div>
                )}
                {row.status === 'in_progress' && (
                  <div style={{ marginTop: 5 }}>
                    <Badge variant="amber">In progress</Badge>
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
                <Badge variant={urgencyBadge(row.daysUntil)}>
                  {DATE_LABELS[row.dateType] ?? row.dateType}
                </Badge>
                {/* Resolve: options are contextual to the date type. A choice that
                    needs a reason opens the note row below; others write directly. */}
                <select
                  value=""
                  disabled={busy === row.id}
                  onChange={e => { if (e.target.value) chooseStatus(row, e.target.value) }}
                  title="Mark this date resolved"
                  style={{
                    fontSize:     10,
                    color:        'var(--text-muted)',
                    background:   'var(--surface)',
                    border:       '1px solid var(--border-2)',
                    borderRadius: 6,
                    padding:      '2px 4px',
                    cursor:       'pointer',
                    outline:      'none',
                  }}
                >
                  <option value="">Mark ▾</option>
                  {optionsFor(row.dateType).map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
                {/* Add to calendar: all-day event on the due date with a 1-week reminder */}
                <select
                  value=""
                  onChange={e => { if (e.target.value) addToCalendar(row, e.target.value) }}
                  title="Add this date to your calendar"
                  style={{
                    fontSize:     10,
                    color:        'var(--text-muted)',
                    background:   'var(--surface)',
                    border:       '1px solid var(--border-2)',
                    borderRadius: 6,
                    padding:      '2px 4px',
                    cursor:       'pointer',
                    outline:      'none',
                  }}
                >
                  <option value="">📅 Cal ▾</option>
                  <option value="outlook">Outlook</option>
                  <option value="google">Google</option>
                  <option value="ics">.ics file</option>
                </select>
              </div>
              </div>
              {/* Reason capture for ignored / waived resolutions */}
              {pending?.rowId === row.id && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 46 }}>
                  <input
                    autoFocus
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && reason.trim()) void applyStatus(row, pending.opt, reason.trim())
                      if (e.key === 'Escape') { setPending(null); setReason('') }
                    }}
                    placeholder={`Reason for "${pending.opt.label}"…`}
                    style={{
                      flex: 1, fontSize: 11, color: 'var(--text)', background: 'var(--surface)',
                      border: '1px solid var(--border-2)', borderRadius: 6, padding: '4px 7px', outline: 'none',
                    }}
                  />
                  <button
                    disabled={!reason.trim() || busy === row.id}
                    onClick={() => { if (reason.trim()) void applyStatus(row, pending.opt, reason.trim()) }}
                    style={{
                      fontSize: 10.5, fontWeight: 600, color: 'var(--accent)', background: 'var(--accent-dim)',
                      border: '1px solid var(--accent)', borderRadius: 6, padding: '4px 9px',
                      cursor: reason.trim() ? 'pointer' : 'not-allowed', opacity: reason.trim() ? 1 : 0.5,
                    }}
                  >
                    Save
                  </button>
                  <button
                    onClick={() => { setPending(null); setReason('') }}
                    style={{
                      fontSize: 10.5, color: 'var(--text-muted)', background: 'var(--surface)',
                      border: '1px solid var(--border-2)', borderRadius: 6, padding: '4px 9px', cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          ))}
          <ExpandToggle
            expanded={expanded}
            onToggle={() => setExpanded(e => !e)}
            collapsedCount={COLLAPSED}
            totalCount={rows.length}
          />
        </div>
      )}
    </Widget>
  )
}

function urgencyColor(days: number) {
  if (days <= 14) return 'var(--red)'
  if (days <= 30) return 'var(--amber)'
  return 'var(--text-muted)'
}

function urgencyBorder(days: number) {
  if (days <= 14) return 'var(--red-border)'
  if (days <= 30) return 'var(--amber-border)'
  return 'var(--border-2)'
}

function urgencyBadge(days: number): 'red' | 'amber' | 'gray' {
  if (days <= 14) return 'red'
  if (days <= 30) return 'amber'
  return 'gray'
}
