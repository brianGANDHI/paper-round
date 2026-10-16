import { describe, expect, it } from 'vitest'
import { aheadText, ALERT_DISTANCES, ALERT_RADIUS, BACK_OFF_SLACK_M, DEFAULT_ALERT_DISTANCE, zoneExit } from './alerts'
import { APPROACH_RADIUS, type Occurrence } from './geo'
import type { StopType } from './types'

const occ = (type: StopType, at: number): Occurrence => ({
  key: 's',
  stop: { id: 's', type, pathIdx: 0, lat: 0, lng: 0 },
  idx: 0,
  at,
})

const normal = ALERT_RADIUS.normal

describe('the distances alerts come at', () => {
  it('are closer, on the usual setting, than the old fixed distances', () => {
    expect(normal.nothrow).toBeLessThan(APPROACH_RADIUS.nothrow)
    expect(normal.bundle).toBeLessThan(APPROACH_RADIUS.bundle)
  })

  it('grow from close to far, and give a bundle drop more room than a no-throw house', () => {
    for (const type of ['nothrow', 'bundle'] as const) {
      expect(ALERT_RADIUS.close[type]).toBeLessThan(ALERT_RADIUS.normal[type])
      expect(ALERT_RADIUS.normal[type]).toBeLessThan(ALERT_RADIUS.far[type])
    }
    for (const { value } of ALERT_DISTANCES) expect(ALERT_RADIUS[value].bundle).toBeGreaterThan(ALERT_RADIUS[value].nothrow)
  })

  it('have a setting for each choice offered, and the usual one is among them', () => {
    expect(ALERT_DISTANCES.map((d) => d.value).sort()).toEqual(Object.keys(ALERT_RADIUS).sort())
    expect(ALERT_DISTANCES.map((d) => d.value)).toContain(DEFAULT_ALERT_DISTANCE)
  })
})

describe('when the driver leaves the zone around a stop', () => {
  it('has not left while the stop is ahead or only just behind', () => {
    expect(zoneExit(occ('nothrow', 500), 470, normal)).toBeNull()
    expect(zoneExit(occ('nothrow', 500), 500, normal)).toBeNull()
    expect(zoneExit(occ('nothrow', 500), 530, normal)).toBeNull()
  })

  it('has passed the stop once it is further behind than the zone reaches', () => {
    const edge = 500 + normal.nothrow
    expect(zoneExit(occ('nothrow', 500), edge, normal)).toBeNull()
    expect(zoneExit(occ('nothrow', 500), edge + 1, normal)).toBe('passed')
  })

  it('has gone back when the stop is further ahead than the zone, with room for GPS jitter', () => {
    const edge = normal.nothrow + BACK_OFF_SLACK_M
    expect(zoneExit(occ('nothrow', 500), 500 - edge, normal)).toBeNull()
    expect(zoneExit(occ('nothrow', 500), 500 - edge - 1, normal)).toBe('back')
    // Just outside the zone, before the slack runs out, is not yet a move away.
    expect(zoneExit(occ('nothrow', 500), 500 - normal.nothrow - 1, normal)).toBeNull()
  })

  it('uses the zone of the kind of stop it is', () => {
    // 50 m past: outside the zone of a no-throw house, still inside that of a bundle drop.
    expect(zoneExit(occ('nothrow', 500), 550, normal)).toBe('passed')
    expect(zoneExit(occ('bundle', 500), 550, normal)).toBeNull()
  })

  it('follows the chosen distance', () => {
    expect(zoneExit(occ('nothrow', 500), 535, ALERT_RADIUS.close)).toBe('passed')
    expect(zoneExit(occ('nothrow', 500), 535, ALERT_RADIUS.far)).toBeNull()
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
