import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, requireUser } from '../_shared/auth.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

async function getAccessToken(sa: Record<string, string>): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const enc = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

  const header  = enc({ alg: 'RS256', typ: 'JWT' })
  const payload = enc({
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  })

  const sigInput = `${header}.${payload}`
  const pem = sa.private_key
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\n/g, '')

  const binaryKey = Uint8Array.from(atob(pem), c => c.charCodeAt(0))
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign'],
  )
  const sig    = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(sigInput))
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

  const res  = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${sigInput}.${sigB64}`,
  })
  const data = await res.json()
  if (!data.access_token) throw new Error('Token error: ' + JSON.stringify(data))
  return data.access_token
}

interface DriveFile {
  id: string; name: string; type: string;
  size?: string; modified?: string; parentId: string; parentName: string;
}

// Lists immediate children of one folder; returns files + subfolder ids+names
async function listOneFolder(
  fid: string,
  fname: string,
  token: string,
): Promise<{ files: DriveFile[]; subfolders: { id: string; name: string }[] }> {
  const files: DriveFile[] = []
  const subfolders: { id: string; name: string }[] = []
  let pageToken = ''

  do {
    const u = new URL('https://www.googleapis.com/drive/v3/files')
    u.searchParams.set('q',                        `'${fid}' in parents and trashed = false`)
    u.searchParams.set('fields',                   'nextPageToken,files(id,name,mimeType,size,modifiedTime)')
    u.searchParams.set('pageSize',                 '1000')
    u.searchParams.set('supportsAllDrives',        'true')
    u.searchParams.set('includeItemsFromAllDrives','true')
    if (pageToken) u.searchParams.set('pageToken', pageToken)

    const r    = await fetch(u.toString(), { headers: { Authorization: `Bearer ${token}` } })
    const data = await r.json()
    if (data.error) throw new Error(JSON.stringify(data.error))

    for (const f of (data.files ?? [])) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        subfolders.push({ id: f.id, name: f.name })
      } else {
        files.push({
          id:         f.id,
          name:       f.name,
          type:       f.mimeType,
          size:       f.size,
          modified:   f.modifiedTime,
          parentId:   fid,
          parentName: fname,
        })
      }
    }
    pageToken = data.nextPageToken ?? ''
  } while (pageToken)

  return { files, subfolders }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    // AUTH (audit S2, added 2026-07-18): previously NO caller check — anyone with
    // the public anon key could enumerate arbitrary Drive folders through the
    // org's Google service account. Retired debug tooling: full-access callers only.
    const authSb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const caller = await requireUser(req, authSb)
    if (caller.access !== 'all') throw new AuthError('Not permitted', 403)

    const sa       = JSON.parse(Deno.env.get('GOOGLE_SERVICE_ACCOUNT') ?? '{}')
    const url      = new URL(req.url)
    const mode     = url.searchParams.get('mode') ?? 'debug'
    const folderId = url.searchParams.get('folder') ?? Deno.env.get('GOOGLE_DRIVE_FOLDER_ID') ?? ''

    if (!sa.client_email) throw new Error('GOOGLE_SERVICE_ACCOUNT secret not set or invalid JSON')
    if (!folderId)        throw new Error('No folder ID — set GOOGLE_DRIVE_FOLDER_ID secret or pass ?folder=')

    const token = await getAccessToken(sa)

    // ── debug ──────────────────────────────────────────────────────────────
    if (mode === 'debug') {
      const metaRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name,mimeType&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const meta = await metaRes.json()
      const { files, subfolders } = await listOneFolder(folderId, meta.name ?? folderId, token)
      return new Response(JSON.stringify({ folder: meta, immediate_files: files.length, subfolders }, null, 2), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    // ── inventory: concurrent BFS — all folders at each level in parallel ──
    if (mode === 'inventory') {
      const allFiles: DriveFile[] = []

      // Seed with root folder name
      const rootMeta = await fetch(
        `https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } }
      ).then(r => r.json())

      let currentLevel = [{ id: folderId, name: rootMeta.name ?? folderId }]

      while (currentLevel.length > 0) {
        // Fetch all folders in this BFS level concurrently
        const results = await Promise.all(
          currentLevel.map(f => listOneFolder(f.id, f.name, token))
        )
        const nextLevel: { id: string; name: string }[] = []
        for (const result of results) {
          allFiles.push(...result.files)
          nextLevel.push(...result.subfolders)
        }
        currentLevel = nextLevel
      }

      // Summary by MIME type
      const byType: Record<string, number> = {}
      for (const f of allFiles) {
        byType[f.type] = (byType[f.type] ?? 0) + 1
      }

      return new Response(JSON.stringify({ total: allFiles.length, by_type: byType, files: allFiles }, null, 2), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ error: 'Use ?mode=debug or ?mode=inventory' }), {
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
