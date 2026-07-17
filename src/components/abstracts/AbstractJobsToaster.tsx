import { useAuth } from '../../contexts/AuthContext'
import { useAbstractJobs, AbstractJob } from '../../hooks/useAbstractJobs'

// Global, app-wide notifier for abstract background jobs (upload -> re-abstract).
// Mounted once in AppLayout so a reviewer who kicks off a run on the Abstracts
// page and then navigates away still gets progress + a completion alert.
//
// NOTE: the pipeline itself is driven from the browser tab; this toaster only
// reports the status the pipeline writes to the abstract_jobs table. A run
// survives navigation within the SPA but not a full tab close.

const STATUS_STYLE: Record<AbstractJob['status'], { border: string; label: string; icon: string }> = {
  running: { border: 'var(--accent)', label: 'Working', icon: '⏳' },
  done: { border: 'var(--green, #22c55e)', label: 'Done', icon: '✓' },
  error: { border: 'var(--red, #ef4444)', label: 'Failed', icon: '⚠' },
}

export function AbstractJobsToaster() {
  const { appUser } = useAuth()
  // Jobs are an admin / asset-manager surface (RLS mirrors it); skip the poll
  // entirely for other roles.
  const isReviewer = appUser?.role === 'admin' || appUser?.role === 'asset_manager'
  const { jobs, dismiss } = useAbstractJobs(isReviewer ? appUser?.id : null)

  if (!isReviewer || jobs.length === 0) return null

  return (
    <div style={{
      position: 'fixed', right: 18, bottom: 18, zIndex: 1000,
      display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 360,
    }}>
      {jobs.map(job => {
        const s = STATUS_STYLE[job.status]
        return (
          <div key={job.id} style={{
            background: 'var(--surface)', border: `1px solid var(--border)`,
            borderLeft: `3px solid ${s.border}`, borderRadius: 10,
            padding: '10px 12px', boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
            display: 'flex', gap: 10, alignItems: 'flex-start',
          }}>
            <span style={{ fontSize: 14, lineHeight: '18px' }}>{s.icon}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>
                {job.tenant_name}
                <span style={{ fontWeight: 500, color: 'var(--text-faint)' }}> · {s.label}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {job.status === 'error'
                  ? (job.error ?? 'Something went wrong')
                  : job.status === 'done'
                    ? `Abstract updated${job.file_name ? ` from ${job.file_name}` : ''} — re-verified.`
                    : (job.phase ?? 'Working…')}
              </div>
              {job.file_name && job.status === 'running' && (
                <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {job.file_name}
                </div>
              )}
            </div>
            {job.status === 'running'
              ? <span className="spin" style={{ width: 12, height: 12, border: '2px solid var(--border-2)', borderTopColor: s.border, borderRadius: '50%', display: 'inline-block' }} />
              : <button onClick={() => void dismiss(job.id)} title="Dismiss"
                  style={{ fontSize: 14, lineHeight: '14px', color: 'var(--text-faint)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>×</button>}
          </div>
        )
      })}
      <style>{`@keyframes ajspin{to{transform:rotate(360deg)}} .spin{animation:ajspin .8s linear infinite}`}</style>
    </div>
  )
}
