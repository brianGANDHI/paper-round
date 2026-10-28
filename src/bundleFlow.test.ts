import { describe, expect, it } from 'vitest'
import {
  barBundle,
  bundleWhere,
  DROP_LOCK_MS,
  dropAllowed,
  freshStart,
  missedAmong,
  missedNotice,
  restartEffect,
  restartedRound,
  restoreBundle,
  savedRound,
  sheetRow,
  unsetAmounts,
} from './bundleFlow'
import {
  bundleList,
  bundleTotals,
  markDropped,
  markMissed,
  nextBundle,
  otherPasses,
  passStates,
  reconcile,
  type BundleItem,
  type PassStates,
} from './bundles'
import type { Occurrence } from './geo'
import type { RoundState, Stop } from './types'

/** An occurrence `at` metres along the route, by hand so that the distances are exact. */
const occ = (id: string, at: number, type: Stop['type'] = 'bundle', extra: Partial<Stop> = {}, key = id): Occurrence => ({
  key,
  stop: { id, type, lat: -33.87, lng: 151.2, pathIdx: 0, ...extra },
  idx: 0,
  at,
  off: 0,
})

const round = (extra: Partial<RoundState> = {}): RoundState => ({ handledStopIds: [], ...extra })

describe('keeping the round', () => {
  const prev = round({ handledStopIds: ['a', 'b', 'c'], dropped: ['a'], missed: ['b'], furthest: 500, startM: 100 })

  it('carries the bundles dropped and missed through a save, which is what the screen used to lose', () => {
    const next = savedRound(prev, ['a', 'b', 'c', 'd'], 600, 100)
    expect(next.dropped).toEqual(['a'])
    expect(next.missed).toEqual(['b'])
    expect(next.handledStopIds).toEqual(['a', 'b', 'c', 'd'])
  })

  it('takes the new furthest and start, not the old', () => {
    expect(savedRound(prev, ['a', 'b'], 700, 250)).toMatchObject({ furthest: 700, startM: 250 })
  })

  it('leaves the furthest and the start out when they are nothing, as the round always did', () => {
    const next = savedRound(prev, ['a', 'b'], undefined, 0)
    expect(next).not.toHaveProperty('furthest')
    expect(next).not.toHaveProperty('startM')
    expect(savedRound(prev, ['a', 'b'], 0, 0)).not.toHaveProperty('furthest')
  })

  it('forgets a drop or a miss whose stop is no longer among the stops done', () => {
    const next = savedRound(prev, ['b', 'c'], 500, 100)
    expect(next.dropped).toBeUndefined()
    expect(next.missed).toEqual(['b'])
  })

  it('has no lists at all for a round with no drops or misses', () => {
    const next = savedRound(round({ handledStopIds: ['x'] }), ['x', 'y'], 10, 0)
    expect(next).toEqual({ handledStopIds: ['x', 'y'], furthest: 10 })
  })

  it('records bundles driven past as missed, once they are among the stops done', () => {
    const next = savedRound(round({ handledStopIds: ['a'], dropped: ['a'] }), ['a', 'b', 'c'], 300, 0, ['b'])
    expect(next.missed).toEqual(['b'])
    expect(next.dropped).toEqual(['a'])
    expect(next.handledStopIds).toEqual(['a', 'b', 'c'])
  })

  it('does not record a miss for a bundle already dropped, nor for one that is not among the stops done', () => {
    const next = savedRound(round({ handledStopIds: ['a'], dropped: ['a'] }), ['a'], 0, 0, ['a', 'zzz'])
    expect(next.missed).toBeUndefined()
    expect(next.dropped).toEqual(['a'])
  })

  it('keeps earlier misses when more are recorded', () => {
    const next = savedRound(prev, ['a', 'b', 'c', 'd'], 500, 100, ['d'])
    expect(next.missed).toEqual(['b', 'd'])
  })

  it('does not change the round it was given', () => {
    const copy = structuredClone(prev)
    savedRound(prev, ['a'], 1, 1, ['a'])
    expect(prev).toEqual(copy)
  })

  it('sweeps (stops gone by, with nothing recorded as missed) leave the bundles in them skipped', () => {
    const sweep = savedRound(prev, ['a', 'b', 'c', 'e'], 500, 100)
    const list = bundleList([occ('a', 10), occ('b', 20), occ('c', 30), occ('e', 40)], sweep, 100)
    expect(list.map((b) => b.status)).toEqual(['dropped', 'missed', 'skipped', 'skipped'])
  })
})

