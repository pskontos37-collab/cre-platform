import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import {
  usePipeline, useCapitalPartners, useOmIntake,
  useBuyBoxes, createBuyBox, updateBuyBox, deleteBuyBox, type BuyBoxInput,
  useBrokers, createBroker, updateBroker, deleteBroker, type Broker, type BrokerInput,
  createDeal, updateDeal, deleteDeal, closeDeal,
  addDealLp, updateDealLp, removeDealLp, updateOmRow, extractOm, createDealFromExtraction, uploadOmPdf, generateIcMemo,
  useDealDocuments, uploadDealDocument, removeDealDocument, DEAL_DOC_ROLES, dealDocRoleLabel, type DealDoc,
  useDealComments, addDealComment, updateDealComment, deleteDealComment,
  useDealTeamMembers, type TeamMember,
  createPartner, updatePartner, deletePartner, type PartnerInput,
  openDiligence, unlinkDiligence, sendDocToDiligence,
  pipelineMetrics, fetchDeckExtras, saveUnderwriting, type UnderwritingModel,
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
import { underwrite, sensitivity, type AcqResult } from '../lib/acqUnderwriting'
import { underwriteTenant } from '../lib/tenantUnderwriting'
import { computePromote, DEFAULT_PROMOTE } from '../lib/acqPromote'
import { computeAcqAlerts, type AlertItem } from '../lib/acqAlerts'
import { bestFit, fitCategory, FIT_LABEL, type BuyBox, type FitDeal, type FitCategory } from '../lib/buyBox'
import { rankPartners, type MatchPartner, type MatchDeal } from '../lib/partnerMatch'
import type { UwLeaseLine, UwRollover, UwOpex, UwRefi, UwPromote, UwPromoteTier } from '../hooks/usePipeline'

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
  const buyBoxesQ = useBuyBoxes()
  const brokersQ = useBrokers()
  const deals = data ?? []
  const buyBoxes = buyBoxesQ.data ?? []
  const brokers = brokersQ.data ?? []

  const [view, setView] = useState<'pipeline' | 'analytics' | 'om' | 'partners' | 'buybox' | 'brokers'>('pipeline')
  const [assetFilter, setAssetFilter] = useState<'' | AssetType>('')
  const [riskFilter, setRiskFilter] = useState<'' | RiskProfile>('')
  const [search, setSearch] = useState('')
  const [fitFilter, setFitFilter] = useState<'' | FitCategory>('')
  const [boardMode, setBoardMode] = useState<'board' | 'table'>('board')
  const [openId, setOpenId] = useState<string | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)

  const hasBuyBox = buyBoxes.some(b => b.active)
  const visible = deals.filter(d => {
    if (assetFilter && d.assetType !== assetFilter) return false
    if (riskFilter && d.riskProfile !== riskFilter) return false
    if (search.trim() && !`${d.name} ${d.city ?? ''} ${d.state ?? ''}`.toLowerCase().includes(search.toLowerCase().trim())) return false
    if (fitFilter && hasBuyBox && fitCategory(bestFit(dealToFit(d), buyBoxes)) !== fitFilter) return false
    return true
  })
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
          <MeetingDeckButton deals={deals} buyBoxes={buyBoxes} partners={partnersQ.data ?? []} preparedBy={appUser?.full_name || appUser?.email || 'M&J Wilkow'} />
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
            {([['pipeline', 'Pipeline'], ['analytics', 'Analytics'], ['om', 'OM Intake'], ['partners', 'Partners'], ['buybox', 'Buy-Box'], ['brokers', 'Brokers']] as const).map(([k, lab]) => (
              <button key={k} onClick={() => setView(k)}
                style={{ ...navBtn, color: view === k ? 'var(--text)' : 'var(--text-faint)', borderBottomColor: view === k ? 'var(--accent, #466371)' : 'transparent' }}>
                {lab}
              </button>
            ))}
          </div>

          {view === 'pipeline' && (
            <PipelineView deals={visible} totalCount={deals.length} buyBoxes={buyBoxes}
              boardMode={boardMode} setBoardMode={setBoardMode}
              assetFilter={assetFilter} setAssetFilter={setAssetFilter}
              riskFilter={riskFilter} setRiskFilter={setRiskFilter}
              search={search} setSearch={setSearch} fitFilter={fitFilter} setFitFilter={setFitFilter} onOpen={setOpenId} />
          )}
          {view === 'analytics' && <AnalyticsView deals={visible} buyBoxes={buyBoxes} />}
          {view === 'om' && <OmView rows={omQ.data ?? []} createdBy={appUser?.id ?? null} buyBoxes={buyBoxes}
            onChanged={() => { omQ.refetch(); refetch() }} onOpen={setOpenId} />}
          {view === 'partners' && <PartnersView partners={partnersQ.data ?? []} deals={deals} onOpen={setOpenId} onChanged={partnersQ.refetch} />}
          {view === 'buybox' && <BuyBoxView buyBoxes={buyBoxes} deals={visible} onChanged={buyBoxesQ.refetch} />}
          {view === 'brokers' && <BrokersView brokers={brokers} deals={deals} onChanged={brokersQ.refetch} />}
        </>
      )}

      {openDeal && (
        <DealDrawer deal={openDeal} partners={partnersQ.data ?? []} team={teamQ.data ?? []} buyBoxes={buyBoxes}
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
  deals: Deal[]; totalCount: number; buyBoxes: BuyBox[]; boardMode: 'board' | 'table'; setBoardMode: (m: 'board' | 'table') => void
  assetFilter: '' | AssetType; setAssetFilter: (a: '' | AssetType) => void
  riskFilter: '' | RiskProfile; setRiskFilter: (r: '' | RiskProfile) => void
  search: string; setSearch: (s: string) => void; fitFilter: '' | FitCategory; setFitFilter: (f: '' | FitCategory) => void
  onOpen: (id: string) => void
}) {
  const hasBuyBox = p.buyBoxes.some(b => b.active)
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
        {hasBuyBox && (
          <select value={p.fitFilter} onChange={e => p.setFitFilter(e.target.value as any)} style={selectStyle}>
            <option value="">All fit</option>
            <option value="on">On-strategy</option>
            <option value="partial">Partial fit</option>
            <option value="off">Off-strategy</option>
          </select>
        )}
        <input value={p.search} onChange={e => p.setSearch(e.target.value)} placeholder="Search deals…"
          style={{ ...selectStyle, minWidth: 150 }} />
        {p.search && <button style={miniX} title="Clear search" onClick={() => p.setSearch('')}>✕</button>}
        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-faint)' }}>{p.deals.length} deals</span>
      </div>

      <AcqAlerts deals={p.deals} onOpen={p.onOpen} />

      {p.deals.length === 0 ? (
        <EmptyState icon="📈" title="No deals match these filters." />
      ) : p.boardMode === 'board' ? (
        <>
          <Board deals={p.deals} onOpen={p.onOpen} buyBoxes={p.buyBoxes} />
          <Watchlist deals={p.deals.filter(d => d.stage === 'tracking')} onOpen={p.onOpen} />
        </>
      ) : (
        <Table deals={p.deals} onOpen={p.onOpen} buyBoxes={p.buyBoxes} />
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

// ── Deadlines & activity alerts (Phase 2 workflow) — shared logic in lib/acqAlerts ──
type DealAlert = AlertItem<Deal>
function AcqAlerts({ deals, onOpen }: { deals: Deal[]; onOpen: (id: string) => void }) {
  const { deadlines, stalled } = computeAcqAlerts(deals, Date.now())
  if (!deadlines.length && !stalled.length) return null
  const dLabel = (n: number) => (n < 0 ? `${-n}d overdue` : n === 0 ? 'today' : `${n}d`)
  const dColor = (n: number) => (n < 0 ? '#c0654e' : n <= 14 ? RISK_COLOR.value_add : 'var(--text-muted)')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)', padding: '11px 13px' }}>
      {deadlines.length > 0 && (
        <AlertRow icon="⏱" label={`Close deadlines (${deadlines.length})`} chips={deadlines} onOpen={onOpen}
          metric={x => dLabel(x.days)} color={x => dColor(x.days)}
          title={x => `${x.d.name} · ${STAGE_LABEL[x.d.stage]}${x.d.bidText ? ` · bid ${x.d.bidText}` : ''} · target close ${x.d.targetCloseDate}`} />
      )}
      {stalled.length > 0 && (
        <AlertRow icon="⚠" label={`Aging in stage (${stalled.length})`} chips={stalled} onOpen={onOpen}
          metric={x => `${x.days}d in stage`} color={() => 'var(--text-muted)'}
          title={x => `${x.d.name} · ${STAGE_LABEL[x.d.stage]} since ${(x.d.stageChangedAt ?? x.d.updatedAt).slice(0, 10)}`} />
      )}
    </div>
  )
}
function AlertRow({ icon, label, chips, onOpen, metric, color, title }: {
  icon: string; label: string; chips: DealAlert[]; onOpen: (id: string) => void
  metric: (x: DealAlert) => string; color: (x: DealAlert) => string; title: (x: DealAlert) => string
}) {
  const CAP = 8
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>{icon} {label}</span>
      {chips.slice(0, CAP).map(x => (
        <button key={x.d.id} onClick={() => onOpen(x.d.id)} title={title(x)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--border-2)', borderRadius: 999, background: 'var(--surface-2, rgba(0,0,0,.03))', padding: '2px 9px', fontSize: 11.5, color: 'var(--text)', cursor: 'pointer', maxWidth: 240 }}>
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.d.name}</span>
          <span style={{ fontWeight: 700, color: color(x), whiteSpace: 'nowrap' }}>{metric(x)}</span>
        </button>
      ))}
      {chips.length > CAP && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>+{chips.length - CAP} more</span>}
    </div>
  )
}

// ── buy-box / strategy fit (Phase 3 sourcing) ──
const dealToFit = (d: Deal): FitDeal => ({
  assetType: d.assetType, riskProfile: d.riskProfile, state: d.state, market: d.market,
  glaSf: d.glaSf, askPrice: d.askPrice, goingInCap: d.goingInCap, projIrr: d.projIrr, equityMultiple: d.equityMultiple,
})
const FIT_COLOR: Record<FitCategory, string> = { on: '#2e8b57', partial: RISK_COLOR.value_add, off: '#c0654e', none: 'var(--text-faint)' }
function FitBadge({ deal, buyBoxes }: { deal: Deal; buyBoxes: BuyBox[] }) {
  if (!buyBoxes.some(b => b.active)) return null
  const best = bestFit(dealToFit(deal), buyBoxes)
  const cat = fitCategory(best)
  const c = FIT_COLOR[cat]
  const title = best ? `Best match: ${best.bb.name} — ${best.fit.passed}/${best.fit.applicable} criteria (${Math.round(best.fit.score * 100)}%)` : 'No buy-box defined'
  return <span title={title} style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', color: c, background: `${c}1e`, borderRadius: 999, padding: '1px 6px', whiteSpace: 'nowrap' }}>{FIT_LABEL[cat]}</span>
}
function scoredActive(deals: Deal[], buyBoxes: BuyBox[]) {
  return deals.filter(d => !isTerminal(d.stage) && d.stage !== 'closed').map(d => {
    const best = bestFit(dealToFit(d), buyBoxes)
    return { d, best, cat: fitCategory(best) }
  })
}
function fitDistRows(deals: Deal[], buyBoxes: BuyBox[]): BarRow[] {
  const s = scoredActive(deals, buyBoxes)
  const count = (c: FitCategory) => s.filter(x => x.cat === c).length
  return ([['On-strategy', count('on')], ['Partial fit', count('partial')], ['Off-strategy', count('off')]] as [string, number][])
    .filter(([, v]) => v > 0).map(([l, v]) => ({ l, v }))
}
function fitByBoxRows(deals: Deal[], buyBoxes: BuyBox[]): BarRow[] {
  const by: Record<string, number> = {}
  for (const x of scoredActive(deals, buyBoxes)) {
    if (x.best && !x.best.fit.disqualified) by[x.best.bb.name] = (by[x.best.bb.name] ?? 0) + 1
  }
  return Object.entries(by).sort((a, b) => b[1] - a[1]).map(([l, v]) => ({ l, v }))
}

