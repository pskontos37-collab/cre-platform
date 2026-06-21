import { AppLayout } from '../components/layout/AppLayout'
import { useProperties } from '../hooks/useProperties'
import { useFilteredPropertyIds, usePropertyNameMap } from '../hooks/useFilteredPropertyIds'

import { NOIWidget } from '../components/dashboard/NOIWidget'
import { DSCRWidget } from '../components/dashboard/DSCRWidget'
import { OccupancyWidget } from '../components/dashboard/OccupancyWidget'
import { LeaseRolloverWidget } from '../components/dashboard/LeaseRolloverWidget'
import { CriticalDatesWidget } from '../components/dashboard/CriticalDatesWidget'
import { CoTenancyWidget } from '../components/dashboard/CoTenancyWidget'
import { TenantConcentrationWidget } from '../components/dashboard/TenantConcentrationWidget'
import { DelinquencyWidget } from '../components/dashboard/DelinquencyWidget'
import { CAMReconWidget } from '../components/dashboard/CAMReconWidget'
import { PercentageRentWidget } from '../components/dashboard/PercentageRentWidget'

export default function DashboardPage() {
  const { data: properties } = useProperties()
  const propertyIds = useFilteredPropertyIds(properties ?? null)
  const propertyNames = usePropertyNameMap(properties ?? null)

  return (
    <AppLayout>
      <div
        style={{
          display:             'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
          gap:                 16,
        }}
      >
        {/* Full-width alerts first */}
        {(properties ?? []).length > 0 && (
          <CoTenancyWidget propertyIds={propertyIds} propertyNames={propertyNames} />
        )}

        {/* Core financial metrics */}
        <NOIWidget propertyIds={propertyIds} />
        <DSCRWidget propertyIds={propertyIds} propertyNames={propertyNames} />

        {/* Leasing */}
        <OccupancyWidget propertyIds={propertyIds} propertyNames={propertyNames} />
        <LeaseRolloverWidget propertyIds={propertyIds} />

        {/* Operational */}
        <CriticalDatesWidget propertyIds={propertyIds} propertyNames={propertyNames} />
        <DelinquencyWidget propertyIds={propertyIds} propertyNames={propertyNames} />

        {/* Retail-specific */}
        <CAMReconWidget propertyIds={propertyIds} propertyNames={propertyNames} />
        <PercentageRentWidget propertyIds={propertyIds} propertyNames={propertyNames} />

        {/* Full-width tenant table */}
        <TenantConcentrationWidget propertyIds={propertyIds} propertyNames={propertyNames} />
      </div>
    </AppLayout>
  )
}
