import { describe, it, expect } from 'vitest'
import {
  parseMriRentRoll, findHeaderRow, cellDate, cellNumber, cellText,
  type Cell, type RentRollRow,
} from '../rentRollParse'

// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN SET — the onboarding wizard stages a monthly MRI export straight from
// the browser, so this parser stands where load_rentroll.ps1's abort-on-mismatch
// used to stand. Each case asserts the RIGHT value AND that the wrong value
// (inflated rent, dropped units, a silently-accepted totals mismatch) cannot
// pass. Layout: 1 Bldg | 2 Suite | 3 Tenant | 4 Start | 5 End | 6 SF |
// 7 Monthly | 8 PSF | 9 Cost recovery | 11 Other income.
// ─────────────────────────────────────────────────────────────────────────────

// Excel serials (1899-12-30 epoch): 44774 = 2022-08-01, 48000 = 2031-06-01.
const SERIAL_2022_08_01 = 44774

/** Builds a realistic MRI_CMROLL sheet: preamble, header, three sections, totals. */
function sheet(opts: { printedTotal?: number | null } = {}): Cell[][] {
  const printedTotal = opts.printedTotal === undefined ? 12000 : opts.printedTotal
  return [
    ['MJW Property Management', null, null, null, null, null, null],
    ['Commercial Rent Roll', null, null, null, null, null, null],
    ['As of 06/30/2026', null, null, null, null, null, null],
    ['Bldg Id', 'Suit Id', 'Tenant Name', 'Lease Start', 'Lease End', 'Sq Ft', 'Monthly Rent', 'PSF', 'Cost Recovery', null, 'Other Income'],
    ['Occupied Units', null, null, null, null, null, null],
    ['0840', 'A01', 'Starbucks', new Date(Date.UTC(2021, 7, 1)), new Date(Date.UTC(2031, 6, 31)), 2000, 7000, 42, 500, null, 25],
    ['0840', 'A02', 'Chipotle', SERIAL_2022_08_01, 48000, 1000, 5000, 60, 250, null, null],
    // Continuation rows: Additional Space is its own occupied unit (SF, no rent);
    // the future-increase subrow must be ignored.
    [null, 'A02B', 'Additional Space', null, null, 500, null, null, null, null, null],
    [null, null, 'Future increase 01/2027', null, null, null, 5500, null, null, null, null],
    ['Vacant Units', null, null, null, null, null, null],
    ['0840', 'A03', 'Vacant', null, null, 800, 9999, 99, null, null, null],
    ['New Leases', null, null, null, null, null, null],
    ['0840', 'A04', 'Sweetgreen', '2026-08-01', '2036-07-31', 1500, 8888, 88, null, null, null],
    ['Totals:', null, null, null, null, 4300, printedTotal, null, null, null, null],
    ['0840', 'ZZZ', 'Row after totals must be ignored', null, null, 9999, 9999, 9, null, null, null],
  ]
}

function bySuite(rows: RentRollRow[]): Record<string, RentRollRow> {
  const out: Record<string, RentRollRow> = {}
  for (const r of rows) out[String(r.suite)] = r
  return out
}

describe('GOLDEN — MRI rent roll: sections govern whether rent is captured', () => {
  const p = parseMriRentRoll(sheet())
  const byS = bySuite(p.rows)

  it('parses every real unit and ignores subtotal / post-totals noise', () => {
    expect(p.rows.map(r => r.suite)).toEqual(['A01', 'A02', 'A02B', 'A03', 'A04'])
    expect(p.rows.some(r => /must be ignored/.test(r.tenant_name ?? ''))).toBe(false)
    expect(p.rows.some(r => /Future increase/.test(r.tenant_name ?? ''))).toBe(false)
  })

  it('captures rent ONLY for occupied units', () => {
    expect(byS.A01.monthly_base_rent).toBe(7000)
    expect(byS.A02.monthly_base_rent).toBe(5000)
    // Vacant + new-lease asking rents are not income: the sheet shows 9999/8888,
    // and reading them would inflate the roll by $18,887/mo.
    expect(byS.A03.monthly_base_rent).toBeNull()
    expect(byS.A04.monthly_base_rent).toBeNull()
    expect(byS.A03.is_occupied).toBe(false)
    expect(byS.A04.is_occupied).toBe(false)
  })

  it('treats Additional Space as an occupied SF-only unit', () => {
    expect(byS.A02B.is_occupied).toBe(true)
    expect(byS.A02B.sqft).toBe(500)
    expect(byS.A02B.monthly_base_rent).toBeNull()
    expect(byS.A02B.raw_data.additional_space).toBe(true)
  })

  it('annualizes monthly rent exactly (never a stale annual column)', () => {
    expect(byS.A01.annual_base_rent).toBe(84000)
    expect(p.summary.total_base_rent).toBe(144000)   // (7000 + 5000) * 12
  })

  it('computes the snapshot summary the way the loader did', () => {
    expect(p.summary.leased_sf).toBe(3500)           // 2000 + 1000 + 500
    expect(p.summary.vacant_sf).toBe(800)            // new-lease SF is not vacancy
    expect(p.summary.total_sf).toBe(4300)            // ties to the file's SF total
    expect(p.summary.occupancy_pct).toBeCloseTo(0.814, 4)
    expect(p.summary.avg_base_rent_psf).toBeCloseTo(41.14, 2)
    expect(p.summary.row_count).toBe(3)              // occupied rows
    expect(p.summary.occupied_units).toBe(3)
    expect(p.summary.vacant_count).toBe(1)
  })

  it('coerces dates to UTC ISO from Date objects, Excel serials and strings', () => {
    expect(byS.A01.lease_start).toBe('2021-08-01')   // Date object
    expect(byS.A02.lease_start).toBe('2022-08-01')   // Excel serial
    expect(byS.A04.lease_start).toBe('2026-08-01')   // ISO string
    expect(byS.A01.lease_end).toBe('2031-07-31')
  })
})

