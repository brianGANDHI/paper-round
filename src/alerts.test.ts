import { describe, expect, it } from 'vitest'
import { aheadText, CLEARS_AFTER_M, stillAhead } from './alerts'
import type { Occurrence } from './geo'
import type { StopType } from './types'

const occ = (type: StopType, at: number): Occurrence => ({
  key: 's',
  stop: { id: 's', type, pathIdx: 0, lat: 0, lng: 0 },
  idx: 0,
  at,
})

describe('when an alert clears itself', () => {
  it('stays while the stop is ahead', () => {
    expect(stillAhead(occ('nothrow', 500), 400)).toBe(true)
    expect(stillAhead(occ('bundle', 500), 400)).toBe(true)
  })

  it('stays for a moment after the stop is passed, as when it is first noticed a little late', () => {
    // The approach check still allows a stop up to 20 m behind, so it must still be showing then.
    expect(stillAhead(occ('nothrow', 500), 520)).toBe(true)
    expect(stillAhead(occ('bundle', 500), 520)).toBe(true)
  })

  it('clears a no-throw warning soon after the house is passed', () => {
    expect(stillAhead(occ('nothrow', 500), 500 + CLEARS_AFTER_M.nothrow)).toBe(true)
    expect(stillAhead(occ('nothrow', 500), 500 + CLEARS_AFTER_M.nothrow + 1)).toBe(false)
  })

  it('gives a bundle drop longer, so there is time to tap Handled', () => {
    expect(CLEARS_AFTER_M.bundle).toBeGreaterThan(CLEARS_AFTER_M.nothrow)
    expect(stillAhead(occ('bundle', 500), 500 + CLEARS_AFTER_M.bundle)).toBe(true)
    expect(stillAhead(occ('bundle', 500), 500 + CLEARS_AFTER_M.bundle + 1)).toBe(false)
    // 45 m past: a bundle drop is still showing, a no-throw house is not.
    expect(stillAhead(occ('bundle', 500), 545)).toBe(true)
    expect(stillAhead(occ('nothrow', 500), 545)).toBe(false)
  })
})

describe('how far away a stop is said to be', () => {
  it('rounds to the nearest ten metres', () => {
    expect(aheadText(120)).toBe('120 m')
    expect(aheadText(124)).toBe('120 m')
    expect(aheadText(126)).toBe('130 m')
    expect(aheadText(20)).toBe('20 m')
  })

  it('says now when it is right here', () => {
    expect(aheadText(15)).toBe('20 m')
    expect(aheadText(14)).toBe('Now')
    expect(aheadText(0)).toBe('Now')
    expect(aheadText(-9)).toBe('Now')
  })

  it('says passed once it is behind', () => {
    expect(aheadText(-10)).toBe('Passed')
    expect(aheadText(-45)).toBe('Passed')
  })
})
