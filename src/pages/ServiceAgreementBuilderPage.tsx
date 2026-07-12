import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useProperties } from '../hooks/useProperties'
import { logGeneratedAgreement, useGeneratedAgreements } from '../hooks/useGeneratedAgreements'
import { supabase } from '../lib/supabase'
import {
  blankInput, buildContentBase, PROPERTY_CONFIGS,
  type AgreementInput, type PropertyKey,
} from '../reports/serviceAgreement/config'

// ── M&J Wilkow corporate palette (see ServiceAgreementsPage) ─────────────────
const WILKOW = '#466371'
const WILKOW_MIST = '#8fa2ad'
const SERIF = "'Frank Ruhl Libre', 'Cinzel', Georgia, serif"

const PROPERTY_KEYS: PropertyKey[] = ['KME', 'KMW']

// Resolve the properties-table row for tracking (fuzzy: fka / dba tokens).
function matchPropertyId(props: { id: string; name: string }[] | null, key: PropertyKey): string | null {
  if (!props) return null
  const cfg = PROPERTY_CONFIGS[key]
  const needles = [cfg.propertiesFka, cfg.dba, key === 'KME' ? 'East' : 'West']
  const hit = props.find(p => needles.some(n => p.name?.toLowerCase().includes(n.toLowerCase())))
  return hit?.id ?? null
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(...buf.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// ── small styled field primitives ────────────────────────────────────────────
const labelStyle: CSSProperties = { display: 'block', fontSize: 11, fontWeight: 600, color: WILKOW, letterSpacing: 0.3, marginBottom: 5 }
const inputStyle: CSSProperties = {
  width: '100%', padding: '9px 11px', fontSize: 13, borderRadius: 7,
  border: '1px solid var(--border-2)', background: 'var(--surface)', color: 'var(--text)',
  boxSizing: 'border-box',
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={labelStyle}>{label}{hint ? <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}> · {hint}</span> : null}</label>
      {children}
    </div>
  )
}

function Text({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input style={inputStyle} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} />
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ border: '1px solid var(--border-2)', borderRadius: 12, background: 'var(--surface)', padding: 18, marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 14px', fontSize: 12, letterSpacing: 1.4, textTransform: 'uppercase', color: WILKOW_MIST, fontWeight: 700 }}>{title}</h3>
      {children}
    </section>
  )
}