describe('starting the round over, or from a spot', () => {
  const occs = [occ('a', 100), occ('b', 400), occ('c', 700), occ('n', 750, 'nothrow')]
  const prev = round({ handledStopIds: ['a', 'b', 'c'], dropped: ['a', 'c'], missed: ['b'], furthest: 800, startM: 50 })

  it('forgets every drop and miss when it starts from the beginning', () => {
    expect(restartedRound(prev, occs, 0, 15)).toEqual({ handledStopIds: [] })
  })

  it('keeps what was dropped or missed before the spot', () => {
    const next = restartedRound(prev, occs, 500, 15)
    expect(next.handledStopIds).toEqual(['a', 'b'])
    expect(next.dropped).toEqual(['a'])
    expect(next.missed).toEqual(['b'])
  })

  it('brings back a bundle after the spot: it is no longer dropped, and alerts again', () => {
    const next = restartedRound(prev, occs, 500, 15)
    expect(next.handledStopIds).not.toContain('c')
    expect(next.dropped).not.toContain('c')
  })

  it('brings back a missed bundle after the spot too', () => {
    const next = restartedRound(prev, occs, 300, 15)
    expect(next.handledStopIds).toEqual(['a'])
    expect(next.missed).toBeUndefined()
    expect(next.dropped).toEqual(['a'])
  })

  it('counts a bundle that was still to do before the spot as skipped: neither dropped nor missed', () => {
    const fresh = round({ handledStopIds: [], startM: 0 })
    const next = restartedRound(fresh, occs, 500, 15)
    expect(next.handledStopIds).toEqual(['a', 'b'])
    const list = bundleList(occs, next, 500)
    expect(list.map((b) => b.status)).toEqual(['skipped', 'skipped', 'next'])
  })

  it('records where it started and that it got that far', () => {
    expect(restartedRound(prev, occs, 500, 15)).toMatchObject({ startM: 500, furthest: 500 })
  })

  it('counts a bundle just short of the spot as still ahead, by the slack, as skipping always has', () => {
    expect(restartedRound(round(), occs, 410, 15).handledStopIds).toEqual(['a'])
    expect(restartedRound(round(), occs, 410, 5).handledStopIds).toEqual(['a', 'b'])
    expect(restartedRound(round(), occs, 420, 15).handledStopIds).toEqual(['a', 'b'])
  })

  it('does not change the round it was given', () => {
    const copy = structuredClone(prev)
    restartedRound(prev, occs, 500, 15)
    expect(prev).toEqual(copy)
  })

  describe('a stop the route goes by twice', () => {
    // The shop is met at 100 m and again at 900 m; the depot once, at 500 m.
    const twice = [occ('shop', 100, 'bundle', {}, 'shop'), occ('depot', 500), occ('shop', 900, 'bundle', {}, 'shop#2')]

    it('stays one delivery done when it was dropped on the pass before the spot: the later pass is done too', () => {
      const dropped = round({ handledStopIds: ['shop', 'shop#2'], dropped: ['shop'] })
      const next = restartedRound(dropped, twice, 600, 15)
      expect(next.handledStopIds).toEqual(['shop', 'depot', 'shop#2'])
      expect(next.dropped).toEqual(['shop'])
      const list = bundleList(twice, next, 600)
      expect(list.map((b) => [b.key, b.status, b.coveredBy])).toEqual([
        ['shop', 'dropped', null],
        ['depot', 'skipped', null],
        ['shop#2', 'skipped', 1],
      ])
    })

    it('does not bring the later pass back to alert when the round is skipped to a spot between the two', () => {
      const dropped = round({ handledStopIds: ['shop', 'shop#2'], dropped: ['shop'] })
      expect(restartedRound(dropped, twice, 300, 15).handledStopIds).toEqual(['shop', 'shop#2'])
    })

    it('forgets the drop, and the settling of the other pass, when the spot is before the pass dropped', () => {
      const dropped = round({ handledStopIds: ['shop', 'shop#2'], dropped: ['shop'] })
      const next = restartedRound(dropped, twice, 50, 15)
      expect(next.handledStopIds).toEqual([])
      expect(next.dropped).toBeUndefined()
    })

    it('forgets a drop on the later pass when the spot is before it, and leaves the earlier pass done', () => {
      const dropped = round({ handledStopIds: ['shop', 'shop#2'], dropped: ['shop#2'] })
      const next = restartedRound(dropped, twice, 300, 15)
      expect(next.handledStopIds).toEqual(['shop'])
      expect(next.dropped).toBeUndefined()
      expect(bundleList(twice, next, 300).map((b) => [b.key, b.status])).toEqual([
        ['shop', 'skipped'],
        ['depot', 'next'],
        ['shop#2', 'later'],
      ])
    })

    it('un-misses a pass of a stop whose drop stays', () => {
      const prev2 = round({ handledStopIds: ['shop', 'shop#2'], dropped: ['shop#2'], missed: [] })
      const missedFirst = round({ handledStopIds: ['shop'], missed: ['shop'] })
      expect(restartedRound(missedFirst, twice, 300, 15).missed).toEqual(['shop'])
      expect(restartedRound(prev2, twice, 1000, 15).handledStopIds).toEqual(['shop', 'depot', 'shop#2'])
      expect(restartedRound(prev2, twice, 1000, 15).missed).toBeUndefined()
    })

    it('still forgets everything at the start', () => {
      expect(restartedRound(round({ handledStopIds: ['shop', 'shop#2'], dropped: ['shop'] }), twice, 0, 15)).toEqual({ handledStopIds: [] })
    })
  })
})

