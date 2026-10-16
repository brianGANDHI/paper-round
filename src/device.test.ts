import { describe, expect, it } from 'vitest'
import { inSafariTab } from './device'

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
