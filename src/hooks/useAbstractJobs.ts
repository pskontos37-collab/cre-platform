import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

// Background-job ledger for the abstract review surface (migration 20240111).
// The upload/re-abstract pipeline is orchestrated client-side but writes its
// progress here, so a reviewer can kick a run off and keep working elsewhere in
// the app while a global toaster (AbstractJobsToaster) shows progress + a
// completion alert. See supabase/migrations/20240111_abstract_jobs.sql.

export interface AbstractJob {
  id: string
  property_id: string | null
  tenant_name: string
  kind: 'upload_reabstract' | 'reabstract'
  status: 'running' | 'done' | 'error'
  phase: string | null
  document_id: string | null
  file_name: string | null
  error: string | null
  seen: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

const JOB_COLS = 'id, property_id, tenant_name, kind, status, phase, document_id, file_name, error, seen, created_by, created_at, updated_at'

// Create a running job row and return its id. Best-effort: a failure to record
// the job must NOT abort the actual pipeline, so callers treat a null id as
// "run without tracking".
export async function createAbstractJob(args: {
  propertyId: string | null
  tenant: string
  kind?: AbstractJob['kind']
  fileName?: string | null
  createdBy?: string | null
}): Promise<string | null> {
  const { data, error } = await supabase.from('abstract_jobs').insert({
    property_id: args.propertyId,
    tenant_name: args.tenant,
    kind: args.kind ?? 'upload_reabstract',
    status: 'running',
    phase: 'starting…',
    file_name: args.fileName ?? null,
    created_by: args.createdBy ?? null,
  }).select('id').single()
  if (error) { console.warn('[abstract-jobs] create failed:', error.message); return null }
  return data?.id ?? null
}

export async function updateAbstractJob(id: string | null, patch: Partial<AbstractJob>): Promise<void> {
  if (!id) return
  const { error } = await supabase.from('abstract_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) console.warn('[abstract-jobs] update failed:', error.message)
}

// Mark a finished job's completion notice acknowledged (dismissed from the toaster).
export async function acknowledgeAbstractJob(id: string): Promise<void> {
  const { error } = await supabase.from('abstract_jobs')
    .update({ seen: true, updated_at: new Date().toISOString() }).eq('id', id)
  if (error) console.warn('[abstract-jobs] ack failed:', error.message)
}

// Poll this user's active + unacknowledged jobs. Polling (not Realtime) keeps
// this dependency-free and matches the app's other live surfaces; the interval
// backs off to a slow heartbeat when nothing is in flight.
export function useAbstractJobs(userId: string | null | undefined) {
  const [jobs, setJobs] = useState<AbstractJob[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stopped = useRef(false)

  const fetchOnce = useCallback(async () => {
    if (!userId) { setJobs([]); return [] as AbstractJob[] }
    // Running jobs, plus finished ones the reviewer hasn't acknowledged yet.
    const { data, error } = await supabase.from('abstract_jobs')
      .select(JOB_COLS)
      .eq('created_by', userId)
      .or('status.eq.running,seen.eq.false')
      .order('updated_at', { ascending: false })
      .limit(20)
    if (error) { console.warn('[abstract-jobs] poll failed:', error.message); return [] as AbstractJob[] }
    const rows = (data ?? []) as AbstractJob[]
    setJobs(rows)
    return rows
  }, [userId])

  useEffect(() => {
    stopped.current = false
    const loop = async () => {
      const rows = await fetchOnce()
      if (stopped.current) return
      // Fast poll while work is in flight; slow heartbeat otherwise.
      const anyRunning = rows.some(j => j.status === 'running')
      timer.current = setTimeout(loop, anyRunning ? 3500 : 15000)
    }
    loop()
    return () => { stopped.current = true; if (timer.current) clearTimeout(timer.current) }
  }, [fetchOnce])

  const dismiss = useCallback(async (id: string) => {
    setJobs(js => js.filter(j => j.id !== id))
    await acknowledgeAbstractJob(id)
  }, [])

  return { jobs, dismiss, refetch: fetchOnce }
}