describe('starting from a spot after a round that was finished', () => {
  // Yesterday's round, finished: the first two bundles dropped, the third missed.
  const occs = [occ('b1', 500), occ('b2', 1500), occ('b3', 1800), occ('b4', 3000)]
  const yesterday = round({ handledStopIds: ['b1', 'b2', 'b3', 'b4'], dropped: ['b1', 'b2'], missed: ['b3'], furthest: 3100 })

  it('is a fresh start when it is a start and the round was finished, and not for a skip or an unfinished round', () => {
    expect(freshStart(false, true)).toBe(true)
    expect(freshStart(false, false)).toBe(false)
    expect(freshStart(true, true)).toBe(false)
    expect(freshStart(true, false)).toBe(false)
  })

  it('opens with nothing dropped or missed, so yesterday does not count in the papers or the misses', () => {
    const next = restartedRound(yesterday, occs, 2000, 15, true)
    expect(next.handledStopIds).toEqual(['b1', 'b2', 'b3'])
    expect(next.dropped).toBeUndefined()
    expect(next.missed).toBeUndefined()
    expect(next).toMatchObject({ startM: 2000, furthest: 2000 })
    expect(bundleList(occs, next, 2000).map((b) => b.status)).toEqual(['skipped', 'skipped', 'skipped', 'next'])
    expect(bundleTotals(bundleList(occs, next, 2000))).toMatchObject({ dropped: 0, missed: 0 })
  })

  it('still keeps them for a start on a round that was not finished, as the picker has always done', () => {
    const next = restartedRound(yesterday, occs, 2000, 15, false)
    expect(next.dropped).toEqual(['b1', 'b2'])
    expect(next.missed).toEqual(['b3'])
  })

  it('does not change the round it was given', () => {
    const copy = structuredClone(yesterday)
    restartedRound(yesterday, occs, 2000, 15, true)
    expect(yesterday).toEqual(copy)
  })
})

describe('what a start or skip to a spot does to the stops, as it is told', () => {
  const handledOf = (r: RoundState) => new Set(r.handledStopIds)

  it('counts the stops before the spot not done yet, and the done stops after it', () => {
    const occs = [occ('a', 100), occ('b', 400), occ('c', 700)]
    const r = round({ handledStopIds: ['a', 'c'] })
    expect(restartEffect(r, occs, handledOf(r), 500, 15)).toEqual({ newly: 1, back: 1 })
  })

  it('does not count the later pass of a stop whose drop stays as one that comes up again', () => {
    // Dropped on its first pass, so its second pass was settled with it; a spot between the two leaves it done.
    const occs = [occ('s', 300, 'bundle', {}, 's'), occ('h', 600, 'nothrow'), occ('s', 1700, 'bundle', {}, 's#2')]
    const r = round({ handledStopIds: ['s', 's#2'], dropped: ['s'] })
    expect(restartedRound(r, occs, 1000, 15).handledStopIds).toContain('s#2')
    expect(restartEffect(r, occs, handledOf(r), 1000, 15)).toEqual({ newly: 1, back: 0 })
  })

  it('counts it as coming up again when the spot is before the pass that was dropped', () => {
    const occs = [occ('s', 300, 'bundle', {}, 's'), occ('s', 1700, 'bundle', {}, 's#2')]
    const r = round({ handledStopIds: ['s', 's#2'], dropped: ['s'] })
    expect(restartEffect(r, occs, handledOf(r), 100, 15)).toEqual({ newly: 0, back: 2 })
  })

  it('goes by a fresh start when it is one: nothing stays settled that was dropped', () => {
    const occs = [occ('s', 300, 'bundle', {}, 's'), occ('h', 600, 'nothrow'), occ('s', 1700, 'bundle', {}, 's#2')]
    const r = round({ handledStopIds: ['s', 'h', 's#2'], dropped: ['s'] })
    expect(restartEffect(r, occs, handledOf(r), 1000, 15, true)).toEqual({ newly: 0, back: 1 })
    expect(restartEffect(r, occs, handledOf(r), 1000, 15, false)).toEqual({ newly: 0, back: 0 })
  })
})

