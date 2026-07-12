import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import {
  usePipeline, useCapitalPartners, useOmIntake,
  createDeal, updateDeal, deleteDeal, closeDeal,
  addDealLp, updateDealLp, removeDealLp, updateOmRow, extractOm, createDealFromExtraction, uploadOmPdf, generateIcMemo,
  useDealDocuments, uploadDealDocument, removeDealDocument, DEAL_DOC_ROLES, dealDocRoleLabel, type DealDoc,
  useDealComments, addDealComment, updateDealComment, deleteDealComment,
  useDealTeamMembers, type TeamMember,
  createPartner, updatePartner, deletePartner, type PartnerInput,
  openDiligence, unlinkDiligence, sendDocToDiligence,
  pipelineMetrics,
  BOARD_STAGES, ALL_STAGES, STAGE_LABEL, STAGE_HUE, boardColumn, isTerminal, STAGE_PROB,
  RISK_ORDER, RISK_LABEL, RISK_COLOR, ASSET_ORDER, ASSET_LABEL, ASSET_MONO, ASSET_COLOR,
  LP_STATUS_ORDER, LP_STATUS_LABEL, PARTNER_TIER_LABEL,
  type Deal, type Stage, type RiskProfile, type AssetType, type LpStatus,
  type CapitalPartner, type NewDeal, type OmExtraction,
} from '../hooks/usePipeline'
import { useAssignableUsers, indexUsers, userLabel } from '../hooks/useTasks'
import { WidgetSkeleton } from '../components/ui/Widget'
import { EmptyState } from '../components/ui/EmptyState'
import { PdfDownloadButton, sanitizeFilename } from '../reports/PdfDownloadButton'

// /pipeline — acquisition deal pipeline (v2). Four views: Pipeline (board/table),
// Analytics (funnel · investment-profile matrix · geo · partners), OM Intake
// (upload/extract + tracking), Partners (LP mandate book). Design mirrors the
// firm's Deal Tracking Sheet.

const MIST = '#8fa2ad'
const SERIF = "'Frank Ruhl Libre', 'Cinzel', Georgia, serif"

const fmt$ = (n: number) => '$' + Math.round(n).toLocaleString('en-US')
const fmtM = (n: number | null): string =>
  n == null ? '—' : n >= 1e6 ? '$' + (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M' : fmt$(n)
const fmtSF = (n: number | null) => (n == null ? '—' : Math.round(n).toLocaleString('en-US') + ' SF')
const pct = (d: number | null, dp = 1) => (d == null ? '—' : (d * 100).toFixed(dp) + '%')
const initials = (t: string) =>
  (t.length <= 3 && t === t.toUpperCase()) ? t : t.split(/[\s/]+/).map(x => x[0]).join('').slice(0, 2).toUpperCase()
const priceLabel = (d: Deal) => (d.askPrice != null ? fmtM(d.askPrice) : (d.priceText || '—'))
function relTime(iso: string): string {
  const then = new Date(iso).getTime(); const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24); if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function PipelinePage() {
  const { appUser } = useAuth()
  const { data, loading, error, refetch } = usePipeline()
  const partnersQ = useCapitalPartners()
  const teamQ = useDealTeamMembers()
  const omQ = useOmIntake()
  const deals = data ?? []

  const [view, setView] = useState<'pipeline' | 'analytics' | 'om' | 'partners'>('pipeline')
  const [assetFilter, setAssetFilter] = useState<'' | AssetType>('')
  const [riskFilter, setRiskFilter] = useState<'' | RiskProfile>('')
  const [boardMode, setBoardMode] = useState<'board' | 'table'>('board')
  const [openId, setOpenId] = useState<string | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)

  const visible = deals.filter(d =>
    (!assetFilter || d.assetType === assetFilter) && (!riskFilter || d.riskProfile === riskFilter))
  const metrics = useMemo(() => pipelineMetrics(visible), [visible])
  const openDeal = deals.find(d => d.id === openId) ?? null

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
        <div>
          <div style={kicker}>Acquisitions</div>
          <h1 style={{ fontFamily: SERIF, fontSize: 25, fontWeight: 700, color: 'var(--text)', margin: '2px 0 0' }}>Deal Pipeline</h1>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
            Retail, office &amp; mixed-use acquisitions from OM to close — investment-profile analytics, the LP mandate book, and AI OM intake.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <MeetingDeckButton deals={deals} preparedBy={appUser?.full_name || appUser?.email || 'M&J Wilkow'} />
          <button style={primaryBtn} onClick={() => setComposerOpen(true)}>+ New deal</button>
        </div>
      </div>

      {loading && <WidgetSkeleton />}
      {error && <div style={{ color: 'var(--red)', fontSize: 13 }}>{error}</div>}

      {!loading && !error && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))', gap: 10, marginBottom: 16 }}>
            <Kpi label="Active deals" value={String(metrics.activeCount)} sub="sourced → under contract" />
            <Kpi label="Active volume" value={fmtM(metrics.activeVolume)} sub={`${Math.round(metrics.activeSf / 1000)}k SF in play`} />
            <Kpi label="Weighted pipeline" value={fmtM(metrics.weighted)} sub="gross × close probability" accent />
            <Kpi label="Closed" value={fmtM(metrics.closedVolume)} sub={`${metrics.closedCount} transactions`} />
          </div>

          <div style={{ display: 'flex', gap: 3, borderBottom: '1px solid var(--border)', marginBottom: 16, flexWrap: 'wrap' }}>
            {([['pipeline', 'Pipeline'], ['analytics', 'Analytics'], ['om', 'OM Intake'], ['partners', 'Partners']] as const).map(([k, lab]) => (
              <button key={k} onClick={() => setView(k)}
                style={{ ...navBtn, color: view === k ? 'var(--text)' : 'var(--text-faint)', borderBottomColor: view === k ? 'var(--accent, #466371)' : 'transparent' }}>
                {lab}
              </button>
            ))}
          </div>

          {view === 'pipeline' && (
            <PipelineView deals={visible} totalCount={deals.length}
              boardMode={boardMode} setBoardMode={setBoardMode}
              assetFilter={assetFilter} setAssetFilter={setAssetFilter}
              riskFilter={riskFilter} setRiskFilter={setRiskFilter} onOpen={setOpenId} />
          )}
          {view === 'analytics' && <AnalyticsView deals={visible} />}
          {view === 'om' && <OmView rows={omQ.data ?? []} createdBy={appUser?.id ?? null}
            onChanged={() => { omQ.refetch(); refetch() }} onOpen={setOpenId} />}
          {view === 'partners' && <PartnersView partners={partnersQ.data ?? []} onChanged={partnersQ.refetch} />}
        </>
      )}

      {openDeal && (
        <DealDrawer deal={openDeal} partners={partnersQ.data ?? []} team={teamQ.data ?? []}
          onClose={() => setOpenId(null)} onChanged={refetch} />
      )}
      {composerOpen && (
        <Composer createdBy={appUser?.id ?? null} team={teamQ.data ?? []}
          onClose={() => setComposerOpen(false)} onCreated={() => { setComposerOpen(false); refetch() }} />
      )}
    </div>
  )
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div style={{ border: `1px solid ${accent ? 'var(--accent, #466371)' : 'var(--border)'}`, borderRadius: 10, background: 'var(--surface)', padding: '12px 14px' }}>
      <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{label}</div>
      <div style={{ fontFamily: SERIF, fontSize: 23, fontWeight: 700, color: accent ? 'var(--accent, #466371)' : 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  )
}

// ── PIPELINE VIEW ─────────────────────────────────────────────────────────────
function PipelineView(p: {
  deals: Deal[]; totalCount: number; boardMode: 'board' | 'table'; setBoardMode: (m: 'board' | 'table') => void
  assetFilter: '' | AssetType; setAssetFilter: (a: '' | AssetType) => void
  riskFilter: '' | RiskProfile; setRiskFilter: (r: '' | RiskProfile) => void; onOpen: (id: string) => void
}) {
  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', border: '1px solid var(--border-2)', borderRadius: 6, overflow: 'hidden' }}>
          {(['board', 'table'] as const).map(m => (
            <button key={m} onClick={() => p.setBoardMode(m)}
              style={{ ...segBtn, background: p.boardMode === m ? 'var(--accent, #466371)' : 'var(--surface)', color: p.boardMode === m ? '#fff' : 'var(--text-muted)' }}>
              {m === 'board' ? 'Board' : 'Table'}
            </button>
          ))}
        </div>
        <select value={p.assetFilter} onChange={e => p.setAssetFilter(e.target.value as any)} style={selectStyle}>
          <option value="">All asset types</option>
          {ASSET_ORDER.map(a => <option key={a} value={a}>{ASSET_LABEL[a]}</option>)}
        </select>
        <select value={p.riskFilter} onChange={e => p.setRiskFilter(e.target.value as any)} style={selectStyle}>
          <option value="">All profiles</option>
          {RISK_ORDER.map(r => <option key={r} value={r}>{RISK_LABEL[r]}</option>)}
        </select>
        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-faint)' }}>{p.deals.length} deals</span>
      </div>

      {p.deals.length === 0 ? (
        <EmptyState icon="📈" title="No deals match these filters." />
      ) : p.boardMode === 'board' ? (
        <>
          <Board deals={p.deals} onOpen={p.onOpen} />
          <Watchlist deals={p.deals.filter(d => d.stage === 'tracking')} onOpen={p.onOpen} />
        </>
      ) : (
        <Table deals={p.deals} onOpen={p.onOpen} />
      )}
    </>
  )
}