export function ServiceAgreementBuilderPage() {
  const { data: properties } = useProperties()
  const [input, setInput] = useState<AgreementInput>(() => blankInput('KME'))
  const [exhibitA, setExhibitA] = useState<File | null>(null)
  const recent = useGeneratedAgreements()

  const [busy, setBusy] = useState<null | 'word' | 'pdf' | 'email'>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const cfg = PROPERTY_CONFIGS[input.property]
  const set = (patch: Partial<AgreementInput>) => setInput(prev => ({ ...prev, ...patch }))
  const setAddr = (i: number, v: string) =>
    setInput(prev => { const a = [...prev.vendorAddress]; a[i] = v; return { ...prev, vendorAddress: a } })

  const base = useMemo(() => buildContentBase(input), [input])
  const propertyId = useMemo(() => matchPropertyId(properties, input.property), [properties, input.property])

  // ── validation ──
  const errors = useMemo(() => {
    const e: Record<string, string> = {}
    if (!input.vendorName.trim()) e.vendorName = 'Vendor name is required.'
    if (!input.day.trim() || !input.month.trim() || !input.year.trim()) e.date = 'Enter the full agreement date.'
    if (!input.startDate.trim()) e.startDate = 'Enter the commencement date.'
    if (!input.endDate.trim()) e.endDate = input.termType === 'continuing' ? 'Enter the expiration date.' : 'Enter the completion date.'
    return e
  }, [input])
  const emailValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.vendorEmail.trim())
  const canGenerate = Object.keys(errors).length === 0

  async function makePdfBlob(): Promise<Blob> {
    const exBytes = exhibitA ? await exhibitA.arrayBuffer() : undefined
    const { buildAgreementPdf } = await import('../reports/serviceAgreement/renderPdf')
    return buildAgreementPdf(input, exBytes)
  }

  async function onWord() {
    if (busy) return
    setBusy('word'); setMsg(null)
    try {
      const { buildAgreementDocx } = await import('../reports/serviceAgreement/renderDocx')
      const blob = await buildAgreementDocx(input)
      download(blob, `${base.baseFilename}.docx`)
      void logGeneratedAgreement(input, { propertyId, status: 'generated' })
      setMsg({ kind: 'ok', text: 'Word document downloaded.' })
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    } finally { setBusy(null) }
  }

  async function onPdf() {
    if (busy) return
    setBusy('pdf'); setMsg(null)
    try {
      const blob = await makePdfBlob()
      download(blob, `${base.baseFilename}.pdf`)
      void logGeneratedAgreement(input, { propertyId, status: 'generated' })
      setMsg({ kind: 'ok', text: exhibitA ? 'PDF package downloaded (agreement + Exhibit A + Exhibit B).' : 'PDF downloaded (agreement + Exhibit B — no Exhibit A attached).' })
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    } finally { setBusy(null) }
  }

  async function onEmail() {
    if (busy) return
    if (!emailValid) { setMsg({ kind: 'err', text: 'Enter a valid vendor email address first.' }); return }
    setBusy('email'); setMsg(null)
    try {
      const blob = await makePdfBlob()
      const pdfBase64 = await blobToBase64(blob)
      const filename = `${base.baseFilename}.pdf`
      const { data, error } = await supabase.functions.invoke('service-agreement-send', {
        body: {
          to: input.vendorEmail.trim(),
          vendorName: input.vendorName.trim(),
          propertyName: cfg.propertyName,
          filename,
          pdfBase64,
          hasExhibitA: !!exhibitA,
        },
      })
      if (error) throw new Error((data as any)?.error || error.message)
      if ((data as any)?.error) throw new Error((data as any).error)
      void logGeneratedAgreement(input, { propertyId, status: 'sent', sentTo: input.vendorEmail.trim() })
      recent.refetch()
      setMsg({ kind: 'ok', text: `Sent to ${input.vendorEmail.trim()} for signature.` })
    } catch (err) {
      setMsg({ kind: 'err', text: `Email failed: ${err instanceof Error ? err.message : String(err)}` })
    } finally { setBusy(null) }
  }

  return (
    <div style={{ maxWidth: 1120, margin: '0 auto', padding: '24px 28px 120px' }}>
      {/* header */}
      <div style={{ marginBottom: 8 }}>
        <Link to="/services" style={{ fontSize: 12, color: WILKOW_MIST, textDecoration: 'none' }}>← Services</Link>
      </div>
      <div style={{ fontSize: 10, letterSpacing: 2.6, textTransform: 'uppercase', color: WILKOW_MIST, fontWeight: 700 }}>M&J Wilkow · Vendor Contracts</div>
      <h1 style={{ fontFamily: SERIF, color: WILKOW, fontSize: 30, margin: '4px 0 4px' }}>New Service Agreement</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '0 0 20px', maxWidth: 720 }}>
        Fill the blanks on the standard M&J Wilkow Service Agreement, attach the vendor's proposal as Exhibit A,
        and generate an editable Word copy, a send-ready PDF package, or email it to the vendor for signature.
        Exhibit B (insurance requirements) is added automatically.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.35fr) minmax(0, 1fr)', gap: 24, alignItems: 'start' }}>
        {/* ── LEFT: the form ── */}
        <div>
          <Card title="Property">
            <div style={{ display: 'flex', gap: 12 }}>
              {PROPERTY_KEYS.map(k => {
                const c = PROPERTY_CONFIGS[k]
                const active = input.property === k
                return (
                  <button key={k} onClick={() => set({ property: k })} style={{
                    flex: 1, textAlign: 'left', padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
                    border: `1.5px solid ${active ? WILKOW : 'var(--border-2)'}`,
                    background: active ? 'var(--surface-2)' : 'var(--surface)', color: 'var(--text)',
                  }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{k === 'KME' ? 'Knightdale East' : 'Knightdale West'}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>{c.ownerEntity}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{c.propertyName}</div>
                  </button>
                )
              })}
            </div>
            {input.property === 'KME' && (
              <div style={{ marginTop: 12, fontSize: 11.5, color: '#8a5a20', background: '#fbf3e6', border: '1px solid #eBD9b8', borderRadius: 8, padding: '8px 11px' }}>
                Note: the East agreement body names the manager as <b>Series RRR</b> while the East insurance
                Exhibit B says <b>Series SSS</b> — both are reproduced exactly as in the source templates.
              </div>
            )}
          </Card>

          <Card title="Parties & date">
            <Field label="Agreement date" hint='"made this ___ day of ___, ___"'>
              <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 100px', gap: 8 }}>
                <input style={inputStyle} placeholder="22nd" value={input.day} onChange={e => set({ day: e.target.value })} />
                <input style={inputStyle} placeholder="May" value={input.month} onChange={e => set({ month: e.target.value })} />
                <input style={inputStyle} placeholder="2026" value={input.year} onChange={e => set({ year: e.target.value })} />
              </div>
            </Field>
            <Field label="Vendor legal name"><Text value={input.vendorName} onChange={v => set({ vendorName: v })} placeholder="Baker Roofing Company" /></Field>
            <Field label="Vendor's business" hint='"in the business of ___ contracted services"'>
              <Text value={input.vendorBusiness} onChange={v => set({ vendorBusiness: v })} placeholder="Roofing" />
            </Field>
          </Card>

          <Card title="Term">
            <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
              {(['continuing', 'single'] as const).map(tt => (
                <button key={tt} onClick={() => set({ termType: tt })} style={{
                  padding: '7px 13px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  border: `1.5px solid ${input.termType === tt ? WILKOW : 'var(--border-2)'}`,
                  background: input.termType === tt ? WILKOW : 'transparent',
                  color: input.termType === tt ? '#fff' : 'var(--text-muted)',
                }}>
                  {tt === 'continuing' ? 'Continuing services — §3(a)' : 'Single event — §3(b)'}
                </button>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label={input.termType === 'continuing' ? 'Commences on' : 'Anticipated start'}>
                <Text value={input.startDate} onChange={v => set({ startDate: v })} placeholder="July 30, 2026" />
              </Field>
              <Field label={input.termType === 'continuing' ? 'Expires on' : 'Complete on or before'}>
                <Text value={input.endDate} onChange={v => set({ endDate: v })} placeholder={input.termType === 'continuing' ? 'June 30, 2027' : 'August 13, 2026'} />
              </Field>
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-faint)', margin: 0 }}>The other term clause stays blank on the form, exactly as in the paper template.</p>
          </Card>

          <Card title="Vendor notice address (Section 10)">
            {[0, 1, 2, 3].map(i => (
              <input key={i} style={{ ...inputStyle, marginBottom: 8 }} value={input.vendorAddress[i] ?? ''}
                placeholder={i === 0 ? 'Baker Roofing Company' : i === 1 ? '517 Mercury Street' : i === 2 ? 'Raleigh, NC 27603' : ''}
                onChange={e => setAddr(i, e.target.value)} />
            ))}
          </Card>

          <Card title="Signatures">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Owner signatory name"><Text value={input.ownerSignName} onChange={v => set({ ownerSignName: v })} placeholder="(leave blank to sign by hand)" /></Field>
              <Field label="Owner signatory title"><Text value={input.ownerSignTitle} onChange={v => set({ ownerSignTitle: v })} /></Field>
              <Field label="Vendor signatory name"><Text value={input.vendorSignName} onChange={v => set({ vendorSignName: v })} /></Field>
              <Field label="Vendor signatory title"><Text value={input.vendorSignTitle} onChange={v => set({ vendorSignTitle: v })} /></Field>
            </div>
          </Card>

          <Card title="Exhibit A — vendor proposal (PDF)">
            <input type="file" accept="application/pdf" onChange={e => setExhibitA(e.target.files?.[0] ?? null)} style={{ fontSize: 13 }} />
            {exhibitA
              ? <div style={{ fontSize: 12, color: WILKOW, marginTop: 8 }}>Attached: {exhibitA.name} ({Math.round(exhibitA.size / 1024)} KB)</div>
              : <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 8 }}>Optional. If attached, it's inserted between the agreement and Exhibit B in the PDF package.</div>}
          </Card>

          <Card title="Email for signature">
            <Field label="Vendor email">
              <Text value={input.vendorEmail} onChange={v => set({ vendorEmail: v })} placeholder="vendor@example.com" />
            </Field>
            <p style={{ fontSize: 11, color: 'var(--text-faint)', margin: 0 }}>
              Sends the PDF package as an attachment with a short cover note. The vendor signs and returns it.
            </p>
          </Card>
        </div>

        {/* ── RIGHT: live preview + recent ── */}
        <div style={{ position: 'sticky', top: 16 }}>
          <Card title="Preview">
            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text)' }}>
              <p style={{ margin: '0 0 10px' }}>{base.recitalPreview}</p>
              <p style={{ margin: '0 0 10px' }}><b>Term:</b> {base.termPreview}</p>
              <p style={{ margin: 0 }}><b>Owner:</b> {cfg.ownerEntity}<br /><b>Vendor:</b> {input.vendorName || '—'}</p>
            </div>
          </Card>

          {recent.data && recent.data.length > 0 && (
            <Card title="Recently generated">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {recent.data.slice(0, 6).map(r => (
                  <div key={r.id} style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ color: 'var(--text)' }}>{r.vendor_name} <span style={{ color: 'var(--text-faint)' }}>· {r.property_key}</span></span>
                    <span style={{ color: r.status === 'sent' ? WILKOW : 'var(--text-faint)', whiteSpace: 'nowrap' }}>{r.status === 'sent' ? '✉ sent' : 'draft'}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* ── sticky action bar ── */}
      <div style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 20,
        background: 'var(--surface)', borderTop: '1px solid var(--border-2)', padding: '12px 28px',
        display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'flex-end',
      }}>
        {msg && (
          <div style={{ marginRight: 'auto', fontSize: 12.5, color: msg.kind === 'ok' ? '#2f7a4d' : '#c25b52', maxWidth: 620 }}>{msg.text}</div>
        )}
        {!canGenerate && <div style={{ marginRight: msg ? 12 : 'auto', fontSize: 12, color: 'var(--text-faint)' }}>{Object.values(errors)[0]}</div>}
        <button onClick={onWord} disabled={!canGenerate || !!busy} style={actionBtn(false, !canGenerate || !!busy)}>
          {busy === 'word' ? 'Building…' : '⬇ Word (.docx)'}
        </button>
        <button onClick={onPdf} disabled={!canGenerate || !!busy} style={actionBtn(false, !canGenerate || !!busy)}>
          {busy === 'pdf' ? 'Building…' : '⬇ PDF package'}
        </button>
        <button onClick={onEmail} disabled={!canGenerate || !emailValid || !!busy} style={actionBtn(true, !canGenerate || !emailValid || !!busy)}>
          {busy === 'email' ? 'Sending…' : '✉ Email vendor'}
        </button>
      </div>
    </div>
  )
}

function actionBtn(primary: boolean, disabled: boolean): CSSProperties {
  return {
    fontSize: 13, fontWeight: 600, padding: '9px 16px', borderRadius: 8, whiteSpace: 'nowrap',
    border: `1px solid ${WILKOW}`,
    background: primary ? WILKOW : 'transparent',
    color: primary ? '#fff' : WILKOW,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  }
}