describe('a double tap on Dropped', () => {
  it('takes the first tap, and no second tap within the lock', () => {
    expect(dropAllowed(-Infinity, 1000)).toBe(true)
    expect(dropAllowed(1000, 1000 + DROP_LOCK_MS - 1)).toBe(false)
    expect(dropAllowed(1000, 1000)).toBe(false)
  })

  it('takes another tap once the lock is over', () => {
    expect(dropAllowed(1000, 1000 + DROP_LOCK_MS)).toBe(true)
    expect(dropAllowed(1000, 60_000)).toBe(true)
  })

  it('holds long enough for a reflex tap and not so long that the next bundle is kept waiting', () => {
    expect(DROP_LOCK_MS).toBeGreaterThanOrEqual(400)
    expect(DROP_LOCK_MS).toBeLessThanOrEqual(1000)
  })
})

describe('taking back a drop', () => {
  it('puts the bundle back to be done', () => {
    const dropped = markDropped(round(), 'a')
    const back = restoreBundle(dropped, 'a', false)
    expect(back.handledStopIds).toEqual([])
    expect(back.dropped).toBeUndefined()
  })

  it('puts a bundle that was missed back to missed, when it is said to have been', () => {
    const missed = markMissed(round({ handledStopIds: ['a'] }), ['a'])
    const dropped = markDropped(missed, 'a')
    expect(dropped.missed).toBeUndefined()
    const back = restoreBundle(dropped, 'a', true)
    expect(back.missed).toEqual(['a'])
    expect(back.dropped).toBeUndefined()
    expect(back.handledStopIds).toEqual(['a'])
  })

  it('leaves other bundles as they are', () => {
    const r = markDropped(markDropped(round({ handledStopIds: ['m'], missed: ['m'] }), 'a'), 'b')
    const back = restoreBundle(r, 'a', false)
    expect(back.dropped).toEqual(['b'])
    expect(back.missed).toEqual(['m'])
    expect(back.handledStopIds).toEqual(['m', 'b'])
  })

  it('does nothing to a bundle that is not dropped any more, such as after the round was restarted', () => {
    const restarted = round({ handledStopIds: ['a'], missed: ['a'] })
    expect(restoreBundle(restarted, 'a', false)).toEqual(restarted)
    expect(restoreBundle(restarted, 'a', true)).toEqual(restarted)
    expect(restoreBundle(round(), 'a', true)).toEqual(round())
  })

  it('keeps how far the round got', () => {
    const r = markDropped(round({ furthest: 300, startM: 40 }), 'a')
    expect(restoreBundle(r, 'a', false)).toMatchObject({ furthest: 300, startM: 40 })
  })

  describe('with the passes of its stop kept from before the drop', () => {
    const passes = [occ('shop', 100, 'bundle', {}, 'shop'), occ('shop', 900, 'bundle', {}, 'shop#2')]
    const drop = (r: RoundState, key: string) => {
      const others = otherPasses(passes, key)
      return { before: passStates(r, [key, ...others]), after: markDropped(r, key, others) }
    }

    it('puts a first pass that was missed back to missed when the second pass is taken back', () => {
      const missed = markMissed(round({ handledStopIds: ['shop'] }), ['shop'])
      const { before, after } = drop(missed, 'shop#2')
      expect(after.missed).toBeUndefined()
      const back = restoreBundle(after, 'shop#2', before)
      expect(back.missed).toEqual(['shop'])
      expect(back.dropped).toBeUndefined()
      expect(back.handledStopIds).toEqual(['shop'])
    })

    it('puts the second pass back to come, so it alerts again', () => {
      const { before, after } = drop(round(), 'shop')
      expect(after.handledStopIds).toEqual(['shop', 'shop#2'])
      expect(restoreBundle(after, 'shop', before)).toEqual(round())
    })

    it('puts a bundle marked dropped from the list while missed back to missed, with no flag for it', () => {
      const missed = markMissed(round({ handledStopIds: ['shop'] }), ['shop'])
      const { before, after } = drop(missed, 'shop')
      expect(restoreBundle(after, 'shop', before).missed).toEqual(['shop'])
    })

    it('does nothing to a bundle that is not dropped any more, with the states or without', () => {
      const { before } = drop(round(), 'shop')
      const restarted = round({ handledStopIds: ['shop'], missed: ['shop'] })
      expect(restoreBundle(restarted, 'shop', before)).toEqual(restarted)
      expect(restoreBundle(round(), 'shop', before)).toEqual(round())
    })

    it('still takes a plain true or false, as before, and then puts back only the bundle', () => {
      const { after } = drop(round(), 'shop')
      const back = restoreBundle(after, 'shop', false)
      expect(back.handledStopIds).toEqual(['shop#2'])
      expect(back.dropped).toBeUndefined()
    })
  })
})