function Watchlist({ deals, onOpen }: { deals: Deal[]; onOpen: (id: string) => void }) {
  if (!deals.length) return null
  return (
    <details style={{ marginTop: 16, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)' }}>
      <summary style={{ cursor: 'pointer', padding: '10px 14px', fontSize: 12.5, fontWeight: 700, color: 'var(--text-muted)' }}>
        Watchlist ({deals.length}) <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>— tracked for future reference, not actively pursued</span>
      </summary>
      <div style={{ padding: '0 10px 10px' }}><Table deals={deals} onOpen={onOpen} /></div>
    </details>
  )
}

function Board({ deals, onOpen }: { deals: Deal[]; onOpen: (id: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 10 }}>
      {BOARD_STAGES.map(col => {
        const inCol = deals.filter(d => boardColumn(d.stage) === col)
        const vol = inCol.reduce((a, d) => a + (d.askPrice ?? 0), 0)
        return (
          <div key={col} style={{ minWidth: 244, flex: '0 0 244px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 3px 9px' }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: STAGE_HUE[col] }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)' }}>{STAGE_LABEL[col]}</span>
              <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{inCol.length}</span>
              <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--text-muted)' }}>{vol > 0 ? fmtM(vol) : ''}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {inCol.map(d => <DealCard key={d.id} d={d} onOpen={onOpen} />)}
              {inCol.length === 0 && <div style={{ fontSize: 11, color: 'var(--text-faint)', padding: '8px 3px' }}>—</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function DealCard({ d, onOpen }: { d: Deal; onOpen: (id: string) => void }) {
  const committed = d.lps.reduce((a, l) => a + (l.committedAmount ?? 0), 0)
  const raise = d.equityRequired ? Math.min(1, committed / d.equityRequired) : 0
  return (
    <button onClick={() => onOpen(d.id)} style={{ ...cardStyle, borderLeft: `3px solid ${RISK_COLOR[d.riskProfile]}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
        <span style={{ ...mono, background: ASSET_COLOR[d.assetType] }}>{ASSET_MONO[d.assetType]}</span>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', color: RISK_COLOR[d.riskProfile] }}>{RISK_LABEL[d.riskProfile]}</span>
        <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 700, color: 'var(--text-faint)' }}>{d.stage === 'closed' ? '✓' : Math.round((STAGE_PROB[d.stage] ?? d.probability) * 100) + '%'}</span>
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', lineHeight: 1.25, textAlign: 'left' }}>{d.name}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1, textAlign: 'left' }}>
        {[d.city && `${d.city}, ${d.state ?? ''}`.trim(), d.submarket, d.glaSf ? `${Math.round(d.glaSf / 1000)}k SF` : null].filter(Boolean).join(' · ') || '—'}
      </div>
      <div style={{ display: 'flex', gap: 11, marginTop: 7, fontSize: 11, color: 'var(--text-muted)', textAlign: 'left', flexWrap: 'wrap' }}>
        <span>{d.stage === 'closed' ? 'Price' : 'Guidance'} <b style={{ color: 'var(--text)' }}>{priceLabel(d)}</b></span>
        {d.goingInCap != null && <span>Cap <b style={{ color: 'var(--text)' }}>{pct(d.goingInCap)}</b></span>}
      </div>
      {d.bidText && <div style={chipFlag}>{d.bidText}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 8 }}>
        {d.partner
          ? <span style={ppill}>{d.partner}</span>
          : <span style={{ ...ppill, color: 'var(--text-faint)', background: 'var(--surface-2, rgba(0,0,0,.05))' }}>No LP yet</span>}
        {d.leadInitials && <span style={{ fontSize: 9.5, color: 'var(--text-faint)' }} title={`Acquisition lead: ${d.leadName ?? d.leadInitials}`}>Lead {d.leadInitials}</span>}
        <span style={{ marginLeft: 'auto', display: 'flex' }}>
          {d.team.slice(0, 3).map((t, i) => <span key={i} style={{ ...avatar, marginLeft: i ? -6 : 0 }} title={t}>{initials(t)}</span>)}
        </span>
      </div>
      {d.equityRequired != null && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-faint)' }}>
            <span>Raise {fmtM(committed)} / {fmtM(d.equityRequired)}</span><span>{Math.round(raise * 100)}%</span>
          </div>
          <div style={{ height: 4, borderRadius: 2, background: 'var(--border)', marginTop: 2, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${raise * 100}%`, background: RISK_COLOR.core }} />
          </div>
        </div>
      )}
    </button>
  )
}

function Table({ deals, onOpen }: { deals: Deal[]; onOpen: (id: string) => void }) {
  const sorted = [...deals].sort((a, b) => ALL_STAGES.indexOf(a.stage) - ALL_STAGES.indexOf(b.stage) || (b.askPrice ?? 0) - (a.askPrice ?? 0))
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead><tr>{['Deal', 'Team', 'Profile', 'Sub', 'Stage', 'City', 'Guidance', 'SF', 'Partner'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>
          {sorted.map(d => (
            <tr key={d.id} onClick={() => onOpen(d.id)} style={{ cursor: 'pointer' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-2, rgba(0,0,0,0.03))')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <td style={{ ...td, fontWeight: 700, color: 'var(--text)' }}>{d.name}</td>
              <td style={td}>{d.team.map(initials).join(', ')}</td>
              <td style={td}><span style={{ color: RISK_COLOR[d.riskProfile], fontWeight: 700 }}>{RISK_LABEL[d.riskProfile]}</span> {ASSET_LABEL[d.assetType]}</td>
              <td style={td}>{d.submarket ?? '—'}</td>
              <td style={td}><span style={{ ...miniStage, borderColor: STAGE_HUE[d.stage], color: STAGE_HUE[d.stage] }}>{STAGE_LABEL[d.stage]}</span></td>
              <td style={td}>{d.city ? `${d.city}, ${d.state ?? ''}` : '—'}</td>
              <td style={tdNum}>{priceLabel(d)}</td>
              <td style={tdNum}>{d.glaSf ? Math.round(d.glaSf / 1000) + 'k' : '—'}</td>
              <td style={td}>{d.partner ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── ANALYTICS VIEW ────────────────────────────────────────────────────────────
function AnalyticsView({ deals: allDeals }: { deals: Deal[] }) {
  // Analytics reflect the active book — the watchlist is excluded.
  const deals = allDeals.filter(d => d.stage !== 'tracking')
  return (
    <>
      <div style={grid2}>
        <Panel title="Pipeline funnel" cap="Deals and gross volume at each stage.">
          <Funnel deals={deals} />
        </Panel>
        <Panel title="Capital raised" cap="Committed vs. soft-circled vs. remaining, across active raises.">
          <Donut deals={deals} />
        </Panel>
      </div>
      <div style={{ ...grid2, marginTop: 14 }}>
        <Panel title="Investment-profile matrix" cap="Gross volume by risk profile × asset type.">
          <Matrix deals={deals} />
        </Panel>
        <Panel title="Geographic exposure" cap="Gross volume by state.">
          <Bars rows={geoRows(deals)} color="var(--accent, #466371)" />
        </Panel>
      </div>
      <div style={{ ...grid2, marginTop: 14 }}>
        <Panel title="Volume by LP partner" cap="Gross deal volume attributed to each capital partner.">
          <Bars rows={partnerRows(deals)} color={RISK_COLOR.core_plus} empty="No partner-attributed volume in this filter." />
        </Panel>
        <Panel title="Deal-team load" cap="Active deals each team member is carrying.">
          <Bars rows={teamRows(deals)} color={RISK_COLOR.value_add} isCount />
        </Panel>
      </div>
    </>
  )
}

function Panel({ title, cap, children }: { title: string; cap?: string; children: ReactNode }) {
  return (
    <div style={{ border: '1px solid var(--border)', background: 'var(--surface)', borderRadius: 12, padding: '16px 17px' }}>
      <div style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>{title}</div>
      {cap && <div style={{ fontSize: 11, color: 'var(--text-faint)', margin: '2px 0 13px' }}>{cap}</div>}
      {children}
    </div>
  )
}

function Funnel({ deals }: { deals: Deal[] }) {
  const rows = BOARD_STAGES.map(s => {
    const inS = deals.filter(d => boardColumn(d.stage) === s)
    return { s, n: inS.length, v: inS.reduce((a, d) => a + (d.askPrice ?? 0), 0) }
  })
  const max = Math.max(1, ...rows.map(r => r.v || r.n * 1e7))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {rows.map(r => {
        const w = Math.max(6, ((r.v || r.n * 1e7) / max) * 100)
        return (
          <div key={r.s} style={{ display: 'grid', gridTemplateColumns: '108px 1fr', alignItems: 'center', gap: 11 }}>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', textAlign: 'right' }}>{STAGE_LABEL[r.s]}</div>
            <div style={{ position: 'relative', height: 34, borderRadius: 6, background: 'var(--surface-2, rgba(0,0,0,.05))', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', inset: 0, width: `${w}%`, background: STAGE_HUE[r.s] }} />
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 11px' }}>
                <span style={{ fontFamily: SERIF, fontWeight: 700, color: '#fff', fontSize: 15 }}>{r.n}</span>
                <span style={{ color: 'rgba(255,255,255,.85)', fontSize: 11.5, fontVariantNumeric: 'tabular-nums' }}>{r.v > 0 ? fmtM(r.v) : '—'}</span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Matrix({ deals }: { deals: Deal[] }) {
  const cell: Record<string, { n: number; v: number }> = {}
  for (const a of ASSET_ORDER) for (const r of RISK_ORDER) cell[a + r] = { n: 0, v: 0 }
  for (const d of deals) { const k = d.assetType + d.riskProfile; if (cell[k]) { cell[k].n++; cell[k].v += d.askPrice ?? 0 } }
  const max = Math.max(1, ...Object.values(cell).map(c => c.v))
  const hex = (c: string, pctv: number) => {
    // blend the risk color toward transparent over the surface
    return c + Math.round(30 + pctv * 190).toString(16).padStart(2, '0')
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '78px repeat(4, 1fr)', gap: 6 }}>
      <div />
      {RISK_ORDER.map(r => <div key={r} style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', color: RISK_COLOR[r], textAlign: 'center', alignSelf: 'center' }}>{RISK_LABEL[r]}</div>)}
      {ASSET_ORDER.map(a => (
        <FragmentRow key={a} a={a} cell={cell} max={max} hex={hex} />
      ))}
    </div>
  )
}
function FragmentRow({ a, cell, max, hex }: { a: AssetType; cell: Record<string, { n: number; v: number }>; max: number; hex: (c: string, p: number) => string }) {
  return (
    <>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)', alignSelf: 'center' }}>{ASSET_LABEL[a]}</div>
      {RISK_ORDER.map(r => {
        const c = cell[a + r]; const intensity = max ? c.v / max : 0
        return (
          <div key={r} style={{ border: '1px solid var(--border)', borderRadius: 8, minHeight: 52, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, background: c.n ? hex(RISK_COLOR[r], intensity) : 'var(--surface)' }}>
            {c.n ? (
              <>
                <span style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 16, color: intensity > 0.5 ? '#fff' : 'var(--text)' }}>{c.n}</span>
                <span style={{ fontSize: 9, color: intensity > 0.5 ? 'rgba(255,255,255,.85)' : 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>{c.v ? fmtM(c.v) : ''}</span>
              </>
            ) : <span style={{ fontSize: 9, color: 'var(--text-faint)' }}>—</span>}
          </div>
        )
      })}
    </>
  )
}

interface BarRow { l: string; v: number }
function geoRows(deals: Deal[]): BarRow[] {
  const by: Record<string, number> = {}
  for (const d of deals) if (d.state) by[d.state] = (by[d.state] ?? 0) + (d.askPrice ?? 0)
  return Object.entries(by).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([l, v]) => ({ l, v }))
}
function partnerRows(deals: Deal[]): BarRow[] {
  const by: Record<string, number> = {}
  for (const d of deals) if (d.partner) by[d.partner] = (by[d.partner] ?? 0) + (d.askPrice ?? 0)
  return Object.entries(by).sort((a, b) => b[1] - a[1]).map(([l, v]) => ({ l, v }))
}
function teamRows(deals: Deal[]): BarRow[] {
  const by: Record<string, number> = {}
  for (const d of deals) { if (isTerminal(d.stage)) continue; for (const t of d.team) { const k = initials(t); by[k] = (by[k] ?? 0) + 1 } }
  return Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 9).map(([l, v]) => ({ l, v }))
}
function Bars({ rows, color, isCount, empty }: { rows: BarRow[]; color: string; isCount?: boolean; empty?: string }) {
  if (!rows.length) return <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{empty ?? 'No data.'}</div>
  const max = Math.max(1, ...rows.map(r => r.v))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {rows.map(r => (
        <div key={r.l} style={{ display: 'grid', gridTemplateColumns: '120px 1fr auto', alignItems: 'center', gap: 10, fontSize: 11.5 }}>
          <div style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.l}</div>
          <div style={{ height: 16, borderRadius: 5, background: 'var(--surface-2, rgba(0,0,0,.05))', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(r.v / max) * 100}%`, background: color, borderRadius: 5 }} />
          </div>
          <div style={{ color: 'var(--text)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{isCount ? r.v : fmtM(r.v)}</div>
        </div>
      ))}
    </div>
  )
}

function Donut({ deals }: { deals: Deal[] }) {
  const active = deals.filter(d => d.equityRequired)
  let equity = 0, comm = 0, soft = 0
  for (const d of active) { equity += d.equityRequired ?? 0; for (const l of d.lps) { comm += l.committedAmount ?? 0; soft += l.softAmount ?? 0 } }
  const gap = Math.max(0, equity - comm - soft)
  const total = Math.max(1, equity)
  const R = 52, C = 2 * Math.PI * R
  const segs = [{ v: comm, c: RISK_COLOR.core }, { v: soft, c: RISK_COLOR.core_plus }, { v: gap, c: 'var(--border-2)' }]
  let acc = 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
      <svg width="140" height="140" viewBox="0 0 140 140" role="img" aria-label="Capital raised">
        <circle r={R} cx="70" cy="70" fill="none" stroke="var(--border)" strokeWidth="20" />
        {segs.map((s, i) => { const frac = s.v / total; const dash = `${frac * C} ${C}`; const off = -acc * C; acc += frac; return <circle key={i} r={R} cx="70" cy="70" fill="none" stroke={s.c} strokeWidth="20" strokeDasharray={dash} strokeDashoffset={off} transform="rotate(-90 70 70)" /> })}
        <text x="70" y="66" textAnchor="middle" fontFamily={SERIF} fontSize="18" fontWeight="700" fill="var(--text)">{fmtM(equity)}</text>
        <text x="70" y="84" textAnchor="middle" fontSize="9" fill="var(--text-faint)">EQUITY TARGET</text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 12 }}>
        <LegendRow c={RISK_COLOR.core} label="Committed" v={fmtM(comm)} />
        <LegendRow c={RISK_COLOR.core_plus} label="Soft-circled" v={fmtM(soft)} />
        <LegendRow c="var(--border-2)" label="Remaining" v={fmtM(gap)} />
        <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 3 }}>Builds on Partner Tracking — per-deal LP commitments.</div>
      </div>
    </div>
  )
}
function LegendRow({ c, label, v }: { c: string; label: string; v: string }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: c }} />{label} <b style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</b></div>
}

// ── OM INTAKE VIEW ────────────────────────────────────────────────────────────
const SAMPLE_OM = `OFFERING MEMORANDUM — One DTC, Denver, Colorado (Denver Tech Center).
Two-building suburban office park totaling 240,931 rentable square feet, built 1982 and renovated 2016, freeway-visible in the DTC submarket. Currently 78% leased. Anchored by an investment-grade tenant occupying 62,000 SF through 2029; top five tenants represent 54% of NRA. Roughly 22% vacancy plus near-term rollover offers a value-add lease-up opportunity, with market NNN rents of $27-29 PSF. In-place NOI of approximately $3.3M (a 6.4% cap on guidance of ~$52M / $216 PSF); pro-forma NOI adds back approximately $0.4M of one-time concessions. Assumable financing: $31M at 4.1%, maturing 2027. Three tenants are currently in holdover. A tax reassessment is expected at sale.`

function OmView({ rows, createdBy, onChanged, onOpen }: { rows: any[]; createdBy: string | null; onChanged: () => void; onOpen: (id: string) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [ex, setEx] = useState<OmExtraction | null>(null)
  const [srcDocId, setSrcDocId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const runText = async (input: string) => {
    setBusy(true); setErr(null); setEx(null); setSrcDocId(null); setPhase('Reading the OM, parsing tenants, computing the in-place cap…')
    try { setEx(await extractOm({ text: input, dealName: 'Offering memorandum' })) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Extraction failed') }
    finally { setBusy(false); setPhase('') }
  }
  const runFile = async (file: File) => {
    if (!/\.pdf$/i.test(file.name)) { setErr('Please choose a PDF offering memorandum.'); return }
    setBusy(true); setErr(null); setEx(null); setSrcDocId(null)
    try {
      setPhase(`Uploading ${file.name}…`)
      const up = await uploadOmPdf(file, createdBy)
      setSrcDocId(up.documentId)
      setPhase('Reading the PDF, parsing the rent roll, computing the in-place cap, drafting key points…')
      setEx(await extractOm({ storagePath: up.storagePath, dealName: up.title.replace(/^OM — /, '') }))
    } catch (e) { setErr(e instanceof Error ? e.message : 'Extraction failed') }
    finally { setBusy(false); setPhase('') }
  }
  const create = async () => {
    if (!ex) return
    setCreating(true)
    try { const id = await createDealFromExtraction(ex, createdBy, { documentId: srcDocId }); onChanged(); onOpen(id) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Create failed') }
    finally { setCreating(false) }
  }

  return (
    <div style={grid2}>
      <Panel title="Upload an OM → extract the deal" cap="Drop a broker's offering memorandum PDF (or paste its text). The om-extract function reads it and pre-fills the deal — you review before it enters the book.">
        <label
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) runFile(f) }}
          style={{ display: 'block', border: `2px dashed ${dragOver ? 'var(--accent, #466371)' : 'var(--border-2)'}`, borderRadius: 12, padding: '22px 16px', textAlign: 'center', background: dragOver ? 'rgba(70,99,113,.06)' : 'var(--surface)', cursor: busy ? 'default' : 'pointer', marginBottom: 10 }}>
          <input type="file" accept="application/pdf,.pdf" disabled={busy} style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) runFile(f); e.currentTarget.value = '' }} />
          <div style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 3 }}>Drop an Offering Memorandum PDF</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>or click to choose · the PDF is filed and read, then you review before it becomes a deal</div>
        </label>
        <details>
          <summary style={{ fontSize: 11.5, color: 'var(--text-muted)', cursor: 'pointer', marginBottom: 6 }}>…or paste OM text instead</summary>
          <textarea value={text} onChange={e => setText(e.target.value)} rows={5} placeholder="Paste OM text here…"
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit', marginBottom: 8 }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={primaryBtn} disabled={busy || (!text.trim())} onClick={() => runText(text)}>{busy ? 'Extracting…' : 'Extract deal'}</button>
            <button style={ghostBtn} disabled={busy} onClick={() => { setText(SAMPLE_OM); runText(SAMPLE_OM) }}>Try a sample OM →</button>
          </div>
        </details>
        {err && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 10 }}>{err}</div>}
        {busy && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>{phase || 'Working…'}</div>}
        {ex && <ExtractResult ex={ex} onCreate={create} creating={creating} />}
      </Panel>

      <Panel title="OM tracking" cap="Your intake checklist — from the OM Tracking tab.">
        <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr>{['Requestor', 'Deal', 'Requested', 'OM', 'Model', 'Broker', 'Taxes'].map(h => <th key={h} style={{ ...th, textAlign: (['OM', 'Model', 'Broker', 'Taxes'].includes(h) ? 'center' : 'left') as any }}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td style={td}>{r.requestor ?? '—'}</td>
                  <td style={{ ...td, fontWeight: 700, color: 'var(--text)' }}>{r.dealName}<div style={{ fontWeight: 400, color: 'var(--text-faint)', fontSize: 11 }}>{[r.city, r.state].filter(Boolean).join(', ')}</div></td>
                  <td style={td}>{r.dateRequested ?? '—'}</td>
                  <td style={tdC}>{chk(r.omReceived)}</td>
                  <td style={tdC}>{chk(r.baseModel)}</td>
                  <td style={tdC}>{chk(r.spokeToBroker)}</td>
                  <td style={tdC}>{chk(r.taxesUpdated)}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td style={td} colSpan={7}>No OM requests tracked yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}
function chk(v: boolean | string) {
  if (v === true) return <span style={{ color: RISK_COLOR.core, fontWeight: 800 }}>✓</span>
  if (v === 'partial') return <span style={{ color: RISK_COLOR.value_add, fontWeight: 700 }}>◐</span>
  if (v === 'complete') return <span style={{ color: RISK_COLOR.core, fontWeight: 800 }}>✓</span>
  return <span style={{ color: 'var(--text-faint)' }}>—</span>
}
function ExtractResult({ ex, onCreate, creating }: { ex: OmExtraction; onCreate: () => void; creating: boolean }) {
  const fct = (l: string, v: ReactNode) => <div><div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{l}</div><div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--accent, #466371)' }}>{v}</div></div>
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)', padding: 15, marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
        <span style={{ ...mono, background: ex.asset_type ? ASSET_COLOR[ex.asset_type] : MIST }}>{ex.asset_type ? ASSET_MONO[ex.asset_type] : '?'}</span>
        <b style={{ fontSize: 15, color: 'var(--text)' }}>{ex.name ?? 'Extracted deal'}</b>
        {ex.risk_profile && <span style={{ marginLeft: 'auto', fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', color: RISK_COLOR[ex.risk_profile] }}>{RISK_LABEL[ex.risk_profile]} · {ex.asset_type ? ASSET_LABEL[ex.asset_type] : ''}</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12 }}>
        {fct('Location', [ex.city, ex.state].filter(Boolean).join(', ') || '—')}
        {fct('Submarket', ex.submarket ?? '—')}
        {fct('Size', ex.gla_sf ? Math.round(ex.gla_sf).toLocaleString() + ' SF' : '—')}
        {fct('Occupancy', ex.occupancy != null ? pct(ex.occupancy, 0) : '—')}
        {fct('Guidance', ex.asking_price != null ? fmtM(ex.asking_price) : (ex.asking_guidance_text ?? '—'))}
        {fct('In-place cap', ex.in_place_cap != null ? pct(ex.in_place_cap) : '—')}
      </div>
      {!!(ex.key_points ?? []).length && (
        <div style={{ marginTop: 12 }}>
          <div style={fieldLab}>Key points (AI draft)</div>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            {(ex.key_points ?? []).map((k, i) => <li key={i}>{k}</li>)}
          </ul>
        </div>
      )}
      {!!(ex.open_questions ?? []).length && (
        <div style={{ marginTop: 12 }}>
          <div style={fieldLab}>Open questions — needs verification</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
            {(ex.open_questions ?? []).map((q, i) => (
              <div key={i} style={{ fontSize: 12, color: 'var(--text)', background: 'var(--surface-2, rgba(0,0,0,.04))', borderLeft: `3px solid ${RISK_COLOR.value_add}`, borderRadius: '0 6px 6px 0', padding: '6px 10px' }}>{q}</div>
            ))}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 15 }}>
        <button style={primaryBtn} disabled={creating} onClick={onCreate}>{creating ? 'Creating…' : 'Create deal from OM →'}</button>
      </div>
    </div>
  )
}

// ── PARTNERS VIEW ─────────────────────────────────────────────────────────────
function PartnersView({ partners, onChanged }: { partners: CapitalPartner[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<CapitalPartner | 'new' | null>(null)
  const groups: [string, CapitalPartner[]][] = [
    ['Current partners', partners.filter(p => p.tier === 'current')],
    ['Tier 1 prospects', partners.filter(p => p.tier === 'tier1_prospect')],
    ['Tier 2 prospects', partners.filter(p => p.tier === 'tier2_prospect')],
  ]
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '-4px 0 12px' }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>The LP mandate book from Partner Tracking — used to match live deals to the right capital.</div>
        <button style={{ ...primaryBtn, marginLeft: 'auto' }} onClick={() => setEditing('new')}>+ Add partner</button>
      </div>
      {groups.filter(([, list]) => list.length).map(([label, list]) => (
        <div key={label} style={{ marginBottom: 20 }}>
          <div style={{ ...kicker, marginBottom: 10 }}>{label}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 13 }}>
            {list.map(p => <PartnerCard key={p.id} p={p} onEdit={() => setEditing(p)} />)}
          </div>
        </div>
      ))}
      {editing && (
        <PartnerModal partner={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onChanged() }} />
      )}
    </>
  )
}

function PartnerModal({ partner, onClose, onSaved }: { partner: CapitalPartner | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<PartnerInput>(() => partner ? {
    name: partner.name, tier: partner.tier, productTypes: partner.productTypes,
    markets: partner.markets, returnTarget: partner.returnTarget, leverage: partner.leverage,
    dealSize: partner.dealSize, preferredHold: partner.preferredHold, feeStructure: partner.feeStructure,
    relationshipManager: partner.relationshipManager, primaryContact: partner.primaryContact,
    notes: partner.notes, active: partner.active,
  } : { name: '', tier: 'tier1_prospect', productTypes: ['retail'], active: true })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (p: Partial<PartnerInput>) => setF(s => ({ ...s, ...p }))
  const toggleProduct = (a: string) => set({ productTypes: f.productTypes.includes(a) ? f.productTypes.filter(x => x !== a) : [...f.productTypes, a] })

  const save = async () => {
    if (!f.name.trim()) { setErr('Partner needs a name.'); return }
    setBusy(true); setErr(null)
    try { if (partner) { await updatePartner(partner.id, f) } else { await createPartner(f) } onSaved() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Save failed') }
    finally { setBusy(false) }
  }
  const remove = async () => {
    if (!partner) return
    if (!confirm(`Delete "${partner.name}"? This also removes them from every deal's LP funnel.`)) return
    setBusy(true); setErr(null)
    try { await deletePartner(partner.id); onSaved() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Delete failed') }
    finally { setBusy(false) }
  }

  return (
    <Overlay onClose={busy ? () => {} : onClose}>
      <div style={modal} onClick={e => e.stopPropagation()}>
        <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 12 }}>
          {partner ? `Edit ${partner.name}` : 'Add capital partner'}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <Field label="Name *" flex><input autoFocus value={f.name} onChange={e => set({ name: e.target.value })} style={inputStyle} /></Field>
            <Field label="Tier" flex>
              <select value={f.tier} onChange={e => set({ tier: e.target.value as PartnerInput['tier'] })} style={inputStyle}>
                <option value="current">Current partner</option>
                <option value="tier1_prospect">Tier 1 prospect</option>
                <option value="tier2_prospect">Tier 2 prospect</option>
              </select>
            </Field>
          </div>
          <Field label="Product types">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {ASSET_ORDER.concat(['industrial'] as AssetType[]).map(a => {
                const on = f.productTypes.includes(a)
                return (
                  <button key={a} type="button" onClick={() => toggleProduct(a)}
                    style={{ fontSize: 11.5, fontWeight: 600, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
                      border: `1px solid ${on ? ASSET_COLOR[a] : 'var(--border-2)'}`,
                      background: on ? ASSET_COLOR[a] : 'var(--surface)', color: on ? '#fff' : 'var(--text-muted)' }}>
                    {ASSET_LABEL[a]}
                  </button>
                )
              })}
            </div>
          </Field>
          <div style={{ display: 'flex', gap: 10 }}>
            <Field label="Return target" flex><input value={f.returnTarget ?? ''} onChange={e => set({ returnTarget: e.target.value })} style={inputStyle} placeholder="17%+" /></Field>
            <Field label="Leverage" flex><input value={f.leverage ?? ''} onChange={e => set({ leverage: e.target.value })} style={inputStyle} placeholder="50-60%" /></Field>
            <Field label="Preferred hold" flex><input value={f.preferredHold ?? ''} onChange={e => set({ preferredHold: e.target.value })} style={inputStyle} placeholder="3-5 yr" /></Field>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Field label="Deal size" flex><input value={f.dealSize ?? ''} onChange={e => set({ dealSize: e.target.value })} style={inputStyle} placeholder="$20-100M ($7-20M eq)" /></Field>
            <Field label="Markets" flex><input value={f.markets ?? ''} onChange={e => set({ markets: e.target.value })} style={inputStyle} placeholder="Smile states / Top-25" /></Field>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Field label="Relationship manager" flex><input value={f.relationshipManager ?? ''} onChange={e => set({ relationshipManager: e.target.value })} style={inputStyle} placeholder="Marty / Gregg" /></Field>
            <Field label="Primary contact" flex><input value={f.primaryContact ?? ''} onChange={e => set({ primaryContact: e.target.value })} style={inputStyle} placeholder="Jane Doe" /></Field>
          </div>
          <Field label="Fee structure"><input value={f.feeStructure ?? ''} onChange={e => set({ feeStructure: e.target.value })} style={inputStyle} placeholder="90/10, 1% AM fee…" /></Field>
          <Field label="Notes"><textarea rows={2} value={f.notes ?? ''} onChange={e => set({ notes: e.target.value })} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} /></Field>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--text-muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={f.active ?? true} onChange={e => set({ active: e.target.checked })} />
            Active (appears in LP pickers and mandate matching)
          </label>
        </div>
        {err && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          {partner && <button style={{ ...ghostBtn, color: 'var(--red)', borderColor: 'var(--red)' }} disabled={busy} onClick={remove}>Delete</button>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button style={ghostBtn} onClick={onClose} disabled={busy}>Cancel</button>
            <button style={primaryBtn} onClick={save} disabled={busy}>{busy ? 'Saving…' : partner ? 'Save changes' : 'Add partner'}</button>
          </div>
        </div>
      </div>
    </Overlay>
  )
}

function PartnerCard({ p, onEdit }: { p: CapitalPartner; onEdit: () => void }) {
  const kv = (k: string, v: ReactNode) => <div><div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{k}</div><div style={{ fontSize: 12, color: 'var(--text)', fontWeight: 600 }}>{v || '—'}</div></div>
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)', padding: '14px 15px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{p.name}</span>
        <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', borderRadius: 999, padding: '2px 8px', color: p.tier === 'current' ? RISK_COLOR.core : RISK_COLOR.core_plus, background: (p.tier === 'current' ? RISK_COLOR.core : RISK_COLOR.core_plus) + '22' }}>{PARTNER_TIER_LABEL[p.tier]}</span>
        <button style={miniX} title={`Edit ${p.name}`} onClick={onEdit}>✎</button>
      </div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 9 }}>
        {p.productTypes.map(a => <span key={a} style={{ fontSize: 9.5, fontWeight: 700, border: `1px solid ${ASSET_COLOR[a as AssetType] ?? MIST}`, color: ASSET_COLOR[a as AssetType] ?? MIST, borderRadius: 5, padding: '1px 6px' }}>{ASSET_LABEL[a as AssetType] ?? a}</span>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 12px', marginBottom: 9 }}>
        {kv('Return target', p.returnTarget)}{kv('Leverage', p.leverage)}
        {kv('Deal size', p.dealSize)}{kv('Hold', p.preferredHold)}
        {kv('Markets', p.markets)}{kv('Rel. manager', p.relationshipManager)}
        {kv('Contact', p.primaryContact)}{kv('Fee', p.feeStructure)}
      </div>
      {p.notes && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontStyle: 'italic', borderTop: '1px solid var(--border)', paddingTop: 8 }}>{p.notes}</div>}
    </div>
  )
}

// ── DEAL DRAWER ───────────────────────────────────────────────────────────────
function DealDrawer({ deal, partners, team, onClose, onChanged }: { deal: Deal; partners: CapitalPartner[]; team: TeamMember[]; onClose: () => void; onChanged: () => void }) {
  const { appUser } = useAuth()
  const [tab, setTab] = useState<'overview' | 'underwriting' | 'capital' | 'documents' | 'discussion'>('overview')
  const [discussLp, setDiscussLp] = useState<string | null>(null)
  // Lifted so the header can surface the site plan (the acquisition team's
  // favorite artifact) without a second fetch in the Documents tab.
  const docsQ = useDealDocuments(deal.id)
  const sitePlan = (docsQ.data ?? []).find(x => x.role === 'site_plan' && x.signedUrl)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [closeOpen, setCloseOpen] = useState(false)
  const navigate = useNavigate()
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(null); try { await fn(); onChanged() } catch (e) { setErr(e instanceof Error ? e.message : 'Error') } finally { setBusy(false) } }
  // one-click DD: open (or create+link) the deal's diligence workspace
  const goDiligence = async () => {
    setBusy(true); setErr(null)
    try { const ddId = await openDiligence(deal); onChanged(); navigate(`/diligence?deal=${ddId}`) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not open diligence') }
    finally { setBusy(false) }
  }

  return (
    <Overlay onClose={onClose}>
      <div style={drawer} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 11 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
              <span style={{ ...mono, background: ASSET_COLOR[deal.assetType] }}>{ASSET_MONO[deal.assetType]}</span>
              <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', color: RISK_COLOR[deal.riskProfile] }}>{RISK_LABEL[deal.riskProfile]} · {ASSET_LABEL[deal.assetType]}</span>
              {deal.submarket && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{deal.submarket}</span>}
            </div>
            <div style={{ fontFamily: SERIF, fontSize: 21, fontWeight: 700, color: 'var(--text)' }}>{deal.name}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{[deal.city && `${deal.city}, ${deal.state ?? ''}`, fmtSF(deal.glaSf), deal.yearBuilt ? `built ${deal.yearBuilt}` : null].filter(Boolean).join(' · ')}</div>
          </div>
          <button onClick={onClose} style={closeX}>✕</button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 11, color: 'var(--text-faint)' }}>Stage</label>
          <select value={deal.stage} disabled={busy} onChange={e => run(() => updateDeal(deal.id, { stage: e.target.value as Stage }))} style={selectStyle}>
            {ALL_STAGES.map(s => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
          </select>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
              <button style={ghostBtn} disabled={busy} onClick={goDiligence}
                title={deal.ddPropertyId ? "Open this deal's due-diligence workspace" : 'Create a due-diligence workspace for this deal (lease abstraction + QA)'}>
                🔎 Diligence{deal.ddPropertyId ? ' →' : ''}
              </button>
              {deal.ddPropertyId && (
                <button style={{ ...ghostBtn, padding: '4px 8px', fontSize: 11, color: 'var(--text-faint)' }} disabled={busy}
                  onClick={() => run(() => unlinkDiligence(deal.id))}
                  title="Unlink this deal from its diligence workspace (the workspace is preserved)">
                  ✕
                </button>
              )}
            </div>
            {sitePlan && (
              <a href={sitePlan.signedUrl!} target="_blank" rel="noopener noreferrer" style={linkBtn} title={sitePlan.title ?? 'Site plan'}>
                🗺 Site plan
              </a>
            )}
            <InvestmentSummaryButtons deal={deal} preparedBy={appUser?.full_name || appUser?.email || 'M&J Wilkow'} />
            {deal.stage !== 'closed'
              ? <button style={primaryBtn} disabled={busy} onClick={() => setCloseOpen(true)}>Close &amp; hand off →</button>
              : deal.propertyId && <a href={`/properties/${deal.propertyId}`} style={linkBtn}>View asset: {deal.propertyName ?? 'property'} ↗</a>}
          </div>
        </div>
        {err && <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 12, flexWrap: 'wrap' }}>
          {(['overview', 'underwriting', 'capital', 'documents', 'discussion'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{ ...tabBtn, color: tab === t ? 'var(--text)' : 'var(--text-faint)', borderBottomColor: tab === t ? 'var(--accent, #466371)' : 'transparent' }}>
              {t === 'overview' ? 'Overview' : t === 'underwriting' ? 'Underwriting' : t === 'capital' ? `Capital (${deal.lps.length})` : t === 'documents' ? 'Documents' : 'Discussion'}
            </button>
          ))}
        </div>

        {tab === 'overview' && <OverviewTab deal={deal} team={team} onSave={p => run(() => updateDeal(deal.id, p))} busy={busy} onDelete={() => run(async () => { await deleteDeal(deal.id); onClose() })} />}
        {tab === 'underwriting' && <UnderwritingTab deal={deal} onSave={p => run(() => updateDeal(deal.id, p))} busy={busy} />}
        {tab === 'capital' && <CapitalTab deal={deal} partners={partners} onChanged={onChanged} onDiscuss={lpId => { setDiscussLp(lpId); setTab('discussion') }} />}
        {tab === 'documents' && <DocumentsTab dealId={deal.id} createdBy={appUser?.id ?? null} folderPath={deal.folderPath} folderFiles={deal.folderFiles} docs={docsQ.data ?? []} loading={docsQ.loading} refetch={docsQ.refetch} ddPropertyId={deal.ddPropertyId} />}
        {tab === 'discussion' && <DiscussionTab deal={deal} createdBy={appUser?.id ?? null} initialLp={discussLp} />}
      </div>
      {closeOpen && <CloseModal deal={deal} onClose={() => setCloseOpen(false)} onDone={() => { setCloseOpen(false); onChanged() }} />}
    </Overlay>
  )
}

// Weekly meeting deck — ONE editable PowerPoint walking the whole pipeline
// (cover · snapshot · summary table · a discussion slide per deal · watchlist),
// built entirely from the structured tracker (no per-deal AI call, so it's fast
// and complete). Distinct from the per-deal AI Investment Summary below.
function MeetingDeckButton({ deals, preparedBy }: { deals: Deal[]; preparedBy: string }) {
  const today = new Date()
  const meetingDate = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  return (
    <PdfDownloadButton
      label="⬇ Meeting deck"
      busyLabel="Building deck…"
      disabled={deals.length === 0}
      filename={`Wilkow-Pipeline-Review-${today.toISOString().slice(0, 10)}.pptx`}
      title="Generate the weekly acquisitions meeting deck — every deal in the pipeline (editable PowerPoint)"
      build={async () => {
        const { buildPipelineMeetingDeck } = await import('../reports/PipelineMeetingDeck')
        return buildPipelineMeetingDeck({
          deals,
          metrics: pipelineMetrics(deals),
          preparedBy,
          meetingDate,
          generatedAt: today.toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }),
        })
      }}
    />
  )
}

// "Investment Summary" — the firm's IC deliverable, generated from the deal in
// either format: a branded PDF or an EDITABLE PowerPoint modeled on the real
// Investment Summary deck (cover banner, disclaimer, exec summary + property
// table, rationale, tenancy, SWOT, capital & the ask). Both share one
// AI-narrative fetch shape (ic-memo fn).
function InvestmentSummaryButtons({ deal, preparedBy }: { deal: Deal; preparedBy: string }) {
  const buildInput = async () => {
    const memo = await generateIcMemo(deal.id)
    return {
      deal: {
        name: deal.name, assetType: deal.assetType, riskProfile: deal.riskProfile, subType: deal.subType,
        submarket: deal.submarket, city: deal.city, state: deal.state, glaSf: deal.glaSf, yearBuilt: deal.yearBuilt,
        askPrice: deal.askPrice, priceText: deal.priceText, goingInCap: deal.goingInCap, equityRequired: deal.equityRequired,
        totalCapitalization: deal.totalCapitalization, targetCloseDate: deal.targetCloseDate,
        projIrr: deal.projIrr, equityMultiple: deal.equityMultiple, avgCoc: deal.avgCoc, holdYears: deal.holdYears,
        exitCap: deal.exitCap, stabilizedYield: deal.stabilizedYield, thesis: deal.thesis, partner: deal.partner,
        broker: deal.broker, seller: deal.seller, team: deal.team,
        lps: deal.lps.map(l => ({ partnerName: l.partnerName, status: l.status, soft: l.softAmount, committed: l.committedAmount })),
        tenants: memo.major_tenants ?? [],
      },
      memo,
      preparedBy,
      generatedAt: new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }),
    }
  }
  return (
    <>
      <PdfDownloadButton
        label="⬇ Summary (PDF)"
        filename={`Wilkow-InvestmentSummary-${sanitizeFilename(deal.name)}.pdf`}
        title="Generate the Investment Summary as a branded PDF"
        build={async () => {
          const input = await buildInput()
          const { buildIcMemoPdf } = await import('../reports/IcMemoReport')
          return buildIcMemoPdf(input)
        }}
      />
      <PdfDownloadButton
        label="⬇ Summary (PPT)"
        busyLabel="Generating PPT…"
        filename={`Wilkow-InvestmentSummary-${sanitizeFilename(deal.name)}.pptx`}
        title="Generate the Investment Summary as an editable PowerPoint (firm deck format)"
        build={async () => {
          const input = await buildInput()
          const { buildInvestmentSummaryPptx } = await import('../reports/InvestmentSummaryPpt')
          return buildInvestmentSummaryPptx(input)
        }}
      />
    </>
  )
}

function OverviewTab({ deal, team, onSave, busy, onDelete }: { deal: Deal; team: TeamMember[]; onSave: (p: any) => void; busy: boolean; onDelete: () => void }) {
  const [thesis, setThesis] = useState(deal.thesis ?? '')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={facts}>
        <Fact label={deal.stage === 'closed' ? 'Price' : 'Guidance'} value={priceLabel(deal)} />
        <Fact label="Going-in cap" value={pct(deal.goingInCap)} />
        <Fact label="Equity to raise" value={fmtM(deal.equityRequired)} />
        <Fact label="Close prob." value={deal.stage === 'closed' ? 'Closed' : pct(STAGE_PROB[deal.stage] ?? deal.probability, 0)} />
        <Fact label="Source" value={deal.dealSource === 'off_market' ? 'Off-market' : deal.dealSource === 'marketed' ? 'Marketed' : '—'} />
        <Fact label="Broker" value={deal.broker ?? '—'} />
        <Fact label="Seller" value={deal.seller ?? '—'} />
        <Fact label="Bid" value={deal.bidText ?? '—'} />
        <Fact label="Partner" value={deal.partner ?? '—'} />
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <MemberSelect label="Acquisition lead" team={team} value={deal.leadMemberId} onChange={id => onSave({ leadMemberId: id })} />
        <MemberSelect label="Assigned analyst" team={team} value={deal.analystMemberId} onChange={id => onSave({ analystMemberId: id })} />
      </div>
      <Field label="Deal team"><TeamPicker team={team} value={deal.team} onChange={t => onSave({ team: t })} /></Field>
      <Field label="Investment thesis">
        <textarea value={thesis} onChange={e => setThesis(e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} onBlur={() => thesis !== (deal.thesis ?? '') && onSave({ thesis })} />
      </Field>
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        {!isTerminal(deal.stage) && deal.stage !== 'closed' && (['passed', 'dead', 'lost'] as Stage[]).map(s => (
          <button key={s} disabled={busy} style={ghostBtn} onClick={() => onSave({ stage: s })}>Mark {STAGE_LABEL[s]}</button>
        ))}
        <button disabled={busy} style={{ ...ghostBtn, marginLeft: 'auto', color: 'var(--red)', borderColor: 'var(--red)' }}
          onClick={() => { if (confirm(`Delete "${deal.name}" from the pipeline?`)) onDelete() }}>Delete deal</button>
      </div>
    </div>
  )
}

function UnderwritingTab({ deal, onSave, busy }: { deal: Deal; onSave: (p: any) => void; busy: boolean }) {
  const rows: { label: string; kind: 'pct' | 'num' | 'x'; key: keyof Deal; patch: string }[] = [
    { label: 'Projected leveraged IRR', kind: 'pct', key: 'projIrr', patch: 'projIrr' },
    { label: 'Equity multiple', kind: 'x', key: 'equityMultiple', patch: 'equityMultiple' },
    { label: 'Avg cash-on-cash', kind: 'pct', key: 'avgCoc', patch: 'avgCoc' },
    { label: 'Stabilized yield-on-cost', kind: 'pct', key: 'stabilizedYield', patch: 'stabilizedYield' },
    { label: 'Exit cap', kind: 'pct', key: 'exitCap', patch: 'exitCap' },
    { label: 'Hold (years)', kind: 'num', key: 'holdYears', patch: 'holdYears' },
  ]
  return (
    <div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 10 }}>The returns snapshot the IC and LPs see. Enter percentages as whole numbers (16.3 = 16.3%).</div>
      {rows.map(r => <NumRow key={r.patch} label={r.label} kind={r.kind} value={deal[r.key] as number | null} disabled={busy} onSave={v => onSave({ [r.patch]: v })} />)}
    </div>
  )
}
function NumRow({ label, kind, value, disabled, onSave }: { label: string; kind: 'pct' | 'num' | 'x'; value: number | null; disabled: boolean; onSave: (v: number | null) => void }) {
  const display = value == null ? '' : kind === 'pct' ? String(+(value * 100).toFixed(2)) : String(value)
  const [v, setV] = useState(display)
  const commit = () => {
    if (v.trim() === '') { if (value != null) onSave(null); return }
    const n = Number(v); if (!isFinite(n)) return
    const stored = kind === 'pct' ? n / 100 : n
    if (stored !== value) onSave(stored)
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text-muted)' }}>{label}</span>
      <input value={v} disabled={disabled} onChange={e => setV(e.target.value)} onBlur={commit} inputMode="decimal" style={{ ...inputStyle, width: 100, textAlign: 'right' }} />
      <span style={{ width: 14, fontSize: 12, color: 'var(--text-faint)' }}>{kind === 'pct' ? '%' : kind === 'x' ? '×' : ''}</span>
    </div>
  )
}

function CapitalTab({ deal, partners, onChanged, onDiscuss }: { deal: Deal; partners: CapitalPartner[]; onChanged: () => void; onDiscuss: (lpId: string) => void }) {
  const [addId, setAddId] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); onChanged() } finally { setBusy(false) } }
  const onDeal = new Set(deal.lps.map(l => l.partnerId))
  const committed = deal.lps.reduce((a, l) => a + (l.committedAmount ?? 0), 0)
  const soft = deal.lps.reduce((a, l) => a + (l.softAmount ?? 0), 0)
  const gap = (deal.equityRequired ?? 0) - committed - soft
  const matches = partners.filter(p => p.active && p.productTypes.includes(deal.assetType) && !onDeal.has(p.id)).slice(0, 4)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={facts}>
        <Fact label="Equity target" value={fmtM(deal.equityRequired)} />
        <Fact label="Committed" value={fmtM(committed)} tint={RISK_COLOR.core} />
        <Fact label="Soft-circled" value={fmtM(soft)} tint={RISK_COLOR.core_plus} />
        <Fact label="Gap" value={deal.equityRequired ? fmtM(Math.max(0, gap)) : '—'} tint={gap > 0 ? RISK_COLOR.opportunistic : RISK_COLOR.core} />
      </div>
      {deal.lps.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>No LPs on this deal yet.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {deal.lps.map(lp => (
          <div key={lp.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '9px 11px', background: 'var(--surface)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)', flex: 1 }}>{lp.partnerName}</span>
              <select value={lp.status} disabled={busy} style={{ ...selectStyle, fontSize: 11 }} onChange={e => run(() => updateDealLp(lp.id, { status: e.target.value as LpStatus }))}>
                {LP_STATUS_ORDER.map(s => <option key={s} value={s}>{LP_STATUS_LABEL[s]}</option>)}
              </select>
              <button style={miniX} title={`Discuss ${lp.partnerName}`} onClick={() => onDiscuss(lp.id)}>💬</button>
              <button style={miniX} disabled={busy} onClick={() => run(() => removeDealLp(lp.id))}>✕</button>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 7 }}>
              <MoneyInput label="Soft $" value={lp.softAmount} disabled={busy} onSave={v => run(() => updateDealLp(lp.id, { softAmount: v }))} />
              <MoneyInput label="Committed $" value={lp.committedAmount} disabled={busy} onSave={v => run(() => updateDealLp(lp.id, { committedAmount: v }))} />
            </div>
          </div>
        ))}
      </div>
      {matches.length > 0 && (
        <div style={{ border: '1px dashed var(--border-2)', borderRadius: 9, padding: '11px 12px', background: 'var(--surface-2, rgba(0,0,0,.03))' }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: MIST, marginBottom: 7 }}>Suggested LPs — mandate fit</div>
          {matches.map(p => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '4px 0' }}>
              <b style={{ color: 'var(--text)' }}>{p.name}</b>
              <span style={{ marginLeft: 'auto', color: 'var(--text-faint)', fontSize: 11 }}>{[p.returnTarget, p.dealSize].filter(Boolean).join(' · ')}</span>
              <button style={{ ...ghostBtn, padding: '3px 9px', fontSize: 11 }} disabled={busy} onClick={() => run(() => addDealLp(deal.id, p.id))}>Add</button>
            </div>
          ))}
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 6 }}>Matched on product type from the Partner book.</div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <select value={addId} onChange={e => setAddId(e.target.value)} style={{ ...selectStyle, flex: 1 }}>
          <option value="">Add a capital partner…</option>
          {partners.filter(p => p.active && !onDeal.has(p.id)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button style={primaryBtn} disabled={!addId || busy} onClick={() => run(async () => { await addDealLp(deal.id, addId); setAddId('') })}>Add LP</button>
      </div>
    </div>
  )
}
function MoneyInput({ label, value, disabled, onSave }: { label: string; value: number | null; disabled: boolean; onSave: (v: number | null) => void }) {
  const [v, setV] = useState(value == null ? '' : String(value))
  const commit = () => { if (v.trim() === '') { if (value != null) onSave(null); return } const n = Number(v.replace(/[,$]/g, '')); if (isFinite(n) && n !== value) onSave(n) }
  return (
    <label style={{ flex: 1, fontSize: 10, color: 'var(--text-faint)' }}>{label}
      <input value={v} disabled={disabled} onChange={e => setV(e.target.value)} onBlur={commit} inputMode="decimal" placeholder="—" style={{ ...inputStyle, width: '100%', marginTop: 2 }} />
    </label>
  )
}

