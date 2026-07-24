// ── MRI_CMROLL rent-roll parser (pure) ───────────────────────────────────────
// A faithful port of scripts/load_rentroll.ps1's parse, moved into testable
// TypeScript so the onboarding wizard can stage a monthly MRI export from the
// browser instead of a PowerShell run. Pure by design: it takes a plain cell
// matrix, so the xlsx reader stays out of the unit tests.
//
// Trust-layer behavior carried over from the loader:
//   * the file's own "Totals:" row is CROSS-CHECKED against our computed sum —
//     a mismatch is reported, never silently accepted (the loader aborted the
//     DB write on this; the wizard surfaces it and blocks go-live)
//   * "Additional Space" continuation rows are real occupied units (SF, no rent)
//   * vacant/new-lease sections carry SF but never rent
//
// Column layout is 1-based to match the documented MRI export (and the original
// script): 1 Bldg Id | 2 Suit Id | 3 Tenant | 4 Lease start | 5 Lease end |
// 6 SF | 7 Monthly base | 8 PSF | 9 Cost recovery | 11 Other income.

export type Cell = string | number | boolean | Date | null | undefined

export interface RentRollRow {
  property_id?: string | null
  suite: string | null
  tenant_name: string | null
  sqft: number | null
  lease_start: string | null
  lease_end: string | null
  monthly_base_rent: number | null
  annual_base_rent: number | null
  base_rent_psf: number | null
  is_occupied: boolean
  raw_data: Record<string, unknown>
}

export interface RentRollSummary {
  total_sf: number
  leased_sf: number
  vacant_sf: number
  occupancy_pct: number | null
  avg_base_rent_psf: number | null
  total_base_rent: number
  row_count: number        // occupied rows (matches the loader's snapshot field)
  occupied_units: number   // occupied rows naming a real tenant
  vacant_count: number
}

export interface RentRollParse {
  rows: RentRollRow[]
  summary: RentRollSummary
  /** Monthly base rent printed on the file's own Totals row, when present. */
  file_total_monthly: number | null
  /** Difference between our sum and the file's own total (0 when they agree). */
  total_variance: number | null
  /** Blocking problems: parse failures or a totals mismatch. */
  errors: string[]
  /** Non-blocking observations worth showing the reviewer. */
  warnings: string[]
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** 1-based cell read, tolerant of ragged rows. */
function at(m: Cell[][], row: number, col: number): Cell {
  return m[row - 1]?.[col - 1]
}

export function cellText(v: Cell): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  const s = String(v).trim()
  return s === '' ? null : s
}

export function cellNumber(v: Cell): number | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (v instanceof Date) return null
  if (typeof v === 'boolean') return null
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''))
  return Number.isNaN(n) ? null : n
}

/** Excel serial (1899-12-30 epoch) / Date / ISO-ish string -> UTC yyyy-mm-dd. */
export function cellDate(v: Cell): string | null {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null
    const ms = Date.UTC(1899, 11, 30) + Math.round(v) * 86400000
    return new Date(ms).toISOString().slice(0, 10)
  }
  const s = String(v).trim()
  if (s === '') return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)   // US m/d/yyyy, UTC-safe
  if (m) {
    const iso = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2])).toISOString().slice(0, 10)
    return iso
  }
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10)
}

const BLDG_RE = /^\d{4}$/

/** Locate the "Bldg Id / Suit Id" header row (1-based). 0 = not found.
 *  Case-insensitive, matching PowerShell's `-eq` in the original loader. */
export function findHeaderRow(m: Cell[][]): number {
  const limit = Math.min(15, m.length)
  const eq = (v: Cell, want: string) => (cellText(v) ?? '').toLowerCase() === want
  for (let r = 1; r <= limit; r++) {
    if (eq(at(m, r, 1), 'bldg id') && eq(at(m, r, 2), 'suit id')) return r
  }
  return 0
}

