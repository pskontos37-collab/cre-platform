import { Widget, WidgetSkeleton } from '../ui/Widget'
import { EmptyState } from '../ui/EmptyState'
import { useOccupancy } from '../../hooks/useDashboard'

const fmtPct = (n: number) => (n * 100).toFixed(1) + '%'
const fmtSF = (n: number) => n.toLocaleString() + ' SF'

interface OccupancyWidgetProps {
  propertyIds: string[]
  propertyNames: Record<string, string>
}

export function OccupancyWidget({ propertyIds, propertyNames }: OccupancyWidgetProps) {
  const { data, loading, error } = useOccupancy(propertyIds, propertyNames)

  return (
    <Widget title="Occupancy" chip={data ? fmtSF(data.totalSf) : undefined}>
      {loading && <WidgetSkeleton rows={3} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && !data && <EmptyState title="No unit data" subtitle="Add units to see occupancy" />}
      {!loading && !error && data && (
        <div>
          {/* Big headline number */}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 2 }}>Physical Occupancy</div>
              <div style={{ fontSize: 32, fontWeight: 800, color: occupancyColor(data.physicalPct), lineHeight: 1 }}>
                {fmtPct(data.physicalPct)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
                {fmtSF(data.occupiedSf)} occupied / {fmtSF(data.totalSf)} total
              </div>
            </div>
            {/* Progress bar */}
            <div style={{ flex: 1, marginBottom: 4 }}>
              <OccBar pct={data.physicalPct} />
            </div>
          </div>

          {/* Per-property breakdown */}
          {data.byProperty.length > 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-faint)', marginBottom: 4 }}>
                By Property
              </div>
              {data.byProperty.map(p => (
                <div key={p.propertyId} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 140, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.propertyName}
                  </div>
                  <div style={{ flex: 1 }}>
                    <OccBar pct={p.physicalPct} height={5} />
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: occupancyColor(p.physicalPct), minWidth: 48, textAlign: 'right' }}>
                    {fmtPct(p.physicalPct)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Widget>
  )
}

function occupancyColor(pct: number) {
  if (pct >= 0.90) return 'var(--green)'
  if (pct >= 0.75) return 'var(--amber)'
  return 'var(--red)'
}

function OccBar({ pct, height = 8 }: { pct: number; height?: number }) {
  return (
    <div style={{ background: 'var(--surface-2)', borderRadius: 99, height, overflow: 'hidden' }}>
      <div
        style={{
          width:        `${Math.min(pct * 100, 100)}%`,
          height:       '100%',
          background:   occupancyColor(pct),
          borderRadius: 99,
          transition:   'width 0.4s ease',
        }}
      />
    </div>
  )
}
