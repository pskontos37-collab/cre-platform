// Add-to-calendar helpers: build all-day events for critical dates and open
// them in Outlook / Google, or download a universal .ics file.

export interface CalendarEvent {
  title: string
  /** All-day event date, YYYY-MM-DD */
  date: string
  description?: string
  /** Link back into the app (goes in the event body / URL field) */
  url?: string
}

function compactDate(iso: string): string {
  return iso.replace(/-/g, '')
}

/** Day after the event date, YYYY-MM-DD (exclusive DTEND for all-day events) */
function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** Escape text per RFC 5545 (commas, semicolons, backslashes, newlines) */
function icsEscape(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

export function buildIcs(ev: CalendarEvent, uid: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'
  const body = [ev.description, ev.url].filter(Boolean).join('\n')
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Wilkow//CRE Platform//EN',
    'BEGIN:VEVENT',
    `UID:${uid}@cre-platform`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${compactDate(ev.date)}`,
    `DTEND;VALUE=DATE:${compactDate(nextDay(ev.date))}`,
    `SUMMARY:${icsEscape(ev.title)}`,
    ...(body ? [`DESCRIPTION:${icsEscape(body)}`] : []),
    ...(ev.url ? [`URL:${ev.url}`] : []),
    // Reminder one week ahead — these are critical dates, not FYIs
    'BEGIN:VALARM',
    'TRIGGER:-P7D',
    'ACTION:DISPLAY',
    'DESCRIPTION:Reminder',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return lines.join('\r\n')
}

export function downloadIcs(ev: CalendarEvent, uid: string) {
  const blob = new Blob([buildIcs(ev, uid)], { type: 'text/calendar;charset=utf-8' })
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = `${ev.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'event'}.ics`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(href)
}

export function outlookWebUrl(ev: CalendarEvent): string {
  const body = [ev.description, ev.url].filter(Boolean).join('\n\n')
  const params = new URLSearchParams({
    path:    '/calendar/action/compose',
    rru:     'addevent',
    subject: ev.title,
    startdt: ev.date,
    enddt:   nextDay(ev.date),
    allday:  'true',
    ...(body ? { body } : {}),
  })
  return `https://outlook.office.com/calendar/0/deeplink/compose?${params.toString()}`
}

export function googleCalendarUrl(ev: CalendarEvent): string {
  const details = [ev.description, ev.url].filter(Boolean).join('\n\n')
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text:   ev.title,
    dates:  `${compactDate(ev.date)}/${compactDate(nextDay(ev.date))}`,
    ...(details ? { details } : {}),
  })
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}
