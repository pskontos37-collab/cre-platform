import { useState, useCallback, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { Badge } from '../components/ui/Badge'

const FN_BASE = import.meta.env.VITE_SUPABASE_URL + '/functions/v1'

interface CatalogFile {
  drive_id: string
  name: string
  parent_folder: string | null
  file_category: string | null
  property_id: string | null
  period_year: number | null
  period_month: number | null
  import_status: 'pending' | 'imported' | 'error' | 'skipped'
  imported_at: string | null
  import_error: string | null
  last_synced_at: string
}

const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const CATEGORY_LABEL: Record<string, string> = {
  rent_roll:         'Rent Roll',
  trial_balance:     'Trial Balance',
  income_statement:  'Income Statement',
  budget:            'Budget',
  other:             'Other',
}

async function callImportFn(path: string): Promise<Record<string, unknown>> {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(`${FN_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${session?.access_token ?? ''}` },
  })
  return res.json()
}

export function ImportPage() {
  const { appUser } = useAuth()
  const [files, setFiles]         = useState<CatalogFile[]>([])
  const [loading, setLoading]     = useState(false)
  const [syncing, setSyncing]     = useState(false)
  const [importing, setImporting] = useState<string | null>(null) // driveId being imported
  const [message, setMessage]     = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [filter, setFilter]       = useState<'all' | 'rent_roll' | 'trial_balance'>('rent_roll')

  const loadStatus = useCallback(async () => {
    setLoading(true)
    try {
      const result = await callImportFn('drive-import?mode=status')
      setFiles((result.files as CatalogFile[]) ?? [])
    } catch {
      setMessage({ type: 'error', text: 'Could not load catalog — have you synced Drive yet?' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadStatus() }, [loadStatus])

  async function handleSync() {
    setSyncing(true)
    setMessage(null)
    try {
      const result = await callImportFn('drive-import?mode=catalog')
      if (result.error) throw new Error(String(result.error))
      setMessage({
        type: 'success',
        text: `Synced ${result.total_excel_files} Excel files — ${result.rent_rolls} rent rolls, ${result.trial_balances} trial balances`,
      })
      await loadStatus()
    } catch (e) {
      setMessage({ type: 'error', text: String(e) })
    } finally {
      setSyncing(false)
    }
  }

  async function handleImport(driveId: string) {
    setImporting(driveId)
    setMessage(null)
    try {
      const result = await callImportFn(`drive-import?mode=import&driveId=${driveId}`)
      if (result.error) throw new Error(String(result.error))
      setMessage({
        type: 'success',
        text: `Imported ${result.rows_imported} rows for ${result.period} — ${result.sample_tenants?.join(', ')}...`,
      })
      await loadStatus()
    } catch (e) {
      setMessage({ type: 'error', text: String(e) })
    } finally {
      setImporting(null)
    }
  }

  if (appUser?.role !== 'admin' && appUser?.role !== 'asset_manager') {
    return (
      <div style={{ padding: '40px 32px', color: 'var(--text-muted)', fontSize: 14 }}>
        You need admin or asset manager access to use the import pipeline.
      </div>
    )
  }

  const filtered = files.filter(f =>
    filter === 'all' ? true : f.file_category === filter
  )
  const importable  = filtered.filter(f => f.file_category === 'rent_roll' && f.import_status !== 'imported')
  const importedCnt = files.filter(f => f.import_status === 'imported').length
  const pendingCnt  = files.filter(f => f.import_status === 'pending').length

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1100 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
            Drive Import
          </h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Sync and import rent rolls from the Knightdale Google Drive folder
          </p>
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          style={{
            background:   syncing ? 'var(--surface-2)' : 'var(--accent)',
            color:        syncing ? 'var(--text-muted)' : '#fff',
            border:       'none',
            borderRadius: 8,
            padding:      '9px 18px',
            fontSize:     13,
            fontWeight:   600,
            cursor:       syncing ? 'wait' : 'pointer',
          }}
        >
          {syncing ? 'Syncing Drive…' : '↻ Sync Drive Files'}
        </button>
      </div>

      {/* Status message */}
      {message && (
        <div
          style={{
            padding:      '10px 14px',
            borderRadius: 8,
            fontSize:     13,
            marginBottom: 16,
            background:   message.type === 'success' ? 'var(--green-bg)' : 'var(--red-bg)',
            border:       `1px solid ${message.type === 'success' ? 'var(--green-border)' : 'var(--red-border)'}`,
            color:        message.type === 'success' ? 'var(--green)' : 'var(--red)',
          }}
        >
          {message.text}
        </div>
      )}

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
        {[
          { label: 'Total Excel files', value: files.length },
          { label: 'Imported', value: importedCnt },
          { label: 'Pending import', value: pendingCnt },
        ].map(card => (
          <div
            key={card.label}
            style={{
              background:   'var(--surface)',
              border:       '1px solid var(--border)',
              borderRadius: 10,
              padding:      '14px 16px',
            }}
          >
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 4 }}>{card.label}</div>
            <div style={{ fontSize: 26, fontWeight: 600, color: 'var(--text)' }}>{card.value}</div>
          </div>
        ))}
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {(['rent_roll', 'trial_balance', 'all'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              padding:      '5px 14px',
              borderRadius: 20,
              fontSize:     12,
              fontWeight:   filter === f ? 600 : 400,
              border:       `1px solid ${filter === f ? 'var(--accent)' : 'var(--border)'}`,
              background:   filter === f ? 'var(--accent-dim)' : 'transparent',
              color:        filter === f ? 'var(--accent)' : 'var(--text-muted)',
              cursor:       'pointer',
            }}
          >
            {f === 'all' ? 'All files' : CATEGORY_LABEL[f]}
            <span style={{ marginLeft: 6, opacity: 0.7 }}>
              {f === 'all' ? files.length : files.filter(x => x.file_category === f).length}
            </span>
          </button>
        ))}

        {filter === 'rent_roll' && importable.length > 0 && (
          <button
            onClick={async () => {
              for (const f of importable) {
                if (f.import_status !== 'imported') await handleImport(f.drive_id)
              }
            }}
            style={{
              marginLeft:   'auto',
              padding:      '5px 14px',
              borderRadius: 20,
              fontSize:     12,
              fontWeight:   600,
              border:       '1px solid var(--green-border)',
              background:   'var(--green-bg)',
              color:        'var(--green)',
              cursor:       'pointer',
            }}
          >
            Import all pending ({importable.length})
          </button>
        )}
      </div>

      {/* File table */}
      <div
        style={{
          background:   'var(--surface)',
          border:       '1px solid var(--border)',
          borderRadius: 10,
          overflow:     'hidden',
        }}
      >
        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-faint)', fontSize: 13 }}>
            Loading catalog…
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-faint)', fontSize: 13 }}>
            {files.length === 0
              ? 'No files synced yet — click "Sync Drive Files" to scan Google Drive'
              : 'No files match the selected filter'}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
                {['File name', 'Category', 'Period', 'Status', ''].map(h => (
                  <th
                    key={h}
                    style={{
                      padding:   '9px 14px',
                      textAlign: 'left',
                      fontWeight: 500,
                      fontSize:  11,
                      color:     'var(--text-faint)',
                      textTransform: 'uppercase',
                      letterSpacing: '.04em',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((f, i) => (
                <tr
                  key={f.drive_id}
                  style={{
                    borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none',
                    background: importing === f.drive_id ? 'var(--accent-dim)' : 'transparent',
                  }}
                >
                  <td style={{ padding: '10px 14px', color: 'var(--text)', maxWidth: 360 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.name}
                    </div>
                    {f.parent_folder && (
                      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>
                        {f.parent_folder}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    {f.file_category ? (
                      <Badge variant={f.file_category === 'rent_roll' ? 'blue' : 'gray'}>
                        {CATEGORY_LABEL[f.file_category] ?? f.file_category}
                      </Badge>
                    ) : (
                      <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>unclassified</span>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {f.period_year && f.period_month
                      ? `${MONTH_NAMES[f.period_month]} ${f.period_year}`
                      : '—'}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <Badge
                      variant={
                        f.import_status === 'imported' ? 'green'
                        : f.import_status === 'error'  ? 'red'
                        : 'gray'
                      }
                    >
                      {f.import_status === 'imported'
                        ? `Imported ${f.imported_at ? new Date(f.imported_at).toLocaleDateString() : ''}`
                        : f.import_status}
                    </Badge>
                  </td>
                  <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                    {f.file_category === 'rent_roll' && f.import_status !== 'imported' && (
                      <button
                        onClick={() => handleImport(f.drive_id)}
                        disabled={!!importing}
                        style={{
                          background:   'var(--accent)',
                          color:        '#fff',
                          border:       'none',
                          borderRadius: 6,
                          padding:      '4px 12px',
                          fontSize:     12,
                          fontWeight:   600,
                          cursor:       importing ? 'wait' : 'pointer',
                          opacity:      importing && importing !== f.drive_id ? 0.4 : 1,
                          whiteSpace:   'nowrap',
                        }}
                      >
                        {importing === f.drive_id ? 'Importing…' : 'Import'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Help note */}
      <p style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 14, lineHeight: 1.6 }}>
        Rent rolls are imported into the database and update occupancy, WALT, and lease rollover widgets.
        Trial balances will be importable in a future update. Import is non-destructive — re-importing overwrites the same period.
      </p>
    </div>
  )
}