function DocumentsTab({ dealId, createdBy, folderPath, folderFiles, docs, loading, refetch, ddPropertyId }: { dealId: string; createdBy: string | null; folderPath: string | null; folderFiles: { name: string; dir: boolean }[] | null; docs: DealDoc[]; loading: boolean; refetch: () => void; ddPropertyId: string | null }) {
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [sentIds, setSentIds] = useState<Set<string>>(new Set())
  const sendToDd = async (d: DealDoc) => {
    if (!ddPropertyId || sendingId) return
    setSendingId(d.linkId)
    try { await sendDocToDiligence(d, ddPropertyId); setSentIds(s => new Set(s).add(d.linkId)) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Send to diligence failed') }
    finally { setSendingId(null) }
  }
  const [role, setRole] = useState('rent_roll')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const onFile = async (file: File) => {
    setBusy(true); setErr(null)
    try { await uploadDealDocument(dealId, file, role, createdBy); refetch() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Upload failed') }
    finally { setBusy(false) }
  }
  const remove = async (d: DealDoc) => {
    if (!confirm(`Remove "${d.title ?? d.fileName ?? 'this document'}"?`)) return
    setBusy(true); setErr(null)
    try { await removeDealDocument(d); refetch() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Remove failed') }
    finally { setBusy(false) }
  }
  const groups = DEAL_DOC_ROLES
    .map(r => ({ role: r, items: docs.filter(d => (d.role ?? 'other') === r.key) }))
    .filter(g => g.items.length)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {ddPropertyId && (
        <div style={{ border: '1px solid var(--accent, #466371)', borderRadius: 9, background: 'rgba(70, 99, 113, 0.06)', padding: '10px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--accent, #466371)' }}>🔎 Linked to diligence workspace</span>
            <span style={{ fontSize: 10, color: 'var(--text-faint)', flex: 1 }}>Documents can be sent here for lease abstraction and QA</span>
          </div>
        </div>
      )}
      {folderPath && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 9, background: 'var(--surface-2, rgba(0,0,0,.03))', padding: '10px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Deal folder · network share</span>
            <button style={{ ...ghostBtn, padding: '3px 9px', fontSize: 11, marginLeft: 'auto' }} onClick={() => navigator.clipboard?.writeText(folderPath)}>Copy path</button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace', wordBreak: 'break-all' }}>{folderPath}</div>
          {folderFiles?.length ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {folderFiles.map((f, i) => (
                <span key={i} style={{ fontSize: 11, color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 5, padding: '2px 7px' }}>{f.dir ? '📁' : '📄'} {f.name}</span>
              ))}
            </div>
          ) : null}
          <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 8 }}>Live folder on the network (copy the path to open in Explorer). The files below are mirrored copies — click View to open them from anywhere.</div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', border: '1px solid var(--border)', borderRadius: 9, padding: '10px 12px', background: 'var(--surface)' }}>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>Add a document as</span>
        <select value={role} onChange={e => setRole(e.target.value)} style={selectStyle}>
          {DEAL_DOC_ROLES.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <label style={{ ...primaryBtn, display: 'inline-block', opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Uploading…' : 'Choose file'}
          <input type="file" disabled={busy} style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.currentTarget.value = '' }} />
        </label>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--text-faint)' }}>{docs.length} file{docs.length === 1 ? '' : 's'}</span>
      </div>
      {err && <div style={{ color: 'var(--red)', fontSize: 12 }}>{err}</div>}
      {loading && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</div>}
      {!loading && docs.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>No documents yet. Upload the OM, rent roll, T-12, PSA and diligence materials here as they arrive.</div>
      )}
      {groups.map(g => (
        <div key={g.role.key}>
          <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-faint)', margin: '2px 0 5px' }}>{g.role.label}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {g.items.map(d => (
              <div key={d.linkId} style={{ display: 'flex', alignItems: 'center', gap: 9, border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', background: 'var(--surface)' }}>
                <span style={{ fontSize: 13 }}>📄</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.title ?? d.fileName ?? 'Document'}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{dealDocRoleLabel(d.role)}{d.fileSizeBytes != null ? ` · ${(d.fileSizeBytes / 1024 / 1024).toFixed(1)} MB` : ''} · {new Date(d.createdAt).toLocaleDateString()}</div>
                </div>
                {d.signedUrl && <a href={d.signedUrl} target="_blank" rel="noopener noreferrer" style={{ ...ghostBtn, padding: '4px 10px', fontSize: 11, textDecoration: 'none' }}>View ↗</a>}
                {ddPropertyId && d.signedUrl && (d.fileName ?? '').toLowerCase().endsWith('.pdf') && (
                  <button style={{ ...ghostBtn, padding: '4px 10px', fontSize: 11 }} disabled={sendingId != null || sentIds.has(d.linkId)}
                    title="Send this PDF into the diligence workspace for lease abstraction"
                    onClick={() => sendToDd(d)}>
                    {sentIds.has(d.linkId) ? 'In DD ✓' : sendingId === d.linkId ? 'Sending…' : '→ DD'}
                  </button>
                )}
                <button style={miniX} disabled={busy} onClick={() => remove(d)}>✕</button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function DiscussionTab({ deal, createdBy, initialLp }: { deal: Deal; createdBy: string | null; initialLp: string | null }) {
  const { data, loading, refetch } = useDealComments(deal.id)
  const roster = useAssignableUsers()
  const users = useMemo(() => indexUsers(roster.data), [roster.data])
  const comments = data ?? []
  const [body, setBody] = useState('')
  const [aboutLp, setAboutLp] = useState<string>(initialLp ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editBody, setEditBody] = useState('')
  const lpName = (id: string | null) => deal.lps.find(l => l.id === id)?.partnerName ?? null

  const post = async () => {
    if (!body.trim()) return
    setBusy(true); setErr(null)
    try { await addDealComment(deal.id, body, createdBy, aboutLp || null); setBody(''); refetch() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to post') }
    finally { setBusy(false) }
  }
  const saveEdit = async (id: string) => {
    if (!editBody.trim()) return
    setBusy(true)
    try { await updateDealComment(id, editBody); setEditingId(null); refetch() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to save') }
    finally { setBusy(false) }
  }
  const del = async (id: string) => {
    if (!confirm('Delete this comment?')) return
    setBusy(true)
    try { await deleteDealComment(id); refetch() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to delete') }
    finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {loading && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</div>}
      {!loading && comments.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>No comments yet. Share a thought or update with the team.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {comments.map(c => {
          const mine = c.authorId === createdBy
          const ln = lpName(c.lpId)
          return (
            <div key={c.id} style={{ border: '1px solid var(--border)', borderRadius: 9, background: 'var(--surface)', padding: '9px 11px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ ...avatar, width: 22, height: 22, fontSize: 9 }}>{initials(userLabel(c.authorId, users))}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{userLabel(c.authorId, users)}</span>
                {ln && <span style={ppill}>LP · {ln}</span>}
                <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--text-faint)' }}>{relTime(c.createdAt)}{c.editedAt ? ' · edited' : ''}</span>
              </div>
              {editingId === c.id ? (
                <div>
                  <textarea value={editBody} onChange={e => setEditBody(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 6 }}>
                    <button style={ghostBtn} onClick={() => setEditingId(null)}>Cancel</button>
                    <button style={primaryBtn} disabled={busy} onClick={() => saveEdit(c.id)}>Save</button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{c.body}</div>
                  {mine && (
                    <div style={{ display: 'flex', gap: 12, marginTop: 5 }}>
                      <button style={linkish} onClick={() => { setEditingId(c.id); setEditBody(c.body) }}>Edit</button>
                      <button style={linkish} onClick={() => del(c.id)}>Delete</button>
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
        {deal.lps.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>About</span>
            <select value={aboutLp} onChange={e => setAboutLp(e.target.value)} style={selectStyle}>
              <option value="">The deal (general)</option>
              {deal.lps.map(l => <option key={l.id} value={l.id}>LP · {l.partnerName}</option>)}
            </select>
          </div>
        )}
        <textarea value={body} onChange={e => setBody(e.target.value)} rows={2} placeholder="Share a thought or update…" style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
        {err && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
          <button style={primaryBtn} disabled={busy || !body.trim()} onClick={post}>{busy ? 'Posting…' : 'Post comment'}</button>
        </div>
      </div>
    </div>
  )
}

function CloseModal({ deal, onClose, onDone }: { deal: Deal; onClose: () => void; onDone: () => void }) {
  const [closeDate, setCloseDate] = useState('2026-07-10')
  const [finalPrice, setFinalPrice] = useState(deal.askPrice != null ? String(deal.askPrice) : '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<{ propertyId: string; transactionId: string } | null>(null)
  const submit = async () => {
    setBusy(true); setErr(null)
    try { setResult(await closeDeal(deal.id, { closeDate, finalPrice: finalPrice.trim() ? Number(finalPrice.replace(/[,$]/g, '')) : null })) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Error') } finally { setBusy(false) }
  }
  return (
    <Overlay onClose={busy ? () => {} : onClose}>
      <div style={{ ...modal, maxWidth: 440 }} onClick={e => e.stopPropagation()}>
        {!result ? (
          <>
            <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>Close &amp; hand off</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>Closing <b>{deal.name}</b> creates the owned-asset records — a property and an acquisition transaction — so nothing is re-keyed. Enrich the GL, rent roll and JV structure afterward.</div>
            <Field label="Close date"><input type="date" value={closeDate} onChange={e => setCloseDate(e.target.value)} style={inputStyle} /></Field>
            <Field label="Final purchase price"><input value={finalPrice} onChange={e => setFinalPrice(e.target.value)} inputMode="decimal" placeholder="e.g. 68000000" style={inputStyle} /></Field>
            {err && <div style={{ color: 'var(--red)', fontSize: 12, margin: '8px 0' }}>{err}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
              <button style={ghostBtn} onClick={onClose} disabled={busy}>Cancel</button>
              <button style={primaryBtn} onClick={submit} disabled={busy}>{busy ? 'Closing…' : 'Confirm close'}</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: RISK_COLOR.core, marginBottom: 6 }}>✓ Deal closed</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 14 }}><b>{deal.name}</b> is now an owned asset. The property and its acquisition transaction were created.</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <a href={`/properties/${result.propertyId}`} style={linkBtn}>Open the property →</a>
              <a href="/transactions" style={linkBtn}>View in Transactions →</a>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}><button style={primaryBtn} onClick={onDone}>Done</button></div>
          </>
        )}
      </div>
    </Overlay>
  )
}

function Composer({ createdBy, team, onClose, onCreated }: { createdBy: string | null; team: TeamMember[]; onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState<NewDeal>({ name: '', assetType: 'retail', riskProfile: 'value_add', team: [] })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (p: Partial<NewDeal>) => setF(s => ({ ...s, ...p }))
  const numOr = (s: string): number | null => (s.trim() ? Number(s.replace(/[,$%]/g, '')) : null)
  const submit = async () => {
    if (!f.name.trim()) { setErr('Give the deal a name.'); return }
    setBusy(true); setErr(null)
    try { await createDeal(f, createdBy); onCreated() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Error') } finally { setBusy(false) }
  }
  return (
    <Overlay onClose={onClose}>
      <div style={modal} onClick={e => e.stopPropagation()}>
        <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 12 }}>New deal</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field label="Deal name *"><input autoFocus value={f.name} onChange={e => set({ name: e.target.value })} style={inputStyle} placeholder="e.g. Glen Eagle Square" /></Field>
          <div style={{ display: 'flex', gap: 10 }}>
            <Field label="Asset type" flex><select value={f.assetType} onChange={e => set({ assetType: e.target.value as AssetType })} style={inputStyle}>{(['retail', 'office', 'mixed', 'industrial'] as AssetType[]).map(a => <option key={a} value={a}>{ASSET_LABEL[a]}</option>)}</select></Field>
            <Field label="Risk profile" flex><select value={f.riskProfile} onChange={e => set({ riskProfile: e.target.value as RiskProfile })} style={inputStyle}>{RISK_ORDER.map(r => <option key={r} value={r}>{RISK_LABEL[r]}</option>)}</select></Field>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Field label="Sub-type" flex><input value={f.subType ?? ''} onChange={e => set({ subType: e.target.value })} style={inputStyle} placeholder="grocery-anchored" /></Field>
            <Field label="Submarket" flex><input value={f.submarket ?? ''} onChange={e => set({ submarket: e.target.value })} style={inputStyle} placeholder="CBD / Suburban" /></Field>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Field label="City" flex><input value={f.city ?? ''} onChange={e => set({ city: e.target.value })} style={inputStyle} /></Field>
            <Field label="State" flex><input value={f.state ?? ''} onChange={e => set({ state: e.target.value })} style={inputStyle} placeholder="CO" /></Field>
            <Field label="GLA (SF)" flex><input value={f.glaSf ?? ''} onChange={e => set({ glaSf: numOr(e.target.value) })} inputMode="decimal" style={inputStyle} /></Field>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Field label="Ask price" flex><input value={f.askPrice ?? ''} onChange={e => set({ askPrice: numOr(e.target.value) })} inputMode="decimal" style={inputStyle} placeholder="68000000" /></Field>
            <Field label="Going-in cap %" flex><input onChange={e => { const n = numOr(e.target.value); set({ goingInCap: n == null ? null : n / 100 }) }} inputMode="decimal" style={inputStyle} placeholder="6.6" /></Field>
            <Field label="Equity to raise" flex><input value={f.equityRequired ?? ''} onChange={e => set({ equityRequired: numOr(e.target.value) })} inputMode="decimal" style={inputStyle} placeholder="24000000" /></Field>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <MemberSelect label="Acquisition lead" team={team} value={f.leadMemberId ?? null} onChange={id => set({ leadMemberId: id })} />
            <MemberSelect label="Assigned analyst" team={team} value={f.analystMemberId ?? null} onChange={id => set({ analystMemberId: id })} />
            <Field label="Target partner" flex><input value={f.partner ?? ''} onChange={e => set({ partner: e.target.value })} style={inputStyle} placeholder="DRA" /></Field>
          </div>
          <Field label="Deal team"><TeamPicker team={team} value={f.team ?? []} onChange={t => set({ team: t })} /></Field>
          <Field label="Investment thesis"><textarea rows={2} value={f.thesis ?? ''} onChange={e => set({ thesis: e.target.value })} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} /></Field>
        </div>
        {err && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button style={ghostBtn} onClick={onClose} disabled={busy}>Cancel</button>
          <button style={primaryBtn} onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Create deal'}</button>
        </div>
      </div>
    </Overlay>
  )
}

// ── shared bits ───────────────────────────────────────────────────────────────
function Overlay({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.42)', zIndex: 60, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 16px', overflowY: 'auto' }}>{children}</div>
}
function Fact({ label, value, tint }: { label: string; value: string; tint?: string }) {
  return <div><div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{label}</div><div style={{ fontSize: 14, fontWeight: 700, color: tint ?? 'var(--text)' }}>{value}</div></div>
}
function Field({ label, children, flex }: { label: string; children: ReactNode; flex?: boolean }) {
  return <label style={{ display: 'block', flex: flex ? 1 : undefined }}><div style={fieldLab}>{label}</div>{children}</label>
}
function MemberSelect({ label, team, value, onChange }: { label: string; team: TeamMember[]; value: string | null; onChange: (id: string | null) => void }) {
  // Departed members stay in the roster as active=false. If a deal still points
  // at one, keep them selectable-as-current (labeled) instead of silently
  // rendering "— none —" while the DB says otherwise.
  const current = value ? team.find(m => m.id === value) : undefined
  return (
    <Field label={label} flex>
      <select value={value ?? ''} onChange={e => onChange(e.target.value || null)} style={inputStyle}>
        <option value="">— none —</option>
        {team.filter(m => m.active).map(m => <option key={m.id} value={m.id}>{m.fullName} ({m.initials})</option>)}
        {current && !current.active && <option value={current.id}>{current.fullName} (departed)</option>}
      </select>
    </Field>
  )
}
function TeamPicker({ team, value, onChange }: { team: TeamMember[]; value: string[]; onChange: (v: string[]) => void }) {
  const toggle = (ini: string) => onChange(value.includes(ini) ? value.filter(i => i !== ini) : [...value, ini])
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {team.filter(m => m.active).map(m => {
        const on = value.includes(m.initials)
        return (
          <button key={m.id} type="button" onClick={() => toggle(m.initials)}
            style={{ fontSize: 11.5, fontWeight: 600, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
              border: `1px solid ${on ? 'var(--accent, #466371)' : 'var(--border-2)'}`,
              background: on ? 'var(--accent, #466371)' : 'var(--surface)', color: on ? '#fff' : 'var(--text-muted)' }}>
            {m.fullName}
          </button>
        )
      })}
      {team.length === 0 && <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>No roster loaded.</span>}
    </div>
  )
}

const kicker: CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: '0.22em', textTransform: 'uppercase', color: MIST }
const fieldLab: CSSProperties = { fontSize: 10.5, fontWeight: 600, color: 'var(--text-faint)', marginBottom: 3 }
const navBtn: CSSProperties = { fontSize: 13, fontWeight: 600, padding: '9px 13px', border: 'none', borderBottom: '2px solid transparent', background: 'transparent', cursor: 'pointer' }
const selectStyle: CSSProperties = { fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border-2)', background: 'var(--surface)', color: 'var(--text)' }
const inputStyle: CSSProperties = { fontSize: 12.5, padding: '6px 9px', borderRadius: 6, border: '1px solid var(--border-2)', background: 'var(--surface)', color: 'var(--text)', width: '100%', boxSizing: 'border-box' }
const primaryBtn: CSSProperties = { fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 6, border: 'none', background: 'var(--accent, #466371)', color: '#fff', cursor: 'pointer' }
const ghostBtn: CSSProperties = { fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border-2)', background: 'var(--surface)', color: 'var(--text-muted)', cursor: 'pointer' }
const linkish: CSSProperties = { fontSize: 11, fontWeight: 600, background: 'transparent', border: 'none', color: 'var(--accent, #466371)', cursor: 'pointer', padding: 0 }
const linkBtn: CSSProperties = { fontSize: 12, fontWeight: 600, padding: '7px 11px', borderRadius: 6, border: '1px solid var(--border-2)', background: 'var(--surface)', color: 'var(--accent, #466371)', textDecoration: 'none', display: 'inline-block' }
const segBtn: CSSProperties = { fontSize: 11.5, fontWeight: 600, padding: '5px 12px', border: 'none', cursor: 'pointer' }
const cardStyle: CSSProperties = { display: 'block', width: '100%', textAlign: 'left', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)', padding: '9px 10px', cursor: 'pointer' }
const mono: CSSProperties = { width: 19, height: 19, borderRadius: 5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, color: '#fff', flex: 'none' }
const avatar: CSSProperties = { width: 19, height: 19, borderRadius: '50%', background: 'var(--surface-2, rgba(0,0,0,.06))', border: '1px solid var(--border-2)', color: 'var(--text-muted)', fontSize: 8.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }
const chipFlag: CSSProperties = { fontSize: 9.5, color: '#b08968', background: 'rgba(176,137,104,.14)', borderRadius: 5, padding: '2px 6px', marginTop: 7, display: 'inline-block' }
const ppill: CSSProperties = { fontSize: 9.5, fontWeight: 700, color: 'var(--accent, #466371)', background: 'rgba(70,99,113,.12)', borderRadius: 999, padding: '2px 7px' }
const grid2: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }
const drawer: CSSProperties = { width: 'min(700px, 96vw)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, padding: 18, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }
const modal: CSSProperties = { width: 'min(640px, 96vw)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, padding: 18, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }
const closeX: CSSProperties = { fontSize: 14, width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border-2)', background: 'var(--surface)', color: 'var(--text-muted)', cursor: 'pointer', flex: 'none' }
const miniX: CSSProperties = { fontSize: 11, width: 22, height: 22, borderRadius: 5, border: '1px solid var(--border-2)', background: 'var(--surface)', color: 'var(--text-faint)', cursor: 'pointer' }
const tabBtn: CSSProperties = { fontSize: 12.5, fontWeight: 600, padding: '7px 10px', border: 'none', borderBottom: '2px solid transparent', background: 'transparent', cursor: 'pointer' }
const facts: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(115px, 1fr))', gap: 11 }
const miniStage: CSSProperties = { fontSize: 10, fontWeight: 700, border: '1px solid', borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap' }
const th: CSSProperties = { textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-faint)', padding: '8px 10px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }
const td: CSSProperties = { padding: '7px 10px', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }
const tdNum: CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
const tdC: CSSProperties = { ...td, textAlign: 'center' }