describe('the bar line for bundles', () => {
  const occs = [occ('a', 100, 'bundle', { label: 'Co-op', qty: 12 }), occ('b', 400, 'bundle', { address: '3 Elm Street' }), occ('c', 900)]

  it('is nothing when the route has no bundle drops', () => {
    expect(barBundle([])).toBeNull()
    expect(barBundle(bundleList([occ('n', 50, 'nothrow')], round(), 0))).toBeNull()
  })

  it('names the next bundle, how far it is and its papers', () => {
    expect(barBundle(bundleList(occs, round(), 0))).toEqual({ lead: 'Next bundle', name: 'Co-op', distance: '100 m', papers: '12 papers', missed: 0 })
  })

  it('moves on to the one after when the first is dropped', () => {
    const list = bundleList(occs, markDropped(round(), 'a'), 120)
    expect(barBundle(list)).toEqual({ lead: 'Next bundle', name: '3 Elm Street', distance: '280 m', papers: null, missed: 0 })
  })

  it('says how far in kilometres from a kilometre', () => {
    const far = bundleList([occ('a', 3200, 'bundle', { label: 'Depot', qty: 1 })], round(), 0)
    expect(barBundle(far)).toMatchObject({ distance: '3.2 km', papers: '1 paper' })
  })

  it('says it is here when the driver is at it', () => {
    expect(barBundle(bundleList(occs, round(), 95))?.distance).toBe('Now')
  })

  it('counts the ones missed', () => {
    const r = markMissed(round({ handledStopIds: ['a'] }), ['a'])
    expect(barBundle(bundleList(occs, r, 150))).toMatchObject({ name: '3 Elm Street', missed: 1 })
  })

  const two = occs.slice(0, 2)

  it('says all are dropped, with no distance, when every bundle is', () => {
    const r = markDropped(markDropped(round(), 'a'), 'b')
    expect(barBundle(bundleList(two, r, 500))).toEqual({ lead: 'Bundles', name: 'All bundles dropped', distance: null, papers: null, missed: 0 })
  })

  it('says none are ahead, with how many were missed, when some were not dropped', () => {
    const r = markMissed(markDropped(round({ handledStopIds: ['b'] }), 'a'), ['b'])
    expect(barBundle(bundleList(two, r, 500))).toEqual({ lead: 'Bundles', name: 'No more bundles ahead', distance: null, papers: null, missed: 1 })
  })

  it('says none are ahead when the rest were skipped over', () => {
    const r = round({ handledStopIds: ['a', 'b'] })
    expect(barBundle(bundleList(two, r, 500))).toMatchObject({ name: 'No more bundles ahead', missed: 0 })
  })

  describe('for a stop the route goes by twice', () => {
    const shop = [occ('shop', 100, 'bundle', { label: 'Co-op', qty: 12 }, 'shop'), occ('depot', 400, 'bundle', { label: 'Depot', qty: 3 }), occ('shop', 900, 'bundle', { label: 'Co-op', qty: 12 }, 'shop#2')]

    it('says all are dropped once the stop is dropped on one pass, though the other was never tapped', () => {
      const r = markDropped(markDropped(round(), 'shop', ['shop#2']), 'depot')
      expect(barBundle(bundleList(shop, r, 1000))).toEqual({ lead: 'Bundles', name: 'All bundles dropped', distance: null, papers: null, missed: 0 })
    })

    it('does not count the first pass missed when the stop is dropped on the second', () => {
      const missed = markMissed(round({ handledStopIds: ['shop'] }), ['shop'])
      const r = markDropped(missed, 'shop#2', ['shop'])
      expect(barBundle(bundleList(shop, r, 150))).toMatchObject({ name: 'Depot', distance: '250 m', papers: '3 papers', missed: 0 })
      expect(barBundle(bundleList(shop, missed, 150))).toMatchObject({ name: 'Depot', missed: 0 })
    })

    it('counts a stop missed once though both passes were', () => {
      const r = markMissed(round({ handledStopIds: ['shop', 'depot', 'shop#2'] }), ['shop', 'shop#2'])
      expect(barBundle(bundleList(shop, r, 1000))).toEqual({ lead: 'Bundles', name: 'No more bundles ahead', distance: null, papers: null, missed: 1 })
    })

    it('does not call the stop missed while its second pass is to come', () => {
      const r = markMissed(round({ handledStopIds: ['shop'] }), ['shop'])
      expect(barBundle(bundleList(shop, r, 150))).toMatchObject({ name: 'Depot', missed: 0 })
    })
  })
})

describe('which stops driven past are bundles missed', () => {
  const passed = [occ('b1', 100), occ('n1', 120, 'nothrow'), occ('r1', 130, 'request'), occ('b2', 140)]

  it('is the bundle drops among them while on the route', () => {
    expect(missedAmong(passed, true)).toEqual(['b1', 'b2'])
  })

  it('is none after leaving the route, when they are only skipped', () => {
    expect(missedAmong(passed, false)).toEqual([])
  })

  it('is none when only no-throw houses and special requests were passed', () => {
    expect(missedAmong(passed.slice(1, 3), true)).toEqual([])
  })

  it('goes by the occurrence, so the second pass of a street is its own', () => {
    expect(missedAmong([occ('b1', 100, 'bundle', {}, 'b1#2')], true)).toEqual(['b1#2'])
  })

  it('is none for nothing passed', () => {
    expect(missedAmong([], true)).toEqual([])
  })
})