export function parseMriRentRoll(m: Cell[][]): RentRollParse {
  const errors: string[] = []
  const warnings: string[] = []
  const rows: RentRollRow[] = []

  const hdr = findHeaderRow(m)
  if (hdr === 0) {
    return {
      rows: [], file_total_monthly: null, total_variance: null,
      summary: {
        total_sf: 0, leased_sf: 0, vacant_sf: 0, occupancy_pct: null,
        avg_base_rent_psf: null, total_base_rent: 0, row_count: 0,
        occupied_units: 0, vacant_count: 0,
      },
      errors: ['Could not find the MRI header row ("Bldg Id" / "Suit Id") in the first 15 rows. Is this an MRI_CMROLL export?'],
      warnings,
    }
  }

  let section: 'new' | 'vacant' | 'occupied' | null = null
  let fileTotalMonthly: number | null = null

  for (let r = hdr + 1; r <= m.length; r++) {
    const c1 = cellText(at(m, r, 1))

    if (c1 === null) {
      // Continuation row. "Additional Space" is a real occupied unit the file
      // counts separately (SF only, no rent); future rent-increase and
      // per-tenant Total subrows are skipped.
      const c3 = cellText(at(m, r, 3))
      if (section === 'occupied' && c3 && /Additional Space/i.test(c3)) {
        rows.push({
          suite: cellText(at(m, r, 2)),
          tenant_name: c3,
          sqft: cellNumber(at(m, r, 6)),
          lease_start: cellDate(at(m, r, 4)),
          lease_end: cellDate(at(m, r, 5)),
          monthly_base_rent: null,
          annual_base_rent: null,
          base_rent_psf: null,
          is_occupied: true,
          raw_data: { section: 'occupied', additional_space: true },
        })
      }
      continue
    }

    if (!BLDG_RE.test(c1)) {
      // Section label, or the totals row that ends the data.
      if (/New Leases/i.test(c1)) { section = 'new'; continue }
      if (/Vacant/i.test(c1))     { section = 'vacant'; continue }
      if (/Occupied/i.test(c1))   { section = 'occupied'; continue }
      if (/Total/i.test(c1)) { fileTotalMonthly = cellNumber(at(m, r, 7)); break }
      continue
    }

    const suite = cellText(at(m, r, 2))
    if (suite === null) continue

    const occupied = section === 'occupied'
    const monthly = occupied ? cellNumber(at(m, r, 7)) : null
    const psf     = occupied ? cellNumber(at(m, r, 8)) : null

    rows.push({
      suite,
      tenant_name: cellText(at(m, r, 3)),
      sqft: cellNumber(at(m, r, 6)),
      lease_start: cellDate(at(m, r, 4)),
      lease_end: cellDate(at(m, r, 5)),
      monthly_base_rent: monthly,
      annual_base_rent: monthly === null ? null : round2(monthly * 12),
      base_rent_psf: psf,
      is_occupied: occupied,
      raw_data: {
        section: section ?? 'unknown',
        entity: c1,
        cost_recovery: cellNumber(at(m, r, 9)),
        other_income: cellNumber(at(m, r, 11)),
      },
    })
  }

  if (section === null) {
    warnings.push('No Occupied/Vacant section labels were found — every row was read as unsectioned, so no rent was captured.')
  }

  const occRows = rows.filter(r => r.is_occupied)
  const vacRows = rows.filter(r => !r.is_occupied && r.raw_data.section === 'vacant')
  const leasedSf = occRows.reduce((s, r) => s + (r.sqft ?? 0), 0)
  const vacantSf = vacRows.reduce((s, r) => s + (r.sqft ?? 0), 0)
  const monthlySum = occRows.reduce((s, r) => s + (r.monthly_base_rent ?? 0), 0)
  const annualSum = round2(monthlySum * 12)
  const totalSf = leasedSf + vacantSf

  const summary: RentRollSummary = {
    total_sf: totalSf,
    leased_sf: leasedSf,
    vacant_sf: vacantSf,
    occupancy_pct: totalSf > 0 ? Math.round((leasedSf / totalSf) * 10000) / 10000 : null,
    avg_base_rent_psf: leasedSf > 0 ? round2(annualSum / leasedSf) : null,
    total_base_rent: annualSum,
    row_count: occRows.length,
    occupied_units: occRows.filter(r => r.tenant_name && r.tenant_name !== 'Vacant').length,
    vacant_count: vacRows.length,
  }

  // Self-validation against the file's own printed total (the loader aborted the
  // DB write on a mismatch; here it blocks go-live instead).
  let variance: number | null = null
  if (fileTotalMonthly !== null) {
    variance = round2(monthlySum - fileTotalMonthly)
    if (Math.abs(variance) > 1) {
      errors.push(
        `Monthly base rent does not tie to the file's own total: parsed ${round2(monthlySum).toLocaleString('en-US')} vs printed ${fileTotalMonthly.toLocaleString('en-US')} (off by ${variance.toLocaleString('en-US')}). Do not load this file until the difference is explained.`,
      )
    }
  } else {
    warnings.push('No "Totals" row found, so the parsed rent could not be cross-checked against the file.')
  }

  if (rows.length === 0) errors.push('No tenant rows were found below the header.')

  return { rows, summary, file_total_monthly: fileTotalMonthly, total_variance: variance, errors, warnings }
}
