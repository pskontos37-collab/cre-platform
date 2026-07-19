import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import * as XLSX from 'npm:xlsx@0.18.5'
import { AuthError, canWriteProperty, requireUser } from '../_shared/auth.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// KM East = Midtown #0531, KM West = Midway #0532
const PROPERTY_MAP: Record<string, string> = {
  midtown:       '00000000-0000-0000-0000-000000000010',
  midway:        '00000000-0000-0000-0000-000000000011',
  consolidated:  '00000000-0000-0000-0000-000000000010', // default to East for consolidated
  knightdale:    '00000000-0000-0000-0000-000000000010',
}

// ── Drive auth ────────────────────────────────────────────────
async function getAccessToken(sa: Record<string, string>): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const enc = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

  const header  = enc({ alg: 'RS256', typ: 'JWT' })
  const payload = enc({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now,
  })
  const sigInput = `${header}.${payload}`
  const pem = sa.private_key
    .replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '').replace(/\n/g, '')   // gitleaks:allow — PEM header literals used to STRIP the marker, not key material
  const binaryKey = Uint8Array.from(atob(pem), c => c.charCodeAt(0))
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', binaryKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  )
  const sig    = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(sigInput))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

  const res  = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${sigInput}.${sigB64}`,
  })
  const data = await res.json()
  if (!data.access_token) throw new Error('Token error: ' + JSON.stringify(data))
  return data.access_token
}

// ── Classify a filename ───────────────────────────────────────
function classifyFile(name: string): {
  category: string | null; propertyKey: string | null; year: number | null; month: number | null
} {
  const lower = name.toLowerCase()
  // "07.2025 Rent Roll - Midtown.xlsx"
  let m = lower.match(/^(\d{2})\.(\d{4})\s+rent roll\s*[-–]\s*(midtown|midway|consolidated|knightdale)/)
  if (m) return { category: 'rent_roll', propertyKey: m[3], month: +m[1], year: +m[2] }
  // "07.2025 Trial Balance - Midtown.xlsx"
  m = lower.match(/^(\d{2})\.(\d{4})\s+trial balance\s*[-–]\s*(midtown|midway|consolidated|knightdale)/)
  if (m) return { category: 'trial_balance', propertyKey: m[3], month: +m[1], year: +m[2] }
  // "07.2025 (Trial Balance|Rent Roll) - Midtown.xlsx" alternate dash
  m = lower.match(/^(\d{2})[.\-](\d{4})\s+(rent roll|trial balance)\s*[-–]\s*(midtown|midway|consolidated|knightdale)/)
  if (m) return { category: m[3].replace(' ', '_'), propertyKey: m[4], month: +m[1], year: +m[2] }

  return { category: null, propertyKey: null, year: null, month: null }
}

// ── List xlsx files from Drive (concurrent BFS, same pattern as drive-inventory) ──
const EXCEL_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
])

async function listOneLevel(fid: string, token: string): Promise<{
  excelFiles: Array<Record<string, unknown>>; subfolders: string[]
}> {
  const excelFiles: Array<Record<string, unknown>> = []
  const subfolders: string[] = []
  let pageToken = ''
  do {
    const u = new URL('https://www.googleapis.com/drive/v3/files')
    u.searchParams.set('q',                        `'${fid}' in parents and trashed = false`)
    u.searchParams.set('fields',                   'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents)')
    u.searchParams.set('pageSize',                 '1000')
    u.searchParams.set('supportsAllDrives',        'true')
    u.searchParams.set('includeItemsFromAllDrives','true')
    if (pageToken) u.searchParams.set('pageToken', pageToken)
    const r    = await fetch(u.toString(), { headers: { Authorization: `Bearer ${token}` } })
    const data = await r.json()
    if (data.error) throw new Error(JSON.stringify(data.error))
    for (const f of (data.files ?? [])) {
      if (f.mimeType === 'application/vnd.google-apps.folder') subfolders.push(f.id)
      else if (EXCEL_MIME.has(f.mimeType)) excelFiles.push(f)
    }
    pageToken = data.nextPageToken ?? ''
  } while (pageToken)
  return { excelFiles, subfolders }
}

async function listExcelFiles(folderId: string, token: string): Promise<Array<Record<string, unknown>>> {
  const allFiles: Array<Record<string, unknown>> = []
  let currentLevel = [folderId]
  while (currentLevel.length > 0) {
    const results = await Promise.all(currentLevel.map(fid => listOneLevel(fid, token)))
    const nextLevel: string[] = []
    for (const r of results) { allFiles.push(...r.excelFiles); nextLevel.push(...r.subfolders) }
    currentLevel = nextLevel
  }
  return allFiles
}

// ── Parse rent roll workbook ──────────────────────────────────
interface RentRollRow {
  suite: string | null; tenant_name: string; sqft: number | null
  lease_start: string | null; lease_end: string | null
  monthly_base_rent: number | null; annual_base_rent: number | null; base_rent_psf: number | null
  is_occupied: boolean; raw_data: Record<string, unknown>
}

function parseRentRoll(buffer: Uint8Array): RentRollRow[] {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true })
  // Try sheet named "Rent Roll" first, otherwise first sheet
  const sheetName = wb.SheetNames.find(n => n.toLowerCase().includes('rent roll')) ?? wb.SheetNames[0]
  const ws = wb.Sheets[sheetName]
  const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as unknown[][]

  // Find header row by scanning first 20 rows
  const ALIASES: Record<string, string[]> = {
    suite:              ['suite', 'unit', 'space', 'unit no', 'suite no', 'bldg/unit'],
    tenant_name:        ['tenant', 'tenant name', 'lessee', 'occupant', 'name'],
    sqft:               ['sqft', 'sf', 'sq ft', 'square feet', 'rentable sf', 'leased sf', 'gla', 'rsf'],
    lease_start:        ['lease start', 'commencement', 'commencement date', 'start date', 'move in'],
    lease_end:          ['lease end', 'expiration', 'expiration date', 'end date', 'term end', 'move out'],
    monthly_base_rent:  ['monthly rent', 'monthly base rent', 'base rent/month', 'monthly base', 'mo. base rent'],
    annual_base_rent:   ['annual rent', 'annual base rent', 'base rent/yr', 'annual base', 'yr. base rent'],
    base_rent_psf:      ['psf', '$/sf', 'rent psf', 'rent/sf', 'base rent psf', 'annual psf'],
  }

  let headerRowIdx = -1
  let colMap: Record<string, number> = {}
  for (let i = 0; i < Math.min(20, rawRows.length); i++) {
    const row = rawRows[i].map(v => String(v).toLowerCase().trim())
    const testMap: Record<string, number> = {}
    for (const [field, aliases] of Object.entries(ALIASES)) {
      const idx = row.findIndex(cell => aliases.some(alias => cell.includes(alias)))
      if (idx >= 0) testMap[field] = idx
    }
    if (testMap.tenant_name !== undefined || (testMap.suite !== undefined && testMap.sqft !== undefined)) {
      headerRowIdx = i; colMap = testMap; break
    }
  }
  if (headerRowIdx < 0) return []

  const headers = rawRows[headerRowIdx] as string[]
  const parseDate = (v: unknown): string | null => {
    if (!v) return null
    if (v instanceof Date) return v.toISOString().split('T')[0]
    const s = String(v).trim()
    if (!s) return null
    const d = new Date(s)
    return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0]
  }
  const parseNum = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null
    const n = parseFloat(String(v).replace(/[$,\s]/g, ''))
    return isNaN(n) ? null : n
  }
  const get = (row: unknown[], field: string) => colMap[field] !== undefined ? row[colMap[field]] : null

  const rows: RentRollRow[] = []
  for (let i = headerRowIdx + 1; i < rawRows.length; i++) {
    const row = rawRows[i]
    const tenantName = String(get(row, 'tenant_name') ?? '').trim()
    if (!tenantName) continue
    const lower = tenantName.toLowerCase()
    if (lower.startsWith('total') || lower.startsWith('subtotal') || lower.startsWith('grand total')) continue

    let annual = parseNum(get(row, 'annual_base_rent'))
    let monthly = parseNum(get(row, 'monthly_base_rent'))
    // Derive whichever is missing
    if (annual && !monthly) monthly = annual / 12
    if (monthly && !annual) annual = monthly * 12

    rows.push({
      suite:             String(get(row, 'suite') ?? '').trim() || null,
      tenant_name:       tenantName,
      sqft:              parseNum(get(row, 'sqft')),
      lease_start:       parseDate(get(row, 'lease_start')),
      lease_end:         parseDate(get(row, 'lease_end')),
      monthly_base_rent: monthly,
      annual_base_rent:  annual,
      base_rent_psf:     parseNum(get(row, 'base_rent_psf')),
      is_occupied:       true,
      raw_data:          Object.fromEntries(headers.map((h, idx) => [String(h), row[idx]])),
    })
  }
  return rows
}

// ── Main handler ──────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const sa       = JSON.parse(Deno.env.get('GOOGLE_SERVICE_ACCOUNT') ?? '{}')
    const folderId = Deno.env.get('GOOGLE_DRIVE_FOLDER_ID') ?? ''
    const url      = new URL(req.url)
    const mode     = url.searchParams.get('mode') ?? 'status'

    if (!sa.client_email) throw new Error('GOOGLE_SERVICE_ACCOUNT secret not set')

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // AUTH (audit S2, added 2026-07-18): this retired Google-Drive import path
    // previously had NO caller check — anyone holding the public anon key could
    // trigger service-role writes into rent-roll/import tables. Imports are a
    // portfolio-wide operation: full-access callers only.
    const caller = await requireUser(req, sb)
    if (!canWriteProperty(caller, null)) throw new AuthError('Not permitted to run imports', 403)   // company-wide write action → full-write callers only (review #2/#14)

    // ── status: return catalog from DB ───────────────────────
    if (mode === 'status') {
      const { data, error } = await sb.from('drive_file_catalog')
        .select('*')
        .order('period_year', { ascending: false })
        .order('period_month', { ascending: false })
      if (error) throw new Error(error.message)
      return new Response(JSON.stringify({ files: data ?? [] }, null, 2), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    const token = await getAccessToken(sa)

    // ── catalog: scan Drive, classify, upsert into drive_file_catalog ──
    if (mode === 'catalog') {
      const driveFiles = await listExcelFiles(folderId, token)
      const rows = driveFiles.map(f => {
        const { category, propertyKey, year, month } = classifyFile(String(f.name))
        return {
          drive_id:         f.id,
          name:             f.name,
          mime_type:        f.mimeType,
          file_size_bytes:  f.size ? parseInt(String(f.size)) : null,
          modified_at:      f.modifiedTime,
          file_category:    category,
          property_id:      propertyKey ? (PROPERTY_MAP[propertyKey] ?? null) : null,
          period_year:      year,
          period_month:     month,
          import_status:    'pending',
          last_synced_at:   new Date().toISOString(),
        }
      })

      const { error } = await sb.from('drive_file_catalog').upsert(rows, {
        onConflict: 'drive_id',
        ignoreDuplicates: false,
      })
      if (error) throw new Error(error.message)

      const classified = rows.filter(r => r.file_category === 'rent_roll' || r.file_category === 'trial_balance')
      return new Response(JSON.stringify({
        total_excel_files:    rows.length,
        rent_rolls:           rows.filter(r => r.file_category === 'rent_roll').length,
        trial_balances:       rows.filter(r => r.file_category === 'trial_balance').length,
        other:                rows.length - classified.length,
        upserted:             rows.length,
      }, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── import: download + parse one rent roll file ──────────
    if (mode === 'import') {
      const driveId = url.searchParams.get('driveId')
      if (!driveId) throw new Error('?driveId= is required')

      // Look up metadata from catalog
      const { data: cat } = await sb.from('drive_file_catalog')
        .select('*').eq('drive_id', driveId).single()
      if (!cat) throw new Error(`File ${driveId} not found in catalog — run ?mode=catalog first`)
      if (cat.file_category !== 'rent_roll') {
        return new Response(JSON.stringify({ error: 'Only rent_roll files can be imported via this endpoint' }), {
          status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
        })
      }

      // Download file from Drive
      const fileRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${driveId}?alt=media&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (!fileRes.ok) throw new Error(`Drive download failed: ${fileRes.status}`)
      const buffer = new Uint8Array(await fileRes.arrayBuffer())

      // Parse
      const rows = parseRentRoll(buffer)
      if (rows.length === 0) throw new Error('Could not detect header row in this spreadsheet')

      const propertyId = cat.property_id
      if (!propertyId) throw new Error('No property_id mapped for this file in the catalog')

      // Compute snapshot metrics
      const occupiedRows   = rows.filter(r => r.is_occupied)
      const totalSF        = occupiedRows.reduce((s, r) => s + (r.sqft ?? 0), 0)
      const totalBaseRent  = occupiedRows.reduce((s, r) => s + (r.annual_base_rent ?? 0), 0)
      const avgPSF         = totalSF > 0 ? totalBaseRent / totalSF : null

      // Create import_job
      const { data: job } = await sb.from('import_jobs').insert({
        property_id:  propertyId,
        import_type:  'rent_roll',
        status:       'processing',
        file_name:    cat.name,
        row_count:    rows.length,
      }).select().single()

      // Upsert snapshot (replace if same period already imported)
      const { data: snapshot, error: snErr } = await sb.from('rent_roll_snapshots').upsert({
        property_id:       propertyId,
        period_year:       cat.period_year,
        period_month:      cat.period_month,
        drive_file_id:     driveId,
        import_job_id:     job?.id ?? null,
        total_sf:          totalSF,
        leased_sf:         totalSF,
        vacant_sf:         0,
        occupancy_pct:     totalSF > 0 ? 1.0 : null,
        avg_base_rent_psf: avgPSF,
        total_base_rent:   totalBaseRent,
        row_count:         rows.length,
      }, { onConflict: 'property_id,period_year,period_month' }).select().single()
      if (snErr) throw new Error(snErr.message)

      // Delete existing rows for this snapshot and re-insert
      await sb.from('rent_roll_rows').delete().eq('snapshot_id', snapshot.id)
      const rowsToInsert = rows.map(r => ({
        snapshot_id:       snapshot.id,
        property_id:       propertyId,
        suite:             r.suite,
        tenant_name:       r.tenant_name,
        sqft:              r.sqft,
        lease_start:       r.lease_start,
        lease_end:         r.lease_end,
        monthly_base_rent: r.monthly_base_rent,
        annual_base_rent:  r.annual_base_rent,
        base_rent_psf:     r.base_rent_psf,
        is_occupied:       r.is_occupied,
        raw_data:          r.raw_data,
      }))

      const { error: rrErr } = await sb.from('rent_roll_rows').insert(rowsToInsert)
      if (rrErr) throw new Error(rrErr.message)

      // Mark catalog file as imported + close job
      await sb.from('drive_file_catalog').update({
        import_status: 'imported', imported_at: new Date().toISOString(), import_job_id: job?.id,
      }).eq('drive_id', driveId)
      await sb.from('import_jobs').update({ status: 'complete' }).eq('id', job?.id)

      return new Response(JSON.stringify({
        success: true, rows_imported: rows.length,
        snapshot_id: snapshot.id, period: `${cat.period_year}-${String(cat.period_month).padStart(2, '0')}`,
        total_sf: totalSF, total_base_rent: totalBaseRent,
        sample_tenants: rows.slice(0, 5).map(r => r.tenant_name),
      }, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ error: 'Use ?mode=status|catalog|import&driveId=xxx' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 500
    return new Response(JSON.stringify({ error: msg }), {
      status, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
