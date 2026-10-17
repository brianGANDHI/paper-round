import { describe, expect, it } from 'vitest'
import { formatDuration, plural } from './format'

describe('formatDuration', () => {
  it('says under a minute for a very short drive', () => {
    expect(formatDuration(0)).toBe('under a minute')
    expect(formatDuration(20)).toBe('under a minute')
  })

  it('rounds to the nearest minute', () => {
    expect(formatDuration(29)).toBe('under a minute')
    expect(formatDuration(30)).toBe('about 1 min')
    expect(formatDuration(437)).toBe('about 7 min')
    expect(formatDuration(3540)).toBe('about 59 min')
  })

  it('goes to hours from an hour on', () => {
    expect(formatDuration(3600)).toBe('about 1 hr')
    expect(formatDuration(3900)).toBe('about 1 hr 5 min')
    expect(formatDuration(7260)).toBe('about 2 hr 1 min')
  })

  it('rounds up into the next hour rather than saying 60 min', () => {
    expect(formatDuration(3570)).toBe('about 1 hr')
  })
})

describe('plural', () => {
  it('counts', () => {
    expect(plural(1, 'point', 'points')).toBe('1 point')
    expect(plural(2, 'point', 'points')).toBe('2 points')
  })
})