describe("GOLDEN — the file's own Totals row is cross-checked, not trusted", () => {
  it('agrees silently when the parse ties to the printed total', () => {
    const p = parseMriRentRoll(sheet({ printedTotal: 12000 }))
    expect(p.file_total_monthly).toBe(12000)
    expect(p.total_variance).toBe(0)
    expect(p.errors).toEqual([])
  })

  it('BLOCKS when the parse does not tie (a missed unit must never load clean)', () => {
    const p = parseMriRentRoll(sheet({ printedTotal: 17500 }))
    expect(p.total_variance).toBe(-5500)
    expect(p.errors.length).toBeGreaterThan(0)
    expect(p.errors[0]).toMatch(/does not tie/i)
    // and it still reports the honest parsed figure rather than the printed one
    expect(p.summary.total_base_rent).toBe(144000)
  })

  it('warns (not errors) when the file has no Totals row to check against', () => {
    const rows = sheet().filter(r => !/^Totals/.test(String(r[0] ?? '')))
    const p = parseMriRentRoll(rows)
    expect(p.file_total_monthly).toBeNull()
    expect(p.errors).toEqual([])
    expect(p.warnings.some(w => /could not be cross-checked/i.test(w))).toBe(true)
  })

  it('tolerates rounding under a dollar', () => {
    const p = parseMriRentRoll(sheet({ printedTotal: 11999.5 }))
    expect(p.errors).toEqual([])
  })
})

describe('GOLDEN — refuses to guess at a file it does not recognize', () => {
  it('errors when the MRI header row is absent', () => {
    const p = parseMriRentRoll([
      ['Some other report'], ['Tenant', 'Rent'], ['Starbucks', 7000],
    ])
    expect(p.rows).toEqual([])
    expect(p.errors[0]).toMatch(/header row/i)
    expect(p.summary.total_base_rent).toBe(0)
  })

  it('errors when the header exists but no tenant rows follow', () => {
    const p = parseMriRentRoll([
      ['Bldg Id', 'Suit Id', 'Tenant Name'], ['Occupied Units'],
    ])
    expect(p.errors.some(e => /No tenant rows/i.test(e))).toBe(true)
  })

  it('finds the header row wherever it sits in the preamble', () => {
    expect(findHeaderRow(sheet())).toBe(4)
    expect(findHeaderRow([['x'], ['y']])).toBe(0)
  })
})

describe('cell coercion helpers', () => {
  it('reads money with currency noise', () => {
    expect(cellNumber('$1,234.50')).toBe(1234.5)
    expect(cellNumber('')).toBeNull()
    expect(cellNumber(null)).toBeNull()
    expect(cellNumber('n/a')).toBeNull()
  })

  it('trims text and nulls empties', () => {
    expect(cellText('  Starbucks ')).toBe('Starbucks')
    expect(cellText('   ')).toBeNull()
  })

  it('handles US m/d/yyyy without timezone drift', () => {
    expect(cellDate('8/1/2021')).toBe('2021-08-01')
    expect(cellDate('12/31/2030')).toBe('2030-12-31')
    expect(cellDate(0)).toBeNull()
    expect(cellDate('not a date')).toBeNull()
  })
})