function Board({ deals, onOpen, buyBoxes }: { deals: Deal[]; onOpen: (id: string) => void; buyBoxes: BuyBox[] }) {
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
              {inCol.map(d => <DealCard key={d.id} d={d} onOpen={onOpen} buyBoxes={buyBoxes} />)}
              {inCol.length === 0 && <div style={{ fontSize: 11, color: 'var(--text-faint)', padding: '8px 3px' }}>—</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function DealCard({ d, onOpen, buyBoxes }: { d: Deal; onOpen: (id: string) => void; buyBoxes: BuyBox[] }) {
  const committed = d.lps.reduce((a, l) => a + (l.committedAmount ?? 0), 0)
  const raise = d.equityRequired ? Math.min(1, committed / d.equityRequired) : 0
  return (
    <button onClick={() => onOpen(d.id)} style={{ ...cardStyle, borderLeft: `3px solid ${RISK_COLOR[d.riskProfile]}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
        <span style={{ ...mono, background: ASSET_COLOR[d.assetType] }}>{ASSET_MONO[d.assetType]}</span>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', color: RISK_COLOR[d.riskProfile] }}>{RISK_LABEL[d.riskProfile]}</span>
        <FitBadge deal={d} buyBoxes={buyBoxes} />
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

function Table({ deals, onOpen, buyBoxes = [] }: { deals: Deal[]; onOpen: (id: string) => void; buyBoxes?: BuyBox[] }) {
  const sorted = [...deals].sort((a, b) => ALL_STAGES.indexOf(a.stage) - ALL_STAGES.indexOf(b.stage) || (b.askPrice ?? 0) - (a.askPrice ?? 0))
  const hasBuyBox = buyBoxes.some(b => b.active)
  const cols = ['Deal', 'Team', 'Profile', 'Sub', 'Stage', 'City', 'Guidance', 'SF', 'Partner', ...(hasBuyBox ? ['Fit'] : [])]
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead><tr>{cols.map(h => <th key={h} style={['Guidance', 'SF'].includes(h) ? { ...th, textAlign: 'right' } : th}>{h}</th>)}</tr></thead>
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
              {hasBuyBox && <td style={td}><FitBadge deal={d} buyBoxes={buyBoxes} /></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── ANALYTICS VIEW ────────────────────────────────────────────────────────────
function AnalyticsView({ deals: allDeals, buyBoxes }: { deals: Deal[]; buyBoxes: BuyBox[] }) {
  // Analytics reflect the active book — the watchlist is excluded.
  const deals = useMemo(() => allDeals.filter(d => d.stage !== 'tracking'), [allDeals])
  const hasBuyBox = buyBoxes.some(b => b.active)
  // Memoize the derived aggregates — several re-run the underwrite/fit engines per
  // deal, so recomputing them on every render (e.g. parent re-renders) is wasteful.
  const summary = useMemo(() => returnsSummary(deals), [deals])
  const irrRank = useMemo(() => irrRankRows(deals), [deals])
  const capitalByQ = useMemo(() => capitalQuarterRows(deals), [deals])
  const irrByProfile = useMemo(() => irrByProfileRows(deals), [deals])
  const fitDist = useMemo(() => fitDistRows(deals, buyBoxes), [deals, buyBoxes])
  const fitByBox = useMemo(() => fitByBoxRows(deals, buyBoxes), [deals, buyBoxes])
  return (
    <>
      {hasBuyBox && (
        <>
          <AnalyticsHeading>Sourcing Fit</AnalyticsHeading>
          <div style={{ ...grid2, marginBottom: 14 }}>
            <Panel title="Strategy fit" cap="Active deals scored against the acquisition buy-boxes.">
              <Bars rows={fitDist} color={RISK_COLOR.core} isCount empty="No active deals to score." />
            </Panel>
            <Panel title="On-strategy by buy-box" cap="Deals that best-match each buy-box (non-disqualified).">
              <Bars rows={fitByBox} color={RISK_COLOR.core_plus} isCount empty="No matched deals yet." />
            </Panel>
          </div>
        </>
      )}
      <AnalyticsHeading>Returns &amp; Capital</AnalyticsHeading>
      <ReturnsSummaryStrip s={summary} />
      <div style={{ ...grid2, marginTop: 14 }}>
        <Panel title="Deal returns — levered IRR" cap="Underwritten active deals, best first.">
          <Bars rows={irrRank} color={RISK_COLOR.core} empty="No deals underwritten yet — save a model on a deal's Underwriting tab." />
        </Panel>
        <Panel title="Capital deployment by close" cap="Equity required, bucketed by target close quarter.">
          <Bars rows={capitalByQ} color={RISK_COLOR.core_plus} empty="No equity requirements set yet." />
        </Panel>
      </div>
      <div style={{ ...grid2, marginTop: 14 }}>
        <Panel title="Avg levered IRR by risk profile" cap="Mean projected IRR of underwritten deals in each profile.">
          <Bars rows={irrByProfile} color={RISK_COLOR.value_add} empty="No underwritten deals to profile yet." />
        </Panel>
        <Panel title="Capital raised" cap="Committed vs. soft-circled vs. remaining, across active raises.">
          <Donut deals={deals} />
        </Panel>
      </div>

      <AnalyticsHeading>Pipeline &amp; Coverage</AnalyticsHeading>
      <div style={grid2}>
        <Panel title="Pipeline funnel" cap="Deals and gross volume at each stage.">
          <Funnel deals={deals} />
        </Panel>
        <Panel title="Investment-profile matrix" cap="Gross volume by risk profile × asset type.">
          <Matrix deals={deals} />
        </Panel>
      </div>
      <div style={{ ...grid2, marginTop: 14 }}>
        <Panel title="Geographic exposure" cap="Gross volume by state.">
          <Bars rows={geoRows(deals)} color="var(--accent, #466371)" />
        </Panel>
        <Panel title="Volume by LP partner" cap="Gross deal volume attributed to each capital partner.">
          <Bars rows={partnerRows(deals)} color={RISK_COLOR.core_plus} empty="No partner-attributed volume in this filter." />
        </Panel>
      </div>
      <div style={{ ...grid2, marginTop: 14 }}>
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
function AnalyticsHeading({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)', margin: '4px 0 12px' }}>{children}</div>
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

interface BarRow { l: string; v: number; fmt?: (v: number) => string }
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

// ── returns-aware analytics (Phase 2) — leans on the underwriting metrics ──
const pctBar = (v: number) => `${(v * 100).toFixed(1)}%`
const dealProb = (d: Deal) => STAGE_PROB[d.stage] ?? d.probability
interface ReturnsSummary {
  underwritten: number; total: number; avgIrr: number | null; avgEm: number | null
  totalEquity: number; weightedEquity: number; expectedProfit: number
  expectedPromote: number; promoteCoverage: number
}
function returnsSummary(deals: Deal[]): ReturnsSummary {
  const uw = deals.filter(d => d.projIrr != null)
  const eq = (d: Deal) => d.equityRequired ?? 0
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
  let expectedProfit = 0, expectedPromote = 0, promoteCoverage = 0
  for (const d of uw) {
    if (d.equityMultiple != null) expectedProfit += dealProb(d) * (d.equityMultiple - 1) * eq(d)
    const gp = promoteForMemo(d.underwritingModel)?.gpPromote
    if (gp != null && isFinite(gp)) { expectedPromote += dealProb(d) * gp; promoteCoverage++ }
  }
  return {
    underwritten: uw.length, total: deals.length,
    avgIrr: mean(uw.map(d => d.projIrr!)), avgEm: mean(uw.filter(d => d.equityMultiple != null).map(d => d.equityMultiple!)),
    totalEquity: uw.reduce((a, d) => a + eq(d), 0), weightedEquity: uw.reduce((a, d) => a + dealProb(d) * eq(d), 0),
    expectedProfit, expectedPromote, promoteCoverage,
  }
}
function irrRankRows(deals: Deal[]): BarRow[] {
  return deals.filter(d => d.projIrr != null).sort((a, b) => b.projIrr! - a.projIrr!).slice(0, 10)
    .map(d => ({ l: d.name, v: d.projIrr!, fmt: pctBar }))
}
function capitalQuarterRows(deals: Deal[]): BarRow[] {
  const by: Record<string, number> = {}, ord: Record<string, number> = {}
  for (const d of deals) {
    const e = d.equityRequired ?? 0; if (!e) continue
    let key = 'Unscheduled', o = 9e9
    if (d.targetCloseDate) {
      const dt = new Date(d.targetCloseDate), q = Math.floor(dt.getMonth() / 3) + 1
      key = `Q${q} '${String(dt.getFullYear() % 100).padStart(2, '0')}`; o = dt.getFullYear() * 4 + q
    }
    by[key] = (by[key] ?? 0) + e; ord[key] = o
  }
  return Object.keys(by).sort((a, b) => ord[a] - ord[b]).map(k => ({ l: k, v: by[k] }))
}
function irrByProfileRows(deals: Deal[]): BarRow[] {
  return RISK_ORDER.map(rp => {
    const xs = deals.filter(d => d.riskProfile === rp && d.projIrr != null).map(d => d.projIrr!)
    return xs.length ? { l: RISK_LABEL[rp], v: xs.reduce((a, b) => a + b, 0) / xs.length, fmt: pctBar } : null
  }).filter((r): r is BarRow => r != null)
}
function ReturnsSummaryStrip({ s }: { s: ReturnsSummary }) {
  return (
    <div style={{ border: '1px solid var(--border)', background: 'var(--surface)', borderRadius: 12, padding: '14px 17px' }}>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 10 }}>
        {s.underwritten} of {s.total} active deals underwritten
        {s.underwritten < s.total ? ` — returns below cover only the ${s.underwritten} with a saved model.` : '.'}
        {s.underwritten > 0 && s.promoteCoverage < s.underwritten ? ` Expected promote covers ${s.promoteCoverage}.` : ''}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
        <Fact label="Avg levered IRR" value={pct(s.avgIrr)} tint={uwIrrColor(s.avgIrr)} />
        <Fact label="Avg equity multiple" value={s.avgEm != null ? `${s.avgEm.toFixed(2)}x` : '—'} />
        <Fact label="Equity to deploy" value={fmtM(s.totalEquity)} />
        <Fact label="Prob-weighted equity" value={fmtM(s.weightedEquity)} />
        <Fact label="Expected profit" value={fmtM(s.expectedProfit)} />
        <Fact label="Expected GP promote" value={fmtM(s.expectedPromote)} tint={RISK_COLOR.core} />
      </div>
    </div>
  )
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
          <div style={{ color: 'var(--text)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{r.fmt ? r.fmt(r.v) : isCount ? r.v : fmtM(r.v)}</div>
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

function OmView({ rows, createdBy, buyBoxes, onChanged, onOpen }: { rows: any[]; createdBy: string | null; buyBoxes: BuyBox[]; onChanged: () => void; onOpen: (id: string) => void }) {
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
        {ex && <ExtractResult ex={ex} buyBoxes={buyBoxes} onCreate={create} creating={creating} />}
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
// Map an OM extraction to a scorable deal using the same defaults the created
// deal will use (retail / value_add), so the fit preview matches the created deal.
const omToFit = (ex: OmExtraction): FitDeal => ({
  assetType: ex.asset_type ?? 'retail', riskProfile: ex.risk_profile ?? 'value_add',
  state: ex.state ?? null, market: null, glaSf: ex.gla_sf ?? null,
  askPrice: ex.asking_price ?? null, goingInCap: ex.in_place_cap ?? null,
  projIrr: null, equityMultiple: null,
})
function ExtractResult({ ex, buyBoxes, onCreate, creating }: { ex: OmExtraction; buyBoxes: BuyBox[]; onCreate: () => void; creating: boolean }) {
  const fct = (l: string, v: ReactNode) => <div><div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{l}</div><div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--accent, #466371)' }}>{v}</div></div>
  const best = buyBoxes.some(b => b.active) ? bestFit(omToFit(ex), buyBoxes) : null
  const cat = fitCategory(best)
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)', padding: 15, marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
        <span style={{ ...mono, background: ex.asset_type ? ASSET_COLOR[ex.asset_type] : MIST }}>{ex.asset_type ? ASSET_MONO[ex.asset_type] : '?'}</span>
        <b style={{ fontSize: 15, color: 'var(--text)' }}>{ex.name ?? 'Extracted deal'}</b>
        {ex.risk_profile && <span style={{ marginLeft: 'auto', fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', color: RISK_COLOR[ex.risk_profile] }}>{RISK_LABEL[ex.risk_profile]} · {ex.asset_type ? ASSET_LABEL[ex.asset_type] : ''}</span>}
      </div>
      {best && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11, fontSize: 11.5, color: 'var(--text-muted)' }}>
          <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: FIT_COLOR[cat], background: `${FIT_COLOR[cat]}1e`, borderRadius: 999, padding: '1px 7px' }}>{FIT_LABEL[cat]}</span>
          <span>Best match: <b style={{ color: 'var(--text)' }}>{best.bb.name}</b> — {best.fit.passed}/{best.fit.applicable} criteria ({Math.round(best.fit.score * 100)}%){best.fit.disqualified ? ' · disqualified' : ''}</span>
        </div>
      )}
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
// Firm-wide raise view: each active deal's top mandate-fit partners.
function PortfolioLpMatch({ deals, partners, onOpen }: { deals: Deal[]; partners: CapitalPartner[]; onOpen: (id: string) => void }) {
  // useMemo before any early return (rules of hooks); ranking is O(deals x partners).
  const rows = useMemo(() => {
    const mps: MatchPartner[] = partners.map(p => ({ id: p.id, name: p.name, tier: p.tier, productTypes: p.productTypes, markets: p.markets, returnTarget: p.returnTarget, dealSize: p.dealSize, active: p.active }))
    return deals
      .filter(d => !isTerminal(d.stage) && d.stage !== 'closed')
      .map(d => {
        const onDeal = new Set(d.lps.map(l => l.partnerId))
        const md: MatchDeal = { assetType: d.assetType, state: d.state, market: d.market, submarket: d.submarket, askPrice: d.askPrice, projIrr: d.projIrr }
        const top = rankPartners(md, mps, onDeal).filter(m => m.score > 0).slice(0, 3)
        const raised = d.lps.reduce((a, l) => a + (l.committedAmount ?? 0) + (l.softAmount ?? 0), 0)
        const gap = d.equityRequired != null ? Math.max(0, d.equityRequired - raised) : null
        return { d, top, gap }
      })
      .filter(r => r.top.length > 0)
      .sort((a, b) => (b.gap ?? 0) - (a.gap ?? 0))
  }, [deals, partners])
  if (!partners.some(p => p.active)) return null
  if (!rows.length) return null
  return (
    <div style={{ border: '1px solid var(--border)', background: 'var(--surface)', borderRadius: 12, padding: '15px 16px', marginBottom: 16 }}>
      <div style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>Deal &harr; LP matching</div>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', margin: '2px 0 12px' }}>Top mandate-fit partners for each active deal (open equity gap first). Click a deal to open its Capital tab.</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {rows.map(({ d, top, gap }) => (
          <div key={d.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1.4fr) auto 2fr', gap: 10, alignItems: 'center', padding: '7px 0', borderTop: '1px solid var(--border)', fontSize: 12 }}>
            <button onClick={() => onOpen(d.id)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', fontWeight: 700, color: 'var(--text)' }}>{d.name}</button>
            <span style={{ color: 'var(--text-faint)', fontSize: 11, whiteSpace: 'nowrap' }}>{gap != null ? `${fmtM(gap)} gap` : '—'}</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {top.map(m => {
                const c = m.partner.tier === 'current' ? '#2e8b57' : m.partner.tier === 'tier1_prospect' ? RISK_COLOR.core_plus : 'var(--text-faint)'
                return <span key={m.partner.id} title={`${PARTNER_TIER_LABEL[m.partner.tier]} · ${m.signals.filter(s => s.status === 'hit').map(s => s.label).join(', ') || 'agnostic'}`} style={{ fontSize: 10.5, color: c, border: `1px solid ${c}55`, borderRadius: 999, padding: '1px 8px' }}>{m.partner.name}</span>
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
function PartnersView({ partners, deals, onOpen, onChanged }: { partners: CapitalPartner[]; deals: Deal[]; onOpen: (id: string) => void; onChanged: () => void }) {
  const [editing, setEditing] = useState<CapitalPartner | 'new' | null>(null)
  const groups: [string, CapitalPartner[]][] = [
    ['Current partners', partners.filter(p => p.tier === 'current')],
    ['Tier 1 prospects', partners.filter(p => p.tier === 'tier1_prospect')],
    ['Tier 2 prospects', partners.filter(p => p.tier === 'tier2_prospect')],
  ]
  return (
    <>
      <PortfolioLpMatch deals={deals} partners={partners} onOpen={onOpen} />
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

// ── Buy-Box manager (Phase 3 sourcing) ──
const rng = (min: number | null, max: number | null, fmt: (n: number) => string) =>
  min != null && max != null ? `${fmt(min)}–${fmt(max)}` : min != null ? `≥ ${fmt(min)}` : max != null ? `≤ ${fmt(max)}` : ''
const bbM = (n: number) => `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
const bbPct = (n: number) => `${(n * 100).toFixed(1)}%`
const bbSf = (n: number) => `${Math.round(n / 1000)}k SF`

function BuyBoxView({ buyBoxes, deals, onChanged }: { buyBoxes: BuyBox[]; deals: Deal[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<BuyBox | 'new' | null>(null)
  const active = deals.filter(d => !isTerminal(d.stage) && d.stage !== 'closed')
  const onCount = (bb: BuyBox) => active.filter(d => { const b = bestFit(dealToFit(d), [bb]); return !!b && !b.fit.disqualified && b.fit.score >= 0.8 }).length
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '-4px 0 12px' }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Define the firm's acquisition criteria. Every active deal is scored against these to surface on-strategy sourcing.</div>
        <button style={{ ...primaryBtn, marginLeft: 'auto' }} onClick={() => setEditing('new')}>+ Add buy-box</button>
      </div>
      {buyBoxes.length === 0 ? (
        <EmptyState icon="🎯" title="No buy-boxes yet." subtitle="Add your first acquisition buy-box to start scoring deal flow." />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 13 }}>
          {buyBoxes.map(bb => <BuyBoxCard key={bb.id} bb={bb} onEdit={() => setEditing(bb)} onStrategy={onCount(bb)} total={active.length} />)}
        </div>
      )}
      {editing && <BuyBoxModal buyBox={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged() }} />}
    </>
  )
}

function BuyBoxCard({ bb, onEdit, onStrategy, total }: { bb: BuyBox; onEdit: () => void; onStrategy: number; total: number }) {
  const crit: string[] = [
    bb.assetTypes.length ? bb.assetTypes.map(a => ASSET_LABEL[a]).join(' / ') : '',
    bb.riskProfiles.length ? bb.riskProfiles.map(r => RISK_LABEL[r]).join(' / ') : '',
    [...bb.states, ...bb.markets].join(', '),
    rng(bb.minPrice, bb.maxPrice, bbM),
    rng(bb.minGla, bb.maxGla, bbSf),
    rng(bb.minGoingInCap, bb.maxGoingInCap, bbPct) && `${rng(bb.minGoingInCap, bb.maxGoingInCap, bbPct)} cap`,
    bb.minIrr != null ? `IRR ≥ ${bbPct(bb.minIrr)}` : '',
    bb.minEquityMultiple != null ? `EM ≥ ${bb.minEquityMultiple.toFixed(2)}x` : '',
  ].filter(Boolean) as string[]
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)', padding: '14px 15px', opacity: bb.active ? 1 : 0.6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{bb.name}</span>
        {!bb.active && <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-faint)', border: '1px solid var(--border-2)', borderRadius: 999, padding: '1px 7px' }}>Inactive</span>}
        <button style={{ ...miniX, marginLeft: 'auto' }} title={`Edit ${bb.name}`} onClick={onEdit}>✎</button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {crit.length ? crit.map((c, i) => <span key={i} style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--surface-2, rgba(0,0,0,.04))', borderRadius: 6, padding: '2px 8px' }}>{c}</span>)
          : <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>No criteria set — matches every deal.</span>}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 10 }}>
        <b style={{ color: '#2e8b57' }}>{onStrategy}</b> of {total} active deals on-strategy{bb.notes ? ` · ${bb.notes}` : ''}
      </div>
    </div>
  )
}

function BuyBoxModal({ buyBox, onClose, onSaved }: { buyBox: BuyBox | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<BuyBoxInput>(() => buyBox ? { ...buyBox } : {
    name: '', assetTypes: [], riskProfiles: [], states: [], markets: [],
    minPrice: null, maxPrice: null, minGla: null, maxGla: null, minGoingInCap: null, maxGoingInCap: null,
    minIrr: null, minEquityMultiple: null, active: true, notes: null,
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (p: Partial<BuyBoxInput>) => setF(s => ({ ...s, ...p }))
  const toggle = <K extends 'assetTypes' | 'riskProfiles'>(k: K, v: BuyBoxInput[K][number]) =>
    set({ [k]: (f[k] as string[]).includes(v as string) ? (f[k] as string[]).filter(x => x !== v) : [...(f[k] as string[]), v] } as Partial<BuyBoxInput>)
  const numOrNull = (s: string) => { const n = Number(s.replace(/[,$%\s]/g, '')); return s.trim() === '' || !isFinite(n) ? null : n }

  const save = async () => {
    if (!f.name.trim()) { setErr('Buy-box needs a name.'); return }
    setBusy(true); setErr(null)
    try { if (buyBox) { await updateBuyBox(buyBox.id, f) } else { await createBuyBox(f) } onSaved() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Save failed') }
    finally { setBusy(false) }
  }
  const remove = async () => {
    if (!buyBox) return
    if (!confirm(`Delete buy-box "${buyBox.name}"?`)) return
    setBusy(true); setErr(null)
    try { await deleteBuyBox(buyBox.id); onSaved() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Delete failed') }
    finally { setBusy(false) }
  }
  const chip = (on: boolean, color: string, label: string, onClick: () => void) => (
    <button key={label} type="button" onClick={onClick} style={{ fontSize: 11.5, fontWeight: 600, padding: '4px 10px', borderRadius: 999, cursor: 'pointer', border: `1px solid ${on ? color : 'var(--border-2)'}`, background: on ? color : 'var(--surface)', color: on ? '#fff' : 'var(--text-muted)' }}>{label}</button>
  )
  const numInput = (val: number | null, onChange: (n: number | null) => void, ph: string) =>
    <input value={val ?? ''} placeholder={ph} onChange={e => onChange(numOrNull(e.target.value))} style={{ ...inputStyle, textAlign: 'right' }} />
  const pctInput = (val: number | null, onChange: (n: number | null) => void, ph: string) =>
    <input value={val != null ? +(val * 100).toFixed(2) : ''} placeholder={ph} onChange={e => { const n = numOrNull(e.target.value); onChange(n == null ? null : n / 100) }} style={{ ...inputStyle, textAlign: 'right' }} />

  return (
    <Overlay onClose={busy ? () => {} : onClose}>
      <div style={modal} onClick={e => e.stopPropagation()}>
        <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 12 }}>{buyBox ? `Edit ${buyBox.name}` : 'Add acquisition buy-box'}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field label="Name *"><input autoFocus value={f.name} onChange={e => set({ name: e.target.value })} style={inputStyle} placeholder="e.g. Value-Add Retail — Sunbelt" /></Field>
          <Field label="Asset types (any if none)">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(ASSET_ORDER.concat(['industrial'] as AssetType[])).map(a => chip(f.assetTypes.includes(a), ASSET_COLOR[a], ASSET_LABEL[a], () => toggle('assetTypes', a)))}
            </div>
          </Field>
          <Field label="Risk profiles (any if none)">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {RISK_ORDER.map(r => chip(f.riskProfiles.includes(r), RISK_COLOR[r], RISK_LABEL[r], () => toggle('riskProfiles', r)))}
            </div>
          </Field>
          <div style={{ display: 'flex', gap: 10 }}>
            <Field label="States (comma, 2-letter)" flex><input value={f.states.join(', ')} onChange={e => set({ states: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} style={inputStyle} placeholder="NC, SC, GA, FL, TX" /></Field>
            <Field label="Markets (comma)" flex><input value={f.markets.join(', ')} onChange={e => set({ markets: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} style={inputStyle} placeholder="Charlotte, Raleigh" /></Field>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Field label="Min price ($)" flex>{numInput(f.minPrice, n => set({ minPrice: n }), '20000000')}</Field>
            <Field label="Max price ($)" flex>{numInput(f.maxPrice, n => set({ maxPrice: n }), '80000000')}</Field>
            <Field label="Min GLA (SF)" flex>{numInput(f.minGla, n => set({ minGla: n }), '')}</Field>
            <Field label="Max GLA (SF)" flex>{numInput(f.maxGla, n => set({ maxGla: n }), '')}</Field>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Field label="Min cap (%)" flex>{pctInput(f.minGoingInCap, n => set({ minGoingInCap: n }), '6')}</Field>
            <Field label="Max cap (%)" flex>{pctInput(f.maxGoingInCap, n => set({ maxGoingInCap: n }), '')}</Field>
            <Field label="Min IRR (%)" flex>{pctInput(f.minIrr, n => set({ minIrr: n }), '13')}</Field>
            <Field label="Min EM (x)" flex>{numInput(f.minEquityMultiple, n => set({ minEquityMultiple: n }), '1.7')}</Field>
          </div>
          <Field label="Notes"><input value={f.notes ?? ''} onChange={e => set({ notes: e.target.value })} style={inputStyle} placeholder="Strategy note shown on the card" /></Field>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--text-muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={f.active} onChange={e => set({ active: e.target.checked })} /> Active (scores deal flow)
          </label>
        </div>
        {err && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          {buyBox && <button style={{ ...ghostBtn, color: 'var(--red)', borderColor: 'var(--red)' }} disabled={busy} onClick={remove}>Delete</button>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button style={ghostBtn} onClick={onClose} disabled={busy}>Cancel</button>
            <button style={primaryBtn} onClick={save} disabled={busy}>{busy ? 'Saving…' : buyBox ? 'Save changes' : 'Add buy-box'}</button>
          </div>
        </div>
      </div>
    </Overlay>
  )
}

// ── Brokers: deal-flow relationship book (Phase 3 sourcing) ──
const brokerMatch = (dealBroker: string | null, b: Broker): boolean => {
  if (!dealBroker) return false
  const s = dealBroker.toLowerCase().trim()
  if (!s) return false
  const nm = b.name.toLowerCase(), fm = (b.firm ?? '').toLowerCase()
  return s.includes(nm) || nm.includes(s) || (!!fm && s.includes(fm))
}
const BROKER_STATUS: { key: string; label: string; color: string }[] = [
  { key: 'active', label: 'Active', color: '#2e8b57' },
  { key: 'prospect', label: 'Prospect', color: RISK_COLOR.core_plus },
  { key: 'dormant', label: 'Dormant', color: 'var(--text-faint)' },
]
const brokerStatus = (s: string) => BROKER_STATUS.find(x => x.key === s) ?? BROKER_STATUS[0]

function BrokersView({ brokers, deals, onChanged }: { brokers: Broker[]; deals: Deal[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<Broker | 'new' | null>(null)
  const active = deals.filter(d => !isTerminal(d.stage))
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '-4px 0 12px' }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>The deal-sourcing relationship book. Deals attribute to a broker by matching the deal's broker field.</div>
        <button style={{ ...primaryBtn, marginLeft: 'auto' }} onClick={() => setEditing('new')}>+ Add broker</button>
      </div>
      {brokers.length === 0 ? (
        <EmptyState icon="🤝" title="No brokers yet." subtitle="Add the brokers who send you deals to track sourcing." />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 13 }}>
          {brokers.map(b => {
            const ds = active.filter(d => brokerMatch(d.broker, b))
            return <BrokerCard key={b.id} b={b} dealCount={ds.length} volume={ds.reduce((a, d) => a + (d.askPrice ?? 0), 0)} onEdit={() => setEditing(b)} />
          })}
        </div>
      )}
      {editing && <BrokerModal broker={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged() }} />}
    </>
  )
}

function BrokerCard({ b, dealCount, volume, onEdit }: { b: Broker; dealCount: number; volume: number; onEdit: () => void }) {
  const st = brokerStatus(b.status)
  const contact = [b.email, b.phone].filter(Boolean).join(' · ')
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)', padding: '14px 15px', opacity: b.active ? 1 : 0.6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 4 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{b.name}</span>
        <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', borderRadius: 999, padding: '2px 8px', color: st.color, background: st.color + '22' }}>{st.label}</span>
        <button style={miniX} title={`Edit ${b.name}`} onClick={onEdit}>✎</button>
      </div>
      {b.firm && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>{b.firm}</div>}
      <div style={{ display: 'flex', gap: 14, fontSize: 12, marginBottom: 8 }}>
        <div><b style={{ color: 'var(--text)' }}>{dealCount}</b> <span style={{ color: 'var(--text-faint)' }}>active deals</span></div>
        <div><b style={{ color: 'var(--text)' }}>{fmtM(volume)}</b> <span style={{ color: 'var(--text-faint)' }}>volume</span></div>
      </div>
      {(b.markets.length > 0 || b.assetTypes.length > 0) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {b.assetTypes.map(a => <span key={a} style={{ fontSize: 10.5, color: 'var(--text-muted)', background: 'var(--surface-2, rgba(0,0,0,.04))', borderRadius: 6, padding: '2px 8px' }}>{ASSET_LABEL[a as AssetType] ?? a}</span>)}
          {b.markets.map((m, i) => <span key={`m${i}`} style={{ fontSize: 10.5, color: 'var(--text-muted)', background: 'var(--surface-2, rgba(0,0,0,.04))', borderRadius: 6, padding: '2px 8px' }}>{m}</span>)}
        </div>
      )}
      {(contact || b.lastContactDate) && <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{contact}{contact && b.lastContactDate ? ' · ' : ''}{b.lastContactDate ? `Last contact ${b.lastContactDate}` : ''}</div>}
      {b.notes && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>{b.notes}</div>}
    </div>
  )
}

function BrokerModal({ broker, onClose, onSaved }: { broker: Broker | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<BrokerInput>(() => broker ? { ...broker } : {
    name: '', firm: null, email: null, phone: null, markets: [], assetTypes: [], status: 'active', lastContactDate: null, notes: null, active: true,
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (p: Partial<BrokerInput>) => setF(s => ({ ...s, ...p }))
  const toggleAsset = (a: string) => set({ assetTypes: f.assetTypes.includes(a) ? f.assetTypes.filter(x => x !== a) : [...f.assetTypes, a] })
  const save = async () => {
    if (!f.name.trim()) { setErr('Broker needs a name.'); return }
    setBusy(true); setErr(null)
    try { if (broker) { await updateBroker(broker.id, f) } else { await createBroker(f) } onSaved() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Save failed') } finally { setBusy(false) }
  }
  const remove = async () => {
    if (!broker) return
    if (!confirm(`Delete broker "${broker.name}"?`)) return
    setBusy(true); setErr(null)
    try { await deleteBroker(broker.id); onSaved() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Delete failed') } finally { setBusy(false) }
  }
  return (
    <Overlay onClose={busy ? () => {} : onClose}>
      <div style={modal} onClick={e => e.stopPropagation()}>
        <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 12 }}>{broker ? `Edit ${broker.name}` : 'Add broker'}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <Field label="Name *" flex><input autoFocus value={f.name} onChange={e => set({ name: e.target.value })} style={inputStyle} /></Field>
            <Field label="Firm" flex><input value={f.firm ?? ''} onChange={e => set({ firm: e.target.value })} style={inputStyle} placeholder="CBRE / JLL / Eastdil" /></Field>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Field label="Email" flex><input value={f.email ?? ''} onChange={e => set({ email: e.target.value })} style={inputStyle} /></Field>
            <Field label="Phone" flex><input value={f.phone ?? ''} onChange={e => set({ phone: e.target.value })} style={inputStyle} /></Field>
            <Field label="Status" flex><select value={f.status} onChange={e => set({ status: e.target.value })} style={inputStyle}>{BROKER_STATUS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select></Field>
          </div>
          <Field label="Asset focus">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(ASSET_ORDER.concat(['industrial'] as AssetType[])).map(a => {
                const on = f.assetTypes.includes(a)
                return <button key={a} type="button" onClick={() => toggleAsset(a)} style={{ fontSize: 11.5, fontWeight: 600, padding: '4px 10px', borderRadius: 999, cursor: 'pointer', border: `1px solid ${on ? ASSET_COLOR[a] : 'var(--border-2)'}`, background: on ? ASSET_COLOR[a] : 'var(--surface)', color: on ? '#fff' : 'var(--text-muted)' }}>{ASSET_LABEL[a]}</button>
              })}
            </div>
          </Field>
          <div style={{ display: 'flex', gap: 10 }}>
            <Field label="Markets (comma)" flex><input value={f.markets.join(', ')} onChange={e => set({ markets: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} style={inputStyle} placeholder="Charlotte, Raleigh, Atlanta" /></Field>
            <Field label="Last contact" flex><input type="date" value={f.lastContactDate ?? ''} onChange={e => set({ lastContactDate: e.target.value || null })} style={inputStyle} /></Field>
          </div>
          <Field label="Notes"><input value={f.notes ?? ''} onChange={e => set({ notes: e.target.value })} style={inputStyle} /></Field>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--text-muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={f.active} onChange={e => set({ active: e.target.checked })} /> Active
          </label>
        </div>
        {err && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          {broker && <button style={{ ...ghostBtn, color: 'var(--red)', borderColor: 'var(--red)' }} disabled={busy} onClick={remove}>Delete</button>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button style={ghostBtn} onClick={onClose} disabled={busy}>Cancel</button>
            <button style={primaryBtn} onClick={save} disabled={busy}>{busy ? 'Saving…' : broker ? 'Save changes' : 'Add broker'}</button>
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
function DealDrawer({ deal, partners, team, buyBoxes, onClose, onChanged }: { deal: Deal; partners: CapitalPartner[]; team: TeamMember[]; buyBoxes: BuyBox[]; onClose: () => void; onChanged: () => void }) {
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
            <InvestmentSummaryButtons deal={deal} buyBoxes={buyBoxes} partners={partners} preparedBy={appUser?.full_name || appUser?.email || 'M&J Wilkow'} />
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

        {tab === 'overview' && <><StrategyFitPanel deal={deal} buyBoxes={buyBoxes} /><OverviewTab deal={deal} team={team} onSave={p => run(() => updateDeal(deal.id, p))} busy={busy} onDelete={() => run(async () => { await deleteDeal(deal.id); onClose() })} /></>}
        {tab === 'underwriting' && <UnderwritingTab deal={deal} busy={busy} onSaveModel={(mdl, c) => run(() => saveUnderwriting(deal.id, mdl, c))} />}
        {tab === 'capital' && <CapitalTab deal={deal} partners={partners} onChanged={onChanged} onDiscuss={lpId => { setDiscussLp(lpId); setTab('discussion') }} />}
        {tab === 'documents' && <DocumentsTab dealId={deal.id} dealName={deal.name} createdBy={appUser?.id ?? null} folderPath={deal.folderPath} folderFiles={deal.folderFiles} docs={docsQ.data ?? []} loading={docsQ.loading} refetch={docsQ.refetch} ddPropertyId={deal.ddPropertyId} />}
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
function MeetingDeckButton({ deals, buyBoxes, partners, preparedBy }: { deals: Deal[]; buyBoxes: BuyBox[]; partners: CapitalPartner[]; preparedBy: string }) {
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
        // Site plans are PRE-RENDERED to stored JPEGs (scripts/render_site_plans.ps1),
        // so we just fetch each image — fast and reliable, no client-side pdf.js.
        const extrasData = await fetchDeckExtras(deals.map(d => d.id))
        const sitePlanImgs: Record<string, { data: string; w: number; h: number }> = {}
        const toDataUrl = (b: Blob) => new Promise<string>((res, rej) => {
          const fr = new FileReader(); fr.onload = () => res(fr.result as string); fr.onerror = () => rej(fr.error); fr.readAsDataURL(b)
        })
        const dims = (url: string) => new Promise<{ w: number; h: number }>(res => {
          const im = new Image(); im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight }); im.onerror = () => res({ w: 1600, h: 1000 }); im.src = url
        })
        await Promise.all(extrasData.sitePlans.map(async sp => {
          try {
            const blob = await (await fetch(sp.url)).blob()
            const data = await toDataUrl(blob)
            sitePlanImgs[sp.dealId] = { data, ...(await dims(data)) }
          } catch (e) { console.warn('[meeting-deck] site-plan image failed:', sp.title ?? sp.dealId, e) }
        }))
        console.log(`[meeting-deck] site plans embedded ${Object.keys(sitePlanImgs).length}/${extrasData.sitePlans.length}`)
        // buy-box fit + top LP per deal (Phase 4 polish)
        const fit: Record<string, string> = {}
        if (buyBoxes.some(b => b.active) || partners.some(p => p.active)) {
          const mps: MatchPartner[] = partners.map(p => ({ id: p.id, name: p.name, tier: p.tier, productTypes: p.productTypes, markets: p.markets, returnTarget: p.returnTarget, dealSize: p.dealSize, active: p.active }))
          for (const d of deals) {
            const parts: string[] = []
            if (buyBoxes.some(b => b.active)) { const bf = bestFit(dealToFit(d), buyBoxes); if (bf) parts.push(FIT_LABEL[fitCategory(bf)]) }
            const md: MatchDeal = { assetType: d.assetType, state: d.state, market: d.market, submarket: d.submarket, askPrice: d.askPrice, projIrr: d.projIrr }
            const top = rankPartners(md, mps, new Set(d.lps.map(l => l.partnerId))).filter(m => m.score > 0).slice(0, 2).map(m => m.partner.name)
            if (top.length) parts.push('LPs: ' + top.join(', '))
            if (parts.length) fit[d.id] = parts.join('  ·  ')
          }
        }
        return buildPipelineMeetingDeck({
          deals,
          metrics: pipelineMetrics(deals),
          preparedBy,
          meetingDate,
          generatedAt: today.toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }),
          extras: { sitePlanImgs, tenants: extrasData.tenants, occupancy: extrasData.occupancy, fit },
        })
      }}
    />
  )
}

// "Investment Summary" — the firm's IC deliverable, generated from the deal in
// either format: a branded PDF or an EDITABLE PowerPoint modeled on the real
// Investment Summary deck (cover banner, disclaimer, exec summary + property
// table, rationale, tenancy, SWOT, capital & the ask). Both share one
// Recompute the LP/GP promote from a saved underwriting model (for the IC memo /
// Investment Summary). Returns null when the deal has no model or no promote set.
function promoteForMemo(um: UnderwritingModel | null | undefined) {
  if (!um || !um.promote) return null
  const closeDate = new Date().toISOString().slice(0, 10)
  const r: AcqResult = um.mode === 'tenant'
    ? underwriteTenant({
        glaSf: um.glaSf ?? 0, purchasePrice: um.purchasePrice, acqCostsPct: um.acqCostsPct, capexUpfront: um.capexUpfront,
        holdYears: um.holdYears, exitCapPct: um.exitCapPct, sellingCostsPct: um.sellingCostsPct,
        ltvPct: um.ltvPct, loanRatePct: um.loanRatePct, amortYears: um.amortYears,
        ioYears: um.ioYears, loanFeePct: um.loanFeePct, refi: um.refi ?? null, closeDate,
        leases: um.leases ?? [], rollover: um.rollover ?? D_ROLL, opex: um.opex ?? D_OPEX,
      })
    : underwrite({
        purchasePrice: um.purchasePrice, acqCostsPct: um.acqCostsPct, capexUpfront: um.capexUpfront,
        inPlaceNoi: um.inPlaceNoi, noiGrowthPct: um.noiGrowthPct, holdYears: um.holdYears,
        exitCapPct: um.exitCapPct, sellingCostsPct: um.sellingCostsPct,
        ltvPct: um.ltvPct, loanRatePct: um.loanRatePct, amortYears: um.amortYears,
        ioYears: um.ioYears, loanFeePct: um.loanFeePct, refi: um.refi ?? null, closeDate,
      })
  const p = computePromote(r.leveredFlows, um.promote)
  return {
    lpEquityPct: um.promote.lpEquityPct, prefRate: um.promote.prefRate,
    lpIrr: p.lpIrr, lpEm: p.lpEm, gpIrr: p.gpIrr, gpEm: p.gpEm,
    gpPromote: p.gpPromote, gpPromotePctOfProfit: p.gpPromotePctOfProfit,
  }
}

// AI-narrative fetch shape (ic-memo fn).
function InvestmentSummaryButtons({ deal, buyBoxes, partners, preparedBy }: { deal: Deal; buyBoxes: BuyBox[]; partners: CapitalPartner[]; preparedBy: string }) {
  const buildInput = async () => {
    const memo = await generateIcMemo(deal.id)
    const best = buyBoxes.some(b => b.active) ? bestFit(dealToFit(deal), buyBoxes) : null
    const md: MatchDeal = { assetType: deal.assetType, state: deal.state, market: deal.market, submarket: deal.submarket, askPrice: deal.askPrice, projIrr: deal.projIrr }
    const mps: MatchPartner[] = partners.map(p => ({ id: p.id, name: p.name, tier: p.tier, productTypes: p.productTypes, markets: p.markets, returnTarget: p.returnTarget, dealSize: p.dealSize, active: p.active }))
    const topLps = rankPartners(md, mps, new Set(deal.lps.map(l => l.partnerId))).filter(m => m.score > 0).slice(0, 4).map(m => m.partner.name)
    return {
      promote: promoteForMemo(deal.underwritingModel),
      strategyFit: best ? { category: FIT_LABEL[fitCategory(best)], buyBox: best.bb.name, score: Math.round(best.fit.score * 100) } : null,
      topLps,
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

function StrategyFitPanel({ deal, buyBoxes }: { deal: Deal; buyBoxes: BuyBox[] }) {
  if (!buyBoxes.some(b => b.active)) return null
  const best = bestFit(dealToFit(deal), buyBoxes)
  if (!best) return null
  const cat = fitCategory(best)
  const c = FIT_COLOR[cat]
  return (
    <div style={{ border: `1px solid ${c}55`, background: `${c}12`, borderRadius: 8, padding: '10px 12px', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: best.fit.checks.length ? 8 : 0 }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: c }}>{FIT_LABEL[cat]}</span>
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{best.bb.name} · {best.fit.passed}/{best.fit.applicable} criteria ({Math.round(best.fit.score * 100)}%){best.fit.disqualified ? ' · disqualified' : ''}</span>
      </div>
      {best.fit.checks.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {best.fit.checks.map((ck, i) => {
            const cc = ck.status === 'pass' ? '#2e8b57' : ck.status === 'fail' ? '#c0654e' : 'var(--text-faint)'
            const mk = ck.status === 'pass' ? '✓' : ck.status === 'fail' ? '✕' : '?'
            return <span key={i} title={ck.detail ? `Target: ${ck.detail}` : undefined} style={{ fontSize: 10.5, color: cc, border: `1px solid ${cc}44`, borderRadius: 6, padding: '2px 7px', background: 'var(--surface)' }}>{mk} {ck.label}{ck.hard ? '' : ''}</span>
          })}
        </div>
      )}
    </div>
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

type UwComputed = {
  projIrr: number | null; equityMultiple: number | null; avgCoc: number | null
  exitCap: number | null; holdYears: number | null; stabilizedYield: number | null
  equityRequired: number | null; totalCapitalization: number | null
}
// Underwriting tab — toggle between the Quick (direct-cap) model and the
// bottoms-up Tenant-level model; both compute in-browser and, on Save, write the
// returns to the deal (board / meeting deck / IC memo read them).
function UnderwritingTab({ deal, busy, onSaveModel }: { deal: Deal; busy: boolean; onSaveModel: (m: UnderwritingModel, c: UwComputed) => void }) {
  const [mode, setMode] = useState<'simple' | 'tenant'>(deal.underwritingModel?.mode === 'tenant' ? 'tenant' : 'simple')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', border: '1px solid var(--border-2)', borderRadius: 6, overflow: 'hidden', alignSelf: 'flex-start' }}>
        {(['simple', 'tenant'] as const).map(md => (
          <button key={md} onClick={() => setMode(md)} style={{ ...segBtn, background: mode === md ? 'var(--accent, #466371)' : 'var(--surface)', color: mode === md ? '#fff' : 'var(--text-muted)' }}>
            {md === 'simple' ? 'Quick (direct-cap)' : 'Tenant-level'}
          </button>
        ))}
      </div>
      {mode === 'simple'
        ? <SimpleUwEditor deal={deal} busy={busy} onSaveModel={onSaveModel} />
        : <TenantUwEditor deal={deal} busy={busy} onSaveModel={onSaveModel} />}
    </div>
  )
}

const uwIrrColor = (v: number | null) => v == null ? 'var(--text-faint)' : v >= 0.15 ? '#2e8b57' : v >= 0.10 ? 'var(--accent, #466371)' : v >= 0.07 ? 'var(--text)' : '#c0654e'
const gridInput: CSSProperties = { fontSize: 11.5, padding: '4px 6px', borderRadius: 5, border: '1px solid var(--border-2)', background: 'var(--surface)', color: 'var(--text)', width: '100%', boxSizing: 'border-box' }

function UwReturns({ r }: { r: AcqResult }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(115px, 1fr))', gap: 8 }}>
      <Fact label="Levered IRR" value={pct(r.leveredIrr)} tint={uwIrrColor(r.leveredIrr)} />
      <Fact label="Equity multiple" value={r.equityMultiple ? `${r.equityMultiple.toFixed(2)}x` : '—'} />
      <Fact label="Profit" value={fmtM(r.profit)} />
      <Fact label="Avg cash-on-cash" value={pct(r.avgCashOnCash)} />
      <Fact label="Unlevered IRR" value={pct(r.unleveredIrr)} />
      <Fact label="Equity" value={fmtM(r.equity)} />
      <Fact label="Going-in yield" value={pct(r.goingInYieldOnCostPct)} />
      <Fact label="Yield-on-cost (exit)" value={pct(r.stabilizedYieldOnCostPct)} />
      <Fact label="Value-add spread" value={pct(r.valueAddSpreadPct)} tint={r.valueAddSpreadPct >= 0.01 ? '#2e8b57' : r.valueAddSpreadPct < 0 ? '#c0654e' : 'var(--text)'} />
      <Fact label="DSCR (yr 1)" value={r.yearOneDscr != null ? `${r.yearOneDscr.toFixed(2)}x` : '—'} />
      <Fact label="Debt yield (yr 1)" value={pct(r.yearOneDebtYield)} />
    </div>
  )
}
// Reconcile the model's year-1 NOI against the OM's implied NOI (price x going-in
// cap). A large gap usually means missing recoverable OpEx / tenants / other income.
function UwReconciliation({ deal, modelNoi }: { deal: Deal; modelNoi: number }) {
  if (deal.askPrice == null || deal.goingInCap == null || deal.goingInCap <= 0) return null
  const omNoi = deal.askPrice * deal.goingInCap
  if (omNoi <= 0) return null
  const delta = (modelNoi - omNoi) / omNoi
  const off = Math.abs(delta) > 0.1
  return (
    <div style={{ border: `1px solid ${off ? '#c0654e' : 'var(--border)'}`, borderRadius: 8, background: off ? 'rgba(192,101,78,0.06)' : 'var(--surface-2, rgba(0,0,0,.03))', padding: '8px 11px', fontSize: 11.5 }}>
      <span style={{ fontWeight: 700, color: off ? '#c0654e' : 'var(--text-muted)' }}>{off ? '⚠ NOI reconciliation' : '✓ NOI reconciliation'}</span>{'  '}
      Model Yr-1 NOI <b>{fmtM(modelNoi)}</b> vs OM-implied <b>{fmtM(omNoi)}</b> ({deal.askPrice != null ? fmtM(deal.askPrice) : '—'} × {pct(deal.goingInCap)}) — Δ <b style={{ color: off ? '#c0654e' : 'var(--text)' }}>{(delta * 100).toFixed(0)}%</b>.
      {off ? ' Check recoverable OpEx, missing tenants, or other income before relying.' : ''}
    </div>
  )
}
// LP/GP promote: split the levered CF through the waterfall. Tier 1 is pari-passu
// to the pref; each promote tier gives the GP a larger share above its hurdle.
// UI convention: a hurdle of 0 means "residual / top tier" (stored as null).
function UwPromotePanel({ r, promote, onChange, busy }: { r: AcqResult; promote: UwPromote | undefined; onChange: (p: UwPromote) => void; busy: boolean }) {
  const p = promote ?? DEFAULT_PROMOTE
  const pr = useMemo(() => computePromote(r.leveredFlows, p), [r.leveredFlows, p])
  const gpEquityPct = Math.max(0, 1 - p.lpEquityPct)
  const em = (x: number | null) => (x != null && isFinite(x) ? `${x.toFixed(2)}x` : '—')
  const setTop = (patch: Partial<UwPromote>) => onChange({ ...p, ...patch })
  const setTier = (i: number, patch: Partial<UwPromoteTier>) => onChange({ ...p, tiers: p.tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)) })
  const addTier = () => onChange({ ...p, tiers: [...p.tiers, { hurdleIrr: null, gpPct: 0.3 }] })
  const delTier = (i: number) => onChange({ ...p, tiers: p.tiers.filter((_, j) => j !== i) })
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 11 }}>
      <SectionLabel2>LP / GP promote — {Math.round(p.lpEquityPct * 100)}/{Math.round(gpEquityPct * 100)} co-invest · {pct(p.prefRate)} pref pari-passu</SectionLabel2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(112px, 1fr))', gap: 8 }}>
        <Fact label="LP IRR" value={pct(pr.lpIrr)} tint={uwIrrColor(pr.lpIrr)} />
        <Fact label="LP multiple" value={em(pr.lpEm)} />
        <Fact label="LP profit" value={fmtM(pr.lpCash - pr.lpEquity)} />
        <Fact label="GP IRR" value={pct(pr.gpIrr)} tint={uwIrrColor(pr.gpIrr)} />
        <Fact label="GP multiple" value={em(pr.gpEm)} />
        <Fact label="GP promote" value={fmtM(pr.gpPromote)} tint={pr.gpPromote > 0 ? '#2e8b57' : 'var(--text)'} />
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
        GP earns {pct(pr.gpPromotePctOfProfit)} of profit as promote (deal levered IRR {pct(pr.dealLeveredIrr)}). LP equity {fmtM(pr.lpEquity)} · GP equity {fmtM(pr.gpEquity)}.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
        <MInput label="LP equity share" kind="pct" value={p.lpEquityPct} onChange={v => setTop({ lpEquityPct: Math.min(1, Math.max(0, v)) })} disabled={busy} />
        <MInput label="Pref (pari-passu)" kind="pct" value={p.prefRate} onChange={v => setTop({ prefRate: Math.max(0, v) })} disabled={busy} />
      </div>
      <div>
        <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 6 }}>Promote tiers (above pref · 0 hurdle = residual)</div>
        <table style={{ borderCollapse: 'collapse', fontSize: 11.5 }}>
          <thead><tr>{['Tier', 'To LP IRR', 'GP share', ''].map((h, i) => <th key={i} style={{ ...sgHead, textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>)}</tr></thead>
          <tbody>
            {p.tiers.map((t, i) => (
              <tr key={i}>
                <td style={{ ...sgCell, textAlign: 'left', color: 'var(--text-muted)' }}>{t.hurdleIrr == null ? 'Residual' : `Tier ${i + 1}`}</td>
                <td style={sgCell}><input value={t.hurdleIrr != null ? +(t.hurdleIrr * 100).toFixed(2) : ''} placeholder="residual" disabled={busy} onChange={e => setTier(i, { hurdleIrr: e.target.value === '' || Number(e.target.value) <= 0 ? null : (Number(e.target.value) || 0) / 100 })} style={{ ...gridInput, textAlign: 'right', width: 66 }} /></td>
                <td style={sgCell}><input value={+(t.gpPct * 100).toFixed(2)} disabled={busy} onChange={e => setTier(i, { gpPct: Math.min(1, Math.max(0, (Number(e.target.value) || 0) / 100)) })} style={{ ...gridInput, textAlign: 'right', width: 60 }} /></td>
                <td style={sgCell}><button style={miniX} disabled={busy} onClick={() => delTier(i)} title="Remove">✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button style={{ ...ghostBtn, marginTop: 8 }} disabled={busy} onClick={addTier}>+ Add tier</button>
      </div>
    </div>
  )
}
function UwSensitivity({ exitCaps, rows, irr, baseCol, baseRow }: { exitCaps: number[]; rows: number[]; irr: (number | null)[][]; baseCol: number; baseRow: number }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 11.5 }}>
        <thead><tr>
          <th style={sgHead}>growth \ exit</th>
          {exitCaps.map(ec => <th key={ec} style={sgHead}>{pct(ec, 2)}</th>)}
        </tr></thead>
        <tbody>
          {rows.map((g, gi) => (
            <tr key={g}>
              <td style={{ ...sgCell, fontWeight: 700, color: 'var(--text-muted)' }}>{pct(g, 1)}</td>
              {(irr[gi] ?? []).map((v, ci) => {
                const isBase = Math.abs(g - baseRow) < 1e-6 && Math.abs(exitCaps[ci] - baseCol) < 1e-6
                return <td key={ci} style={{ ...sgCell, color: uwIrrColor(v), fontWeight: isBase ? 800 : 500, background: isBase ? 'var(--surface-2, rgba(70,99,113,.08))' : undefined }}>{pct(v, 1)}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
const D_REFI: UwRefi = { yearsFromClose: 3, ltvPct: 0.65, ratePct: 0.065, amortYears: 30, ioYears: 0, costPct: 0.01, capPct: 0.065 }
// Optional mid-hold cash-out refinance editor (shared by both underwriting modes).
function UwRefiEditor({ refi, onChange, busy }: { refi: UwRefi | null; onChange: (r: UwRefi | null) => void; busy: boolean }) {
  const on = !!refi
  const r = refi ?? D_REFI
  const set = (k: keyof UwRefi) => (v: number) => onChange({ ...r, [k]: v })
  return (
    <div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', marginBottom: on ? 8 : 0 }}>
        <input type="checkbox" checked={on} disabled={busy} onChange={e => onChange(e.target.checked ? { ...D_REFI } : null)} />
        <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Cash-out refinance{on ? '' : ' (off)'}</span>
      </label>
      {on && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 }}>
          <MInput label="Refi year" kind="yr" value={r.yearsFromClose} onChange={set('yearsFromClose')} disabled={busy} />
          <MInput label="Refi LTV" kind="pct" value={r.ltvPct} onChange={set('ltvPct')} disabled={busy} />
          <MInput label="Refi cap (value)" kind="pct" value={r.capPct} onChange={set('capPct')} disabled={busy} />
          <MInput label="Refi rate" kind="pct" value={r.ratePct} onChange={set('ratePct')} disabled={busy} />
          <MInput label="Refi amort" kind="yr" value={r.amortYears} onChange={set('amortYears')} disabled={busy} />
          <MInput label="Refi IO (yrs)" kind="yr" value={r.ioYears} onChange={set('ioYears')} disabled={busy} />
          <MInput label="Refi cost" kind="pct" value={r.costPct} onChange={set('costPct')} disabled={busy} />
        </div>
      )}
    </div>
  )
}
function UwSaveBar({ busy, saved, onSave }: { busy: boolean; saved: boolean; onSave: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <button style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={onSave}>
        {busy ? 'Saving…' : saved ? 'Saved ✓' : 'Save underwrite'}
      </button>
      <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>Writes IRR / EM / CoC / exit cap / hold / equity to the deal. Sheet-owned price &amp; going-in cap are left untouched.</span>
    </div>
  )
}

function SimpleUwEditor({ deal, busy, onSaveModel }: { deal: Deal; busy: boolean; onSaveModel: (m: UnderwritingModel, c: UwComputed) => void }) {
  const um = deal.underwritingModel
  const seed: UnderwritingModel = {
    purchasePrice: um?.purchasePrice ?? deal.askPrice ?? 0, acqCostsPct: um?.acqCostsPct ?? 0.02, capexUpfront: um?.capexUpfront ?? 0,
    inPlaceNoi: um?.inPlaceNoi ?? ((deal.askPrice != null && deal.goingInCap != null) ? Math.round(deal.askPrice * deal.goingInCap) : 0),
    noiGrowthPct: um?.noiGrowthPct ?? 0.03, holdYears: um?.holdYears ?? deal.holdYears ?? 5,
    exitCapPct: um?.exitCapPct ?? deal.exitCap ?? deal.goingInCap ?? 0.065, sellingCostsPct: um?.sellingCostsPct ?? 0.02,
    ltvPct: um?.ltvPct ?? 0.6, loanRatePct: um?.loanRatePct ?? 0.065, amortYears: um?.amortYears ?? 30,
    ioYears: um?.ioYears ?? 0, loanFeePct: um?.loanFeePct ?? 0, refi: um?.refi ?? null,
    promote: um?.promote ?? DEFAULT_PROMOTE,
  }
  const [m, setM] = useState<UnderwritingModel>(seed)
  const [saved, setSaved] = useState(false)
  const set = (k: keyof UnderwritingModel) => (v: number) => { setM(p => ({ ...p, [k]: v })); setSaved(false) }
  const setPromote = (promote: UwPromote) => { setM(p => ({ ...p, promote })); setSaved(false) }
  const today = new Date().toISOString().slice(0, 10)
  const r = useMemo(() => underwrite({ ...m, closeDate: today, refi: m.refi }), [m, today])
  const exitCaps = useMemo(() => [-0.005, -0.0025, 0, 0.0025, 0.005].map(d => +(m.exitCapPct + d).toFixed(4)).filter(x => x > 0), [m.exitCapPct])
  const growths = useMemo(() => [-0.01, 0, 0.01, 0.02].map(d => +(m.noiGrowthPct + d).toFixed(4)).filter(x => x >= 0), [m.noiGrowthPct])
  const grid = useMemo(() => sensitivity({ ...m, closeDate: today }, exitCaps, growths), [m, today, exitCaps, growths])
  const computed: UwComputed = {
    projIrr: r.leveredIrr, equityMultiple: r.equityMultiple || null, avgCoc: r.avgCashOnCash,
    exitCap: m.exitCapPct, holdYears: m.holdYears, stabilizedYield: r.stabilizedYieldOnCostPct,
    equityRequired: Math.round(r.equity), totalCapitalization: Math.round(r.totalBasis),
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
        First-pass levered underwrite. Edit the assumptions; returns recompute live. <b>Save</b> writes them to the deal. {deal.underwritingModel ? '' : 'Seeded from the OM guidance / cap; tune before relying.'}
      </div>
      <UwReturns r={r} />
      <UwReconciliation deal={deal} modelNoi={r.yearlyNoi[0] ?? 0} />
      <div>
        <SectionLabel2>Assumptions</SectionLabel2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
          <MInput label="Purchase price" kind="usd" value={m.purchasePrice} onChange={set('purchasePrice')} disabled={busy} />
          <MInput label="In-place NOI (yr 1)" kind="usd" value={m.inPlaceNoi} onChange={set('inPlaceNoi')} disabled={busy} />
          <MInput label="NOI growth" kind="pct" value={m.noiGrowthPct} onChange={set('noiGrowthPct')} disabled={busy} />
          <MInput label="Hold" kind="yr" value={m.holdYears} onChange={set('holdYears')} disabled={busy} />
          <MInput label="Exit cap" kind="pct" value={m.exitCapPct} onChange={set('exitCapPct')} disabled={busy} />
          <MInput label="Selling costs" kind="pct" value={m.sellingCostsPct} onChange={set('sellingCostsPct')} disabled={busy} />
          <MInput label="Acq. costs" kind="pct" value={m.acqCostsPct} onChange={set('acqCostsPct')} disabled={busy} />
          <MInput label="Upfront capex" kind="usd" value={m.capexUpfront} onChange={set('capexUpfront')} disabled={busy} />
          <MInput label="LTV" kind="pct" value={m.ltvPct} onChange={set('ltvPct')} disabled={busy} />
          <MInput label="Loan rate" kind="pct" value={m.loanRatePct} onChange={set('loanRatePct')} disabled={busy} />
          <MInput label="Amort (0 = IO)" kind="yr" value={m.amortYears} onChange={set('amortYears')} disabled={busy} />
          <MInput label="IO years" kind="yr" value={m.ioYears ?? 0} onChange={set('ioYears')} disabled={busy} />
          <MInput label="Loan fee" kind="pct" value={m.loanFeePct ?? 0} onChange={set('loanFeePct')} disabled={busy} />
        </div>
      </div>
      <UwRefiEditor refi={m.refi ?? null} onChange={refi => { setM(p => ({ ...p, refi })); setSaved(false) }} busy={busy} />
      <UwPromotePanel r={r} promote={m.promote} onChange={setPromote} busy={busy} />
      <div>
        <SectionLabel2>Levered IRR — exit cap (cols) &times; NOI growth (rows)</SectionLabel2>
        <UwSensitivity exitCaps={exitCaps} rows={growths} irr={grid.leveredIrr} baseCol={m.exitCapPct} baseRow={m.noiGrowthPct} />
      </div>
      <UwSaveBar busy={busy} saved={saved} onSave={() => { onSaveModel({ ...m, mode: 'simple' }, computed); setSaved(true) }} />
    </div>
  )
}

const D_ROLL: UwRollover = { renewalProbPct: 0.7, marketRentPsf: 0, marketRentGrowthPct: 0.03, downtimeMonths: 6, tiNewPsf: 30, tiRenewPsf: 10, lcNewPsf: 15, lcRenewPsf: 5, freeRentMonthsNew: 3, releaseTermYears: 7 }
const D_OPEX: UwOpex = { recoverableOpexPsf: 0, taxInsurancePsf: 0, nonRecoverableOpexPsf: 0, opexGrowthPct: 0.03, generalVacancyPct: 0, creditLossPct: 0.005, capitalReservePsf: 0.25, otherIncomePsf: 0 }

function TenantUwEditor({ deal, busy, onSaveModel }: { deal: Deal; busy: boolean; onSaveModel: (m: UnderwritingModel, c: UwComputed) => void }) {
  const um = deal.underwritingModel
  const seed: UnderwritingModel = {
    purchasePrice: um?.purchasePrice ?? deal.askPrice ?? 0, acqCostsPct: um?.acqCostsPct ?? 0.02, capexUpfront: um?.capexUpfront ?? 0,
    inPlaceNoi: 0, noiGrowthPct: 0.03, holdYears: um?.holdYears ?? deal.holdYears ?? 5,
    exitCapPct: um?.exitCapPct ?? deal.exitCap ?? deal.goingInCap ?? 0.065, sellingCostsPct: um?.sellingCostsPct ?? 0.02,
    ltvPct: um?.ltvPct ?? 0.6, loanRatePct: um?.loanRatePct ?? 0.065, amortYears: um?.amortYears ?? 30,
    ioYears: um?.ioYears ?? 0, loanFeePct: um?.loanFeePct ?? 0, refi: um?.refi ?? null,
    mode: 'tenant', glaSf: um?.glaSf ?? deal.glaSf ?? 0,
    leases: um?.leases ?? [], rollover: { ...D_ROLL, ...(um?.rollover ?? {}) }, opex: { ...D_OPEX, ...(um?.opex ?? {}) },
    promote: um?.promote ?? DEFAULT_PROMOTE,
  }
  const [m, setM] = useState<UnderwritingModel>(seed)
  const [saved, setSaved] = useState(false)
  const today = new Date().toISOString().slice(0, 10)
  const leases = m.leases ?? []
  const roll = m.rollover ?? D_ROLL
  const opex = m.opex ?? D_OPEX
  const setF = (k: keyof UnderwritingModel) => (v: number) => { setM(p => ({ ...p, [k]: v })); setSaved(false) }
  const setRoll = (k: keyof UwRollover) => (v: number) => { setM(p => ({ ...p, rollover: { ...(p.rollover ?? D_ROLL), [k]: v } })); setSaved(false) }
  const setOpex = (k: keyof UwOpex) => (v: number) => { setM(p => ({ ...p, opex: { ...(p.opex ?? D_OPEX), [k]: v } })); setSaved(false) }
  const updLease = (i: number, patch: Partial<UwLeaseLine>) => { setM(p => { const ls = [...(p.leases ?? [])]; ls[i] = { ...ls[i], ...patch }; return { ...p, leases: ls } }); setSaved(false) }
  const addLease = () => { setM(p => ({ ...p, leases: [...(p.leases ?? []), { name: 'New tenant', sf: 0, baseRentPsf: 0, annualBumpPct: 0.03, termRemainingYears: 5, recovery: 'nnn' } as UwLeaseLine] })); setSaved(false) }
  const delLease = (i: number) => { setM(p => ({ ...p, leases: (p.leases ?? []).filter((_, j) => j !== i) })); setSaved(false) }

  const model = {
    glaSf: m.glaSf ?? 0, purchasePrice: m.purchasePrice, acqCostsPct: m.acqCostsPct, capexUpfront: m.capexUpfront,
    holdYears: m.holdYears, exitCapPct: m.exitCapPct, sellingCostsPct: m.sellingCostsPct,
    ltvPct: m.ltvPct, loanRatePct: m.loanRatePct, amortYears: m.amortYears,
    ioYears: m.ioYears, loanFeePct: m.loanFeePct, refi: m.refi, closeDate: today,
    leases: leases as any, rollover: roll as any, opex: opex as any,
  }
  const r = useMemo(() => underwriteTenant(model), [m, today])
  const exitCaps = useMemo(() => [-0.005, -0.0025, 0, 0.0025, 0.005].map(d => +(m.exitCapPct + d).toFixed(4)).filter(x => x > 0), [m.exitCapPct])
  const growths = useMemo(() => [-0.01, 0, 0.01, 0.02].map(d => +(roll.marketRentGrowthPct + d).toFixed(4)).filter(x => x >= 0), [roll.marketRentGrowthPct])
  const irrGrid = useMemo(() => growths.map(g => exitCaps.map(ec =>
    underwriteTenant({ ...model, exitCapPct: ec, rollover: { ...roll, marketRentGrowthPct: g } as any }).leveredIrr)), [m, today, exitCaps, growths])

  const totalSf = leases.reduce((s, l) => s + (l.sf || 0), 0)
  const computed: UwComputed = {
    projIrr: r.leveredIrr, equityMultiple: r.equityMultiple || null, avgCoc: r.avgCashOnCash,
    exitCap: m.exitCapPct, holdYears: m.holdYears, stabilizedYield: r.stabilizedYieldOnCostPct,
    equityRequired: Math.round(r.equity), totalCapitalization: Math.round(r.totalBasis),
  }
  const recCell: CSSProperties = { ...sgCell, textAlign: 'right', color: 'var(--text-muted)' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
        Bottoms-up lease-by-lease underwrite (NNN recoveries, blended rollover, TI/LC, forward-NOI exit). {leases.length ? '' : 'No rent roll yet — run enrich_deal.ps1 -Deal "' + deal.name + '" to auto-populate from the rent roll, or add tenants below.'}
      </div>
      <UwReturns r={r} />
      <UwReconciliation deal={deal} modelNoi={r.yearlyNoi[0] ?? 0} />

      {/* rent roll */}
      <div>
        <SectionLabel2>Rent roll ({leases.length} tenants · {Math.round(totalSf).toLocaleString()} SF{m.glaSf ? ` of ${Math.round(m.glaSf).toLocaleString()} GLA` : ''})</SectionLabel2>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 11.5, width: '100%' }}>
            <thead><tr>{['Tenant', 'SF', 'Base $/SF', 'Bump %', 'Term (yrs)', 'Recovery', 'Sales $/SF', '% rent', 'Base-yr $/SF', ''].map((h, i) => <th key={i} style={{ ...sgHead, textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>)}</tr></thead>
            <tbody>
              {leases.map((l, i) => (
                <tr key={i}>
                  <td style={{ ...sgCell, minWidth: 130 }}><input value={l.name} disabled={busy} onChange={e => updLease(i, { name: e.target.value })} style={gridInput} /></td>
                  <td style={sgCell}><input value={l.sf} disabled={busy} onChange={e => updLease(i, { sf: Number(e.target.value) || 0 })} style={{ ...gridInput, textAlign: 'right', width: 80 }} /></td>
                  <td style={sgCell}><input value={l.baseRentPsf} disabled={busy} onChange={e => updLease(i, { baseRentPsf: Number(e.target.value) || 0 })} style={{ ...gridInput, textAlign: 'right', width: 70 }} /></td>
                  <td style={sgCell}><input value={+(l.annualBumpPct * 100).toFixed(2)} disabled={busy} onChange={e => updLease(i, { annualBumpPct: (Number(e.target.value) || 0) / 100 })} style={{ ...gridInput, textAlign: 'right', width: 55 }} /></td>
                  <td style={sgCell}><input value={l.termRemainingYears} disabled={busy} onChange={e => updLease(i, { termRemainingYears: Number(e.target.value) || 0 })} style={{ ...gridInput, textAlign: 'right', width: 55 }} /></td>
                  <td style={sgCell}><select value={l.recovery} disabled={busy} onChange={e => updLease(i, { recovery: e.target.value as UwLeaseLine['recovery'] })} style={{ ...gridInput, width: 80 }}><option value="nnn">NNN</option><option value="gross">Gross</option><option value="base_year">Base-yr</option></select></td>
                  <td style={sgCell}><input value={l.salesPsf ?? ''} placeholder="—" disabled={busy} onChange={e => updLease(i, { salesPsf: e.target.value === '' ? undefined : (Number(e.target.value) || 0) })} style={{ ...gridInput, textAlign: 'right', width: 62 }} /></td>
                  <td style={sgCell}><input value={l.pctRentRate != null ? +(l.pctRentRate * 100).toFixed(2) : ''} placeholder="—" disabled={busy} onChange={e => updLease(i, { pctRentRate: e.target.value === '' ? undefined : (Number(e.target.value) || 0) / 100 })} style={{ ...gridInput, textAlign: 'right', width: 48 }} /></td>
                  <td style={sgCell}><input value={l.baseYearOpexPsf ?? ''} placeholder={l.recovery === 'base_year' ? 'yr1' : '—'} disabled={busy} onChange={e => updLease(i, { baseYearOpexPsf: e.target.value === '' ? undefined : (Number(e.target.value) || 0) })} style={{ ...gridInput, textAlign: 'right', width: 62 }} /></td>
                  <td style={sgCell}><button style={miniX} disabled={busy} onClick={() => delLease(i)} title="Remove">✕</button></td>
                </tr>
              ))}
              {leases.length === 0 && <tr><td colSpan={10} style={{ ...sgCell, textAlign: 'center', color: 'var(--text-faint)' }}>No tenants yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <button style={{ ...ghostBtn, marginTop: 8 }} disabled={busy} onClick={addLease}>+ Add tenant</button>
      </div>

      {/* NOI by year */}
      <div>
        <SectionLabel2>NOI by year</SectionLabel2>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 11.5 }}>
            <thead><tr>{['Year', 'Base rent', 'Recoveries', '% rent', 'OpEx', 'Vac/credit', 'NOI', 'Capital', 'DSCR', 'Debt yld'].map((h, i) => <th key={i} style={{ ...sgHead, textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>)}</tr></thead>
            <tbody>
              {r.breakdown.map(b => (
                <tr key={b.year}>
                  <td style={{ ...sgCell, textAlign: 'left', fontWeight: 700, color: 'var(--text-muted)' }}>Yr {b.year}</td>
                  <td style={recCell}>{fmtM(b.baseRent)}</td>
                  <td style={recCell}>{fmtM(b.recoveries)}</td>
                  <td style={recCell}>{b.pctRent ? fmtM(b.pctRent) : '—'}</td>
                  <td style={recCell}>{fmtM(-b.opex)}</td>
                  <td style={recCell}>{fmtM(-b.vacancyCredit)}</td>
                  <td style={{ ...sgCell, textAlign: 'right', fontWeight: 700, color: 'var(--text)' }}>{fmtM(b.noi)}</td>
                  <td style={recCell}>{b.capital ? fmtM(-b.capital) : '—'}</td>
                  <td style={recCell}>{r.dscrByYear[b.year - 1] != null ? r.dscrByYear[b.year - 1]!.toFixed(2) + 'x' : '—'}</td>
                  <td style={recCell}>{pct(r.debtYieldByYear[b.year - 1])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* market leasing assumptions */}
      <div>
        <SectionLabel2>Market leasing (rollover)</SectionLabel2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
          <MInput label="Renewal prob." kind="pct" value={roll.renewalProbPct} onChange={setRoll('renewalProbPct')} disabled={busy} />
          <MInput label="Market rent" kind="usd" value={roll.marketRentPsf} onChange={setRoll('marketRentPsf')} disabled={busy} />
          <MInput label="Mkt rent growth" kind="pct" value={roll.marketRentGrowthPct} onChange={setRoll('marketRentGrowthPct')} disabled={busy} />
          <MInput label="Downtime (mo)" kind="yr" value={roll.downtimeMonths} onChange={setRoll('downtimeMonths')} disabled={busy} />
          <MInput label="TI new $/SF" kind="usd" value={roll.tiNewPsf} onChange={setRoll('tiNewPsf')} disabled={busy} />
          <MInput label="TI renew $/SF" kind="usd" value={roll.tiRenewPsf} onChange={setRoll('tiRenewPsf')} disabled={busy} />
          <MInput label="LC new $/SF" kind="usd" value={roll.lcNewPsf} onChange={setRoll('lcNewPsf')} disabled={busy} />
          <MInput label="LC renew $/SF" kind="usd" value={roll.lcRenewPsf} onChange={setRoll('lcRenewPsf')} disabled={busy} />
          <MInput label="Free rent (mo)" kind="yr" value={roll.freeRentMonthsNew} onChange={setRoll('freeRentMonthsNew')} disabled={busy} />
          <MInput label="Re-lease term (yrs)" kind="yr" value={roll.releaseTermYears ?? 7} onChange={setRoll('releaseTermYears')} disabled={busy} />
        </div>
      </div>

      {/* opex + financing */}
      <div>
        <SectionLabel2>Operating expenses &amp; financing</SectionLabel2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
          <MInput label="Controllable CAM $/SF" kind="usd" value={opex.recoverableOpexPsf} onChange={setOpex('recoverableOpexPsf')} disabled={busy} />
          <MInput label="Tax + insurance $/SF" kind="usd" value={opex.taxInsurancePsf ?? 0} onChange={setOpex('taxInsurancePsf')} disabled={busy} />
          <MInput label="Tax/ins growth" kind="pct" value={opex.taxInsuranceGrowthPct ?? opex.opexGrowthPct} onChange={setOpex('taxInsuranceGrowthPct')} disabled={busy} />
          <MInput label="Non-recov OpEx $/SF" kind="usd" value={opex.nonRecoverableOpexPsf} onChange={setOpex('nonRecoverableOpexPsf')} disabled={busy} />
          <MInput label="OpEx growth" kind="pct" value={opex.opexGrowthPct} onChange={setOpex('opexGrowthPct')} disabled={busy} />
          <MInput label="Gen. vacancy" kind="pct" value={opex.generalVacancyPct} onChange={setOpex('generalVacancyPct')} disabled={busy} />
          <MInput label="Credit loss" kind="pct" value={opex.creditLossPct} onChange={setOpex('creditLossPct')} disabled={busy} />
          <MInput label="Reserves $/SF" kind="usd" value={opex.capitalReservePsf} onChange={setOpex('capitalReservePsf')} disabled={busy} />
          <MInput label="Other income $/SF" kind="usd" value={opex.otherIncomePsf ?? 0} onChange={setOpex('otherIncomePsf')} disabled={busy} />
          <MInput label="CAM admin fee" kind="pct" value={opex.adminFeePct ?? 0} onChange={setOpex('adminFeePct')} disabled={busy} />
          <MInput label="Gross-up occ." kind="pct" value={opex.grossUpPct ?? 0} onChange={setOpex('grossUpPct')} disabled={busy} />
          <MInput label="Sales growth" kind="pct" value={opex.salesGrowthPct ?? opex.opexGrowthPct} onChange={setOpex('salesGrowthPct')} disabled={busy} />
          <MInput label="GLA (SF)" kind="usd" value={m.glaSf ?? 0} onChange={setF('glaSf')} disabled={busy} />
          <MInput label="Purchase price" kind="usd" value={m.purchasePrice} onChange={setF('purchasePrice')} disabled={busy} />
          <MInput label="Hold" kind="yr" value={m.holdYears} onChange={setF('holdYears')} disabled={busy} />
          <MInput label="Exit cap" kind="pct" value={m.exitCapPct} onChange={setF('exitCapPct')} disabled={busy} />
          <MInput label="LTV" kind="pct" value={m.ltvPct} onChange={setF('ltvPct')} disabled={busy} />
          <MInput label="Loan rate" kind="pct" value={m.loanRatePct} onChange={setF('loanRatePct')} disabled={busy} />
          <MInput label="Amort (0 = IO)" kind="yr" value={m.amortYears} onChange={setF('amortYears')} disabled={busy} />
          <MInput label="IO years" kind="yr" value={m.ioYears ?? 0} onChange={setF('ioYears')} disabled={busy} />
          <MInput label="Loan fee" kind="pct" value={m.loanFeePct ?? 0} onChange={setF('loanFeePct')} disabled={busy} />
        </div>
      </div>

      {/* controllable-CAM recovery cap: tenants pay capped growth, landlord absorbs the rest */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
          <input type="checkbox" checked={opex.recoveryCapPct != null} disabled={busy}
            onChange={e => setOpex('recoveryCapPct')((e.target.checked ? 0.05 : undefined) as unknown as number)} />
          <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
            Cap controllable recovery growth{opex.recoveryCapPct != null ? ' (tax + insurance stay uncapped)' : ' (off)'}
          </span>
        </label>
        {opex.recoveryCapPct != null &&
          <div style={{ width: 150 }}><MInput label="Recovery cap / yr" kind="pct" value={opex.recoveryCapPct} onChange={setOpex('recoveryCapPct')} disabled={busy} /></div>}
      </div>

      <UwRefiEditor refi={m.refi ?? null} onChange={refi => { setM(p => ({ ...p, refi })); setSaved(false) }} busy={busy} />
      <UwPromotePanel r={r} promote={m.promote} onChange={promote => { setM(p => ({ ...p, promote })); setSaved(false) }} busy={busy} />

      <div>
        <SectionLabel2>Levered IRR — exit cap (cols) &times; market-rent growth (rows)</SectionLabel2>
        <UwSensitivity exitCaps={exitCaps} rows={growths} irr={irrGrid} baseCol={m.exitCapPct} baseRow={roll.marketRentGrowthPct} />
      </div>

      <UwSaveBar busy={busy} saved={saved} onSave={() => { onSaveModel({ ...m, mode: 'tenant' }, computed); setSaved(true) }} />
    </div>
  )
}
function SectionLabel2({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 7 }}>{children}</div>
}
const sgHead: CSSProperties = { padding: '4px 9px', fontSize: 10.5, color: 'var(--text-faint)', fontWeight: 700, border: '1px solid var(--border)', textAlign: 'right', whiteSpace: 'nowrap' }
const sgCell: CSSProperties = { padding: '4px 9px', border: '1px solid var(--border)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
// controlled numeric input for the underwriting model (local text, commit on blur)
function MInput({ label, kind, value, onChange, disabled }: { label: string; kind: 'usd' | 'pct' | 'yr'; value: number; onChange: (v: number) => void; disabled?: boolean }) {
  const disp = kind === 'pct' ? String(+(value * 100).toFixed(2)) : kind === 'usd' ? String(Math.round(value)) : String(value)
  const [t, setT] = useState(disp)
  const commit = () => {
    const n = Number(t.replace(/[,$\s]/g, ''))
    if (!isFinite(n)) { setT(disp); return }
    onChange(kind === 'pct' ? n / 100 : n)
  }
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{label}{kind === 'pct' ? ' (%)' : kind === 'usd' ? ' ($)' : ''}</span>
      <input value={t} disabled={disabled} onChange={e => setT(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        inputMode="decimal" style={{ ...inputStyle, textAlign: 'right' }} />
    </label>
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
  const matches = useMemo(() => {
    const md: MatchDeal = { assetType: deal.assetType, state: deal.state, market: deal.market, submarket: deal.submarket, askPrice: deal.askPrice, projIrr: deal.projIrr }
    const mps: MatchPartner[] = partners.map(p => ({ id: p.id, name: p.name, tier: p.tier, productTypes: p.productTypes, markets: p.markets, returnTarget: p.returnTarget, dealSize: p.dealSize, active: p.active }))
    return rankPartners(md, mps, new Set(deal.lps.map(l => l.partnerId))).filter(m => m.score > 0).slice(0, 5)
  }, [deal, partners])

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
          {matches.map(m => (
            <div key={m.partner.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '5px 0', flexWrap: 'wrap' }}>
              <b style={{ color: 'var(--text)' }}>{m.partner.name}</b>
              <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: m.partner.tier === 'current' ? '#2e8b57' : 'var(--text-faint)' }}>{PARTNER_TIER_LABEL[m.partner.tier]}</span>
              <span style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {m.signals.filter(s => s.status !== 'na').map((s, i) => {
                  const c = s.status === 'hit' ? '#2e8b57' : '#c0654e'
                  return <span key={i} title={s.detail} style={{ fontSize: 10, color: c, border: `1px solid ${c}44`, borderRadius: 5, padding: '1px 6px' }}>{s.status === 'hit' ? '✓' : '✕'} {s.label}</span>
                })}
              </span>
              <button style={{ ...ghostBtn, padding: '3px 9px', fontSize: 11, marginLeft: 'auto' }} disabled={busy} onClick={() => run(() => addDealLp(deal.id, m.partner.id))}>Add</button>
            </div>
          ))}
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 6 }}>Ranked by mandate fit — product type, deal size, return target, geography, and relationship tier from the Partner book.</div>
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

function DocumentsTab({ dealId, dealName, createdBy, folderPath, folderFiles, docs, loading, refetch, ddPropertyId }: { dealId: string; dealName: string; createdBy: string | null; folderPath: string | null; folderFiles: { name: string; dir: boolean }[] | null; docs: DealDoc[]; loading: boolean; refetch: () => void; ddPropertyId: string | null }) {
  const enrichCmd = `.\\scripts\\enrich_deal.ps1 -Deal "${dealName}"`
  const [cmdCopied, setCmdCopied] = useState(false)
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
      {/* one-command per-deal enrichment (pulls folder info; runs locally — the web app can't reach K:\) */}
      <div style={{ border: `1px solid ${folderPath ? 'var(--border)' : 'var(--accent, #466371)'}`, borderRadius: 9, background: folderPath ? 'var(--surface-2, rgba(0,0,0,.03))' : 'rgba(70, 99, 113, 0.06)', padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: folderPath ? 'var(--text-faint)' : 'var(--accent, #466371)' }}>⤓ Pull folder info{folderPath ? ' · re-run' : ''}</span>
          <button style={{ ...ghostBtn, padding: '3px 9px', fontSize: 11, marginLeft: 'auto' }} onClick={() => { navigator.clipboard?.writeText(enrichCmd); setCmdCopied(true); setTimeout(() => setCmdCopied(false), 2000) }}>{cmdCopied ? 'Copied ✓' : 'Copy command'}</button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text)', fontFamily: 'monospace', wordBreak: 'break-all', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 5, padding: '6px 8px' }}>{enrichCmd}</div>
        <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 8 }}>
          {folderPath
            ? 'Re-run in PowerShell (cre-platform folder, office PC) to refresh from the deal folder — mirrors new docs and fills any blank fields. Safe to re-run.'
            : 'New deal — run this in PowerShell from the cre-platform folder on the office PC to link the K:\\ACQUISITIONS folder and pull in the OM facts, tenant roster, site plan and return metrics.'}
        </div>
      </div>
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