describe('the notice for bundles driven past', () => {
  it('is nothing when there are none', () => {
    expect(missedNotice([])).toBe('')
  })

  it('names the venue', () => {
    expect(missedNotice(['Co-op'])).toBe('Missed bundle: Co-op')
  })

  it('names two, and counts them', () => {
    expect(missedNotice(['Co-op', 'School'])).toBe('Missed 2 bundles: Co-op and School')
  })

  it('names the first two and counts the rest, so the line stays short', () => {
    expect(missedNotice(['A', 'B', 'C', 'D'])).toBe('Missed 4 bundles: A, B and 2 more')
    expect(missedNotice(['A', 'B', 'C'])).toBe('Missed 3 bundles: A, B and 1 more')
  })

  it('cuts a long name short with an ellipsis, and leaves a name of the length allowed alone', () => {
    const long = 'Woolworths Metro Central Station Concourse'
    const text = missedNotice([long])
    expect(text).toContain('…')
    expect(text.length).toBeLessThan(`Missed bundle: ${long}`.length)
    expect(text.startsWith('Missed bundle: Woolworths Metro')).toBe(true)
    const exact = 'x'.repeat(26)
    expect(missedNotice([exact])).toBe(`Missed bundle: ${exact}`)
    expect(missedNotice(['x'.repeat(27)])).toBe(`Missed bundle: ${'x'.repeat(25)}…`)
  })
})

describe('how far a bundle is, in the list', () => {
  it('says how far ahead', () => {
    expect(bundleWhere(340)).toBe('340 m ahead')
    expect(bundleWhere(1240)).toBe('1.2 km ahead')
  })

  it('says it is here when it is', () => {
    expect(bundleWhere(0)).toBe('Here now')
    expect(bundleWhere(14)).toBe('Here now')
    expect(bundleWhere(-9)).toBe('Here now')
  })

  it('says it is behind once it is', () => {
    expect(bundleWhere(-10)).toBe('Behind you')
    expect(bundleWhere(-400)).toBe('Behind you')
  })
})

describe('a row of the list', () => {
  const occs = [occ('a', 100, 'bundle', { label: 'Co-op', address: '12 Oak Road', qty: 12 }), occ('b', 400), occ('c', 900, 'bundle', { label: 'School', qty: 1 }, 'c'), occ('c', 1500, 'bundle', { label: 'School', qty: 1 }, 'c#2')]
  const rowsFor = (r: RoundState, along: number) => bundleList(occs, r, along).map(sheetRow)

  it('has the venue, the address under it, the papers and how far', () => {
    const [a] = rowsFor(round(), 0)
    expect(a).toMatchObject({ key: 'a', name: 'Co-op', address: '12 Oak Road', status: 'next', statusLabel: 'Next', papers: '12 papers', where: '100 m ahead', pass: null })
  })

  it('has no papers when no amount was set', () => {
    expect(rowsFor(round(), 0)[1].papers).toBeNull()
  })

  it('says which pass for a street the route goes by more than once', () => {
    const rows = rowsFor(round(), 0)
    expect(rows[2].pass).toBe('Pass 1 of 2')
    expect(rows[3].pass).toBe('Pass 2 of 2')
    expect(rows[3].key).toBe('c#2')
  })

  it('offers Mark dropped on a bundle missed or one that is later, but not on the next, whose alert has the button', () => {
    const r = markMissed(round({ handledStopIds: ['a'] }), ['a'])
    const rows = rowsFor(r, 200)
    expect(rows.map((x) => [x.status, x.action])).toEqual([
      ['missed', 'mark'],
      ['next', null],
      ['later', 'mark'],
      ['later', 'mark'],
    ])
  })

  it('offers Undo on a bundle dropped, and nothing on one skipped over', () => {
    const r = round({ handledStopIds: ['a', 'b'], dropped: ['a'] })
    const rows = rowsFor(r, 450)
    expect(rows[0]).toMatchObject({ status: 'dropped', statusLabel: 'Dropped', action: 'undo' })
    expect(rows[1]).toMatchObject({ status: 'skipped', statusLabel: 'Skipped', action: null })
  })

  it('says behind you for one the driver has gone by', () => {
    const r = markMissed(round({ handledStopIds: ['a'] }), ['a'])
    expect(rowsFor(r, 300)[0].where).toBe('Behind you')
  })

  it('reads a pass covered by the drop of the other as dropped on that pass, with no button', () => {
    const r = markDropped(round(), 'c', ['c#2'])
    const rows = rowsFor(r, 1000)
    expect(rows[2]).toMatchObject({ key: 'c', status: 'dropped', statusLabel: 'Dropped', action: 'undo', pass: 'Pass 1 of 2' })
    expect(rows[3]).toMatchObject({ key: 'c#2', status: 'skipped', statusLabel: 'Dropped on pass 1', action: null, pass: 'Pass 2 of 2' })
    expect(rows[3].label).toBe('Dropped on pass 1. School, 1 paper, pass 2 of 2. 500 m ahead.')
  })

  it('says the pass that covers it when that is the second', () => {
    const r = markDropped(round(), 'c#2', ['c'])
    expect(rowsFor(r, 100)[2]).toMatchObject({ key: 'c', statusLabel: 'Dropped on pass 2', action: null })
  })

  it('reads out in full for a screen reader', () => {
    const r = markMissed(round({ handledStopIds: ['a'] }), ['a'])
    const rows = rowsFor(r, 300)
    expect(rows[0].label).toBe('Missed. Co-op, 12 papers. Behind you.')
    expect(rows[3].label).toBe('Later. School, 1 paper, pass 2 of 2. 1.2 km ahead.')
  })
})

