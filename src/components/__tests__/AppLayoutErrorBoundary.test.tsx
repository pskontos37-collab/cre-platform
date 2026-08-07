// @vitest-environment jsdom
// Wiring test, not a logic test. ErrorBoundary.test.tsx proves the boundary
// behaves; this proves it is actually MOUNTED where it matters — inside
// AppLayout, so a page that throws leaves the shell navigable instead of
// blanking the pane. A unit test of the component alone would still pass if
// someone removed the wrapper from AppLayout, which is the regression worth
// catching.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AppLayout } from '../layout/AppLayout'

// Sidebar/Header/AbstractJobsToaster reach for auth + Supabase; stub them so
// this test stays about the boundary wiring and does not become a DB test.
vi.mock('../layout/Sidebar', () => ({ Sidebar: () => <nav>sidebar-stub</nav> }))
vi.mock('../layout/Header', () => ({ Header: () => <header>header-stub</header> }))
vi.mock('../abstracts/AbstractJobsToaster', () => ({ AbstractJobsToaster: () => null }))

let spy: ReturnType<typeof vi.spyOn>
beforeEach(() => { spy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { spy.mockRestore(); cleanup() })

function Boom(): JSX.Element {
  throw new Error('page blew up')
}

describe('AppLayout error containment', () => {
  it('keeps the shell usable when the page throws', () => {
    render(
      <MemoryRouter initialEntries={['/pcf']}>
        <AppLayout><Boom /></AppLayout>
      </MemoryRouter>,
    )

    // The failure is reported...
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('page blew up')

    // ...and crucially the navigation shell is STILL THERE, which is the whole
    // point: the user can get to a working page without reloading.
    expect(screen.getByText('sidebar-stub')).toBeTruthy()
    expect(screen.getByText('header-stub')).toBeTruthy()
  })

  it('renders page content normally when nothing throws', () => {
    render(
      <MemoryRouter initialEntries={['/pcf']}>
        <AppLayout><div>healthy page</div></AppLayout>
      </MemoryRouter>,
    )
    expect(screen.getByText('healthy page')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
