import { describe, it, expect } from 'vitest'
// Pure property-access decisions, shared verbatim with the Deno edge functions
// via _shared/auth.ts. Locks in the audit finding-#5 contract: "may view" is a
// DIFFERENT question from "may change", and company-wide (null-property)
// targets are readable by all staff but writable only by full-access callers.
import { canReadProperty, canWriteProperty } from '../../../supabase/functions/_shared/access'
import type { CallerScope } from '../../../supabase/functions/_shared/access'

const P1 = 'prop-1'
const P2 = 'prop-2'

const service: CallerScope = { isPrivileged: true, access: 'all' }          // service token / admin / AM
const globalGrant: CallerScope = { isPrivileged: false, access: 'all' }     // staff with a global entitlement
const scoped: CallerScope = { isPrivileged: false, access: new Set([P1]) }  // staff scoped to P1
const noAccess: CallerScope = { isPrivileged: false, access: new Set() }    // staff with no grants

describe('canReadProperty', () => {
  it('full-access callers read everything', () => {
    expect(canReadProperty(service, P1)).toBe(true)
    expect(canReadProperty(service, null)).toBe(true)
    expect(canReadProperty(globalGrant, P2)).toBe(true)
  })
  it('company-wide (null property) data is readable by every staffer', () => {
    expect(canReadProperty(scoped, null)).toBe(true)
    expect(canReadProperty(noAccess, null)).toBe(true)
  })
  it('scope-limited staff read only their properties', () => {
    expect(canReadProperty(scoped, P1)).toBe(true)
    expect(canReadProperty(scoped, P2)).toBe(false)
    expect(canReadProperty(noAccess, P1)).toBe(false)
  })
})

describe('canWriteProperty — "may view" is not "may change"', () => {
  it('full-access callers write everywhere', () => {
    expect(canWriteProperty(service, P1)).toBe(true)
    expect(canWriteProperty(service, null)).toBe(true)
    expect(canWriteProperty(globalGrant, P2)).toBe(true)
    expect(canWriteProperty(globalGrant, null)).toBe(true)
  })
  it('scope-limited staff write only to properties they hold access to', () => {
    expect(canWriteProperty(scoped, P1)).toBe(true)
    expect(canWriteProperty(scoped, P2)).toBe(false)
    expect(canWriteProperty(noAccess, P1)).toBe(false)
  })
  it('company-wide (null property) targets are NOT writable by scope-limited staff', () => {
    // read allows null for everyone; write must not — this asymmetry is the point.
    expect(canWriteProperty(scoped, null)).toBe(false)
    expect(canWriteProperty(noAccess, null)).toBe(false)
  })
})