describe('bundles with no amount, in the totals', () => {
  const item = (status: BundleItem['status'], papers: number | null): BundleItem => ({
    key: status + papers,
    stopId: status + papers,
    name: 'x',
    address: null,
    papers,
    at: 0,
    ahead: 0,
    pass: 1,
    passes: 1,
    behind: false,
    coveredBy: null,
    status,
  })

  it('counts those that are dropped or still to drop', () => {
    expect(unsetAmounts([item('dropped', null), item('next', null), item('later', null)])).toBe(3)
  })

  it('does not count those that have an amount', () => {
    expect(unsetAmounts([item('dropped', 5), item('later', 7)])).toBe(0)
  })

  it('does not count those missed or skipped, which the papers figures do not cover', () => {
    expect(unsetAmounts([item('missed', null), item('skipped', null)])).toBe(0)
  })

  it('is nothing for no bundles', () => {
    expect(unsetAmounts([])).toBe(0)
  })

  it('counts a stop the route goes by twice once', () => {
    const occs = [occ('s', 100, 'bundle', {}, 's'), occ('s', 900, 'bundle', {}, 's#2'), occ('t', 500)]
    expect(unsetAmounts(bundleList(occs, round(), 0))).toBe(2)
    expect(unsetAmounts(bundleList(occs, markDropped(round(), 's', ['s#2']), 0))).toBe(2)
  })

  it('does not count a stop missed on every pass, or skipped', () => {
    const occs = [occ('s', 100, 'bundle', {}, 's'), occ('s', 900, 'bundle', {}, 's#2')]
    expect(unsetAmounts(bundleList(occs, markMissed(round({ handledStopIds: ['s', 's#2'] }), ['s', 's#2']), 1000))).toBe(0)
  })
})


