import { describe, expect, it } from 'vitest'
import { fixFrom, inSafariTab } from './device'

describe('telling Safari in a tab from the app on the Home Screen', () => {
  it('is a Safari tab when the page says it is not running standalone', () => {
    expect(inSafariTab({ standalone: false })).toBe(true)
  })

  it('is not when it is running from the Home Screen', () => {
    expect(inSafariTab({ standalone: true })).toBe(false)
  })

  it('is not on a browser that has no such thing, like Chrome on a computer', () => {
    expect(inSafariTab({})).toBe(false)
  })
})

describe('reading a GPS fix', () => {
  const coords = { latitude: -33.87, longitude: 151.2, accuracy: 8 }

  it('keeps the place and how accurate it is', () => {
    expect(fixFrom({ ...coords, heading: null, speed: null }, 1234)).toEqual({ lat: -33.87, lng: 151.2, accuracy: 8, heading: null, speed: null, time: 1234 })
  })

  it('keeps the phone\u2019s heading and speed while it is really moving', () => {
    expect(fixFrom({ ...coords, heading: 90, speed: 8 })).toMatchObject({ heading: 90, speed: 8 })
    expect(fixFrom({ ...coords, heading: 0, speed: 1.5 })).toMatchObject({ heading: 0, speed: 1.5 })
  })

  it('drops the heading when the phone is hardly moving, but keeps the speed', () => {
    expect(fixFrom({ ...coords, heading: 90, speed: 1.4 })).toMatchObject({ heading: null, speed: 1.4 })
    expect(fixFrom({ ...coords, heading: 90, speed: 0 })).toMatchObject({ heading: null, speed: 0 })
  })

  it('drops a heading it cannot trust: unknown speed, not a number, or out of range', () => {
    expect(fixFrom({ ...coords, heading: 90, speed: null }).heading).toBeNull()
    expect(fixFrom({ ...coords, heading: NaN, speed: 8 }).heading).toBeNull()
    expect(fixFrom({ ...coords, heading: -1, speed: 8 }).heading).toBeNull()
    expect(fixFrom({ ...coords, heading: 360, speed: 8 }).heading).toBeNull()
    expect(fixFrom({ ...coords, heading: undefined, speed: 8 }).heading).toBeNull()
  })

  it('has no speed it cannot trust either', () => {
    expect(fixFrom({ ...coords, heading: 90, speed: -1 })).toMatchObject({ speed: null, heading: null })
    expect(fixFrom({ ...coords, heading: 90, speed: NaN }).speed).toBeNull()
    expect(fixFrom({ ...coords, heading: 90, speed: Infinity }).speed).toBeNull()
  })
})