describe('a round of bundle drops through many changes, one delivery for each stop', () => {
  // Four bundle stops and a house on a route of 1300 m: the shop is gone by twice, the garage three times, the depot once, and the kiosk twice
  // with no amount set.
  const route: Occurrence[] = [
    occ('shop', 100, 'bundle', { qty: 12 }, 'shop'),
    occ('kiosk', 200, 'bundle', {}, 'kiosk'),
    occ('garage', 300, 'bundle', { qty: 5 }, 'garage'),
    occ('house', 400, 'nothrow'),
    occ('depot', 500, 'bundle', { qty: 7 }),
    occ('garage', 700, 'bundle', { qty: 5 }, 'garage#2'),
    occ('shop', 900, 'bundle', { qty: 12 }, 'shop#2'),
    occ('kiosk', 1000, 'bundle', {}, 'kiosk#2'),
    occ('garage', 1100, 'bundle', { qty: 5 }, 'garage#3'),
  ]
  const bundleKeys = route.filter((o) => o.stop.type === 'bundle').map((o) => o.key)
  const papersOf = new Map(route.map((o) => [o.stop.id, o.stop.qty ?? 0]))
  const stops = [...new Set(route.filter((o) => o.stop.type === 'bundle').map((o) => o.stop.id))]
  const passesOfStop = (id: string) => route.filter((o) => o.stop.id === id).map((o) => o.key)

  /** A small random generator that gives the same numbers for the same seed, so a failure can be run again. */
  const generator = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const sets = (r: RoundState) => ({ handled: [...r.handledStopIds].sort(), dropped: [...(r.dropped ?? [])].sort(), missed: [...(r.missed ?? [])].sort(), furthest: r.furthest, startM: r.startM })

  /** What must hold of the round whatever has been done to it. */
  function holds(r: RoundState, along: number, where: string) {
    const handled = new Set(r.handledStopIds)
    const dropped = r.dropped ?? []
    const missed = r.missed ?? []
    expect(handled.size, `${where}: stops done are listed once`).toBe(r.handledStopIds.length)
    expect(new Set(dropped).size, `${where}: dropped once`).toBe(dropped.length)
    expect(new Set(missed).size, `${where}: missed once`).toBe(missed.length)
    for (const k of dropped) expect(handled.has(k), `${where}: ${k} dropped but not done`).toBe(true)
    for (const k of missed) {
      expect(handled.has(k), `${where}: ${k} missed but not done`).toBe(true)
      expect(dropped.includes(k), `${where}: ${k} both dropped and missed`).toBe(false)
    }
    // A stop dropped on any pass is done on every pass, and not missed on any it was not dropped on.
    for (const id of stops) {
      const passes = passesOfStop(id)
      if (!passes.some((k) => dropped.includes(k))) continue
      for (const k of passes) {
        expect(handled.has(k), `${where}: ${k} should be settled by the drop of ${id}`).toBe(true)
        expect(missed.includes(k), `${where}: ${k} is missed though ${id} was dropped`).toBe(false)
      }
    }
    // The list and its totals count each stop once.
    const list = bundleList(route, r, along)
    const totals = bundleTotals(list)
    const deliveredStops = stops.filter((id) => passesOfStop(id).some((k) => dropped.includes(k)))
    expect(totals.total, `${where}: stops`).toBe(stops.length)
    expect(totals.dropped + totals.missed + totals.skipped + totals.toDrop, `${where}: every stop in one state`).toBe(totals.total)
    expect(totals.dropped, `${where}: dropped stops`).toBe(deliveredStops.length)
    expect(totals.droppedPapers, `${where}: papers dropped once for each stop`).toBe(deliveredStops.reduce((n, id) => n + (papersOf.get(id) ?? 0), 0))
    expect(totals.droppedPapers + totals.missedPapers + totals.toDropPapers, `${where}: papers`).toBeLessThanOrEqual(stops.reduce((n, id) => n + (papersOf.get(id) ?? 0), 0))
    // The next bundle is one still to come, of a stop not dropped.
    const next = nextBundle(list)
    if (next) {
      expect(handled.has(next.key), `${where}: next is done`).toBe(false)
      expect(deliveredStops.includes(next.stopId), `${where}: next is of a stop dropped`).toBe(false)
      expect(next.coveredBy).toBeNull()
    }
    for (const b of list) {
      if (deliveredStops.includes(b.stopId)) expect(['dropped', 'skipped'], `${where}: ${b.key}`).toContain(b.status)
    }
  }

  it('keeps every stop one delivery and every drop exactly undoable, whatever is done in whatever order', () => {
    const memos: { key: string; before: PassStates }[] = []
    for (let seed = 1; seed <= 300; seed++) {
      const random = generator(seed)
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]
      let r: RoundState = { handledStopIds: [] }
      memos.length = 0
      for (let step = 0; step < 40; step++) {
        const along = Math.floor(random() * 1300)
        const before = structuredClone(r)
        const list = bundleList(route, r, along)
        const where = `seed ${seed} step ${step}`
        const op = Math.floor(random() * 8)
        let label = ''
        if (op <= 2) {
          // Dropped: from the alert (the next, or one the driver is at) or from the list (one missed or still to come).
          const open = list.filter((b) => b.status === 'next' || b.status === 'later' || b.status === 'missed')
          if (!open.length) continue
          const key = pick(open).key
          const others = otherPasses(route, key)
          const was = passStates(r, [key, ...others])
          r = markDropped(r, key, others)
          memos.push({ key, before: was })
          label = `drop ${key}`
          // Taken back at once, everything is as it was.
          const back = restoreBundle(r, key, was)
          expect(sets(back), `${where}: undo of ${label}`).toEqual(sets(before))
          expect(bundleList(route, back, along), `${where}: list after undo of ${label}`).toEqual(list)
        } else if (op === 3 && memos.length) {
          // An Undo, maybe a late one.
          const memo = pick(memos)
          r = restoreBundle(r, memo.key, memo.before)
          label = `undo ${memo.key}`
        } else if (op === 4 || op === 5) {
          // Driving past a pass still to come: missed (a bundle, with no tap) or just done.
          const openKeys = bundleKeys.filter((k) => !r.handledStopIds.includes(k))
          if (!openKeys.length) continue
          const key = pick(openKeys)
          r = savedRound(r, [...r.handledStopIds, key], r.furthest, r.startM ?? 0, op === 4 ? [key] : [])
          label = `${op === 4 ? 'miss' : 'sweep'} ${key}`
        } else if (op === 6) {
          const m = pick([0, 150, 250, 350, 600, 800, 950, 1050, 1300])
          r = restartedRound(r, route, m, 15)
          label = `restart ${m}`
        } else {
          r = reconcile(r)
          label = 'reconcile'
        }
        holds(r, along, `${where} (${label})`)
      }
    }
  })
})
