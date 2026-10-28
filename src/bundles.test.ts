import { describe, expect, it } from 'vitest'
import {
  BUNDLE_BEHIND_M,
  BUNDLE_STATUS_LABEL,
  bundleAheadText,
  bundleLine,
  bundleList,
  bundleTotals,
  bundleTotalsText,
  canMarkDropped,
  bundleStops,
  markDropped,
  markMissed,
  nextBundle,
  nextBundleLine,
  nextBundleSpeech,
  otherPasses,
  papersText,
  passState,
  passStates,
  reconcile,
  settleDrops,
  undoDropped,
  UNNAMED_BUNDLE,
  type BundleItem,
  type BundleStatus,
  type PassState,
} from './bundles'
import { approachingOccurrences, occurrences, type Occurrence } from './geo'
import type { Pt, RoundState, Route, Stop } from './types'

/** An occurrence of a bundle drop `at` metres along the route, by hand so that the distances are exact. */
const bundle = (id: string, at: number, extra: Partial<Stop> = {}, key = id): Occurrence => ({
  key,
  stop: { id, type: 'bundle', lat: -33.87, lng: 151.2, pathIdx: 0, ...extra },
  idx: 0,
  at,
  off: 0,
})
const other = (id: string, type: 'nothrow' | 'request', at: number): Occurrence => ({ ...bundle(id, at), stop: { id, type, lat: -33.87, lng: 151.2, pathIdx: 0 } })

const round = (extra: Partial<RoundState> = {}): RoundState => ({ handledStopIds: [], ...extra })
const statuses = (list: BundleItem[]) => list.map((b) => [b.key, b.status])
const keys = (list: BundleItem[]) => list.map((b) => b.key)

describe('listing the bundle drops', () => {
  const occs = [bundle('a', 100), bundle('b', 400), bundle('c', 900)]

  it('lists only the bundle drops, in the order the route reaches them', () => {
    const mixed = [other('n', 'nothrow', 50), bundle('c', 900), bundle('a', 100), other('r', 'request', 300), bundle('b', 400)]
    expect(keys(bundleList(mixed, round(), 0))).toEqual(['a', 'b', 'c'])
  })

  it('has nothing for a route with no bundle drops', () => {
    expect(bundleList([], round(), 0)).toEqual([])
    expect(bundleList([other('n', 'nothrow', 50)], round(), 0)).toEqual([])
  })

  it('gives how far ahead each is, negative once the driver is past it', () => {
    expect(bundleList(occs, round(), 250).map((b) => b.ahead)).toEqual([-150, 150, 650])
    expect(bundleList(occs, round(), 0).map((b) => b.ahead)).toEqual([100, 400, 900])
  })

  it('gives where along the route each is', () => {
    expect(bundleList(occs, round(), 250).map((b) => b.at)).toEqual([100, 400, 900])
  })

  it('does not change the occurrences it is given, or their order', () => {
    const given = [bundle('c', 900), bundle('a', 100)]
    const copy = structuredClone(given)
    bundleList(given, round(), 0)
    expect(given).toEqual(copy)
  })

  describe('what each place is called', () => {
    const named = (extra: Partial<Stop>) => bundleList([bundle('a', 10, extra)], round(), 0)[0]

    it('is its name, with the address to show under it', () => {
      expect(named({ label: 'Co-op', address: '12 Oak Road, Lewes' })).toMatchObject({ name: 'Co-op', address: '12 Oak Road, Lewes' })
    })

    it('is its address when it has no name, with nothing to show under it', () => {
      expect(named({ address: '12 Oak Road, Lewes' })).toMatchObject({ name: '12 Oak Road, Lewes', address: null })
    })

    it('is its name when that is all it has', () => {
      expect(named({ label: 'Co-op' })).toMatchObject({ name: 'Co-op', address: null })
    })

    it('is "Bundle drop" when it has neither', () => {
      expect(named({})).toMatchObject({ name: UNNAMED_BUNDLE, address: null })
      expect(UNNAMED_BUNDLE).toBe('Bundle drop')
    })

    it('goes by the address when the name is only spaces, and trims what it shows', () => {
      expect(named({ label: '   ', address: ' 3 High Street ' })).toMatchObject({ name: '3 High Street', address: null })
      expect(named({ label: ' Spar ', address: ' 3 High Street ' })).toMatchObject({ name: 'Spar', address: '3 High Street' })
      expect(named({ label: ' ', address: ' ' })).toMatchObject({ name: UNNAMED_BUNDLE, address: null })
    })

    it('keeps the stop it is for', () => {
      expect(named({ label: 'Co-op' }).stopId).toBe('a')
    })
  })

  describe('how many papers', () => {
    const papers = (qty: number | undefined) => bundleList([bundle('a', 10, { qty })], round(), 0)[0].papers

    it('is the amount set for the stop', () => {
      expect(papers(12)).toBe(12)
      expect(papers(1)).toBe(1)
    })

    it('is null when no amount was set', () => {
      expect(papers(undefined)).toBeNull()
      expect(papers(0)).toBeNull()
    })
  })

  describe('what became of each', () => {
    it('is next for the first and later for the rest, before any is done', () => {
      expect(statuses(bundleList(occs, round(), 0))).toEqual([
        ['a', 'next'],
        ['b', 'later'],
        ['c', 'later'],
      ])
    })

    it('is dropped for one done and in the dropped list', () => {
      const list = bundleList(occs, round({ handledStopIds: ['a'], dropped: ['a'] }), 150)
      expect(statuses(list)).toEqual([
        ['a', 'dropped'],
        ['b', 'next'],
        ['c', 'later'],
      ])
    })

    it('is missed for one done and in the missed list', () => {
      const list = bundleList(occs, round({ handledStopIds: ['a'], missed: ['a'] }), 150)
      expect(statuses(list)).toEqual([
        ['a', 'missed'],
        ['b', 'next'],
        ['c', 'later'],
      ])
    })

    it('is skipped for one done that is in neither list', () => {
      const list = bundleList(occs, round({ handledStopIds: ['a', 'b'], dropped: ['b'] }), 450)
      expect(statuses(list)).toEqual([
        ['a', 'skipped'],
        ['b', 'dropped'],
        ['c', 'next'],
      ])
    })

    it('keeps all five apart in one list', () => {
      const five = [bundle('a', 100), bundle('b', 200), bundle('c', 300), bundle('d', 400), bundle('e', 500)]
      const list = bundleList(five, round({ handledStopIds: ['a', 'b', 'c'], dropped: ['a'], missed: ['b'] }), 350)
      expect(statuses(list)).toEqual([
        ['a', 'dropped'],
        ['b', 'missed'],
        ['c', 'skipped'],
        ['d', 'next'],
        ['e', 'later'],
      ])
    })

    it('has no next once every one is done', () => {
      const list = bundleList(occs, round({ handledStopIds: ['a', 'b', 'c'], dropped: ['a', 'b', 'c'] }), 1000)
      expect(list.every((b) => b.status === 'dropped')).toBe(true)
      expect(list.some((b) => b.status === 'next')).toBe(false)
    })

    it('is next for exactly one bundle, whatever the round', () => {
      for (const along of [0, 50, 100, 250, 400, 899, 900, 5000]) {
        expect(bundleList(occs, round(), along).filter((b) => b.status === 'next').length, `at ${along}`).toBeLessThanOrEqual(1)
      }
    })

    it('does not make a done bundle the next, however near the driver is', () => {
      const list = bundleList(occs, round({ handledStopIds: ['a'] }), 100)
      expect(list[0].status).toBe('skipped')
      expect(list[1].status).toBe('next')
    })

    it('ignores a dropped or missed key that is not among those done', () => {
      const list = bundleList(occs, round({ handledStopIds: [], dropped: ['a'], missed: ['b'] }), 0)
      expect(statuses(list)).toEqual([
        ['a', 'next'],
        ['b', 'later'],
        ['c', 'later'],
      ])
    })

    it('says dropped when a key is in both lists, as dropped is the one the driver confirmed', () => {
      const list = bundleList(occs, round({ handledStopIds: ['a'], dropped: ['a'], missed: ['a'] }), 150)
      expect(list[0].status).toBe('dropped')
    })
  })

  describe('which is next', () => {
    it('is the first not done that is not behind the driver', () => {
      expect(nextBundle(bundleList(occs, round(), 300))?.key).toBe('b')
    })

    it('is one the driver is right at, even a little way past it', () => {
      expect(nextBundle(bundleList(occs, round(), 100 + BUNDLE_BEHIND_M))?.key).toBe('a')
    })

    it('moves on once the driver is more than 10 m past it', () => {
      expect(BUNDLE_BEHIND_M).toBe(10)
      expect(nextBundle(bundleList(occs, round(), 110.01))?.key).toBe('b')
      expect(nextBundle(bundleList(occs, round(), 110))?.key).toBe('a')
    })

    it('skips one that is not done but is behind, which stays later and says it is behind', () => {
      const list = bundleList(occs, round(), 450)
      expect(statuses(list)).toEqual([
        ['a', 'later'],
        ['b', 'later'],
        ['c', 'next'],
      ])
      expect(list.map((b) => b.behind)).toEqual([true, true, false])
    })

    it('is nothing when the only ones left are behind', () => {
      const list = bundleList(occs, round({ handledStopIds: ['a'], dropped: ['a'] }), 1000)
      expect(nextBundle(list)).toBeNull()
      expect(statuses(list)).toEqual([
        ['a', 'dropped'],
        ['b', 'later'],
        ['c', 'later'],
      ])
    })

    it('goes by the distance given for being behind', () => {
      expect(nextBundle(bundleList(occs, round(), 130, 40))?.key).toBe('a')
      expect(nextBundle(bundleList(occs, round(), 141, 40))?.key).toBe('b')
    })

    it('is null for an empty list', () => {
      expect(nextBundle([])).toBeNull()
    })
  })

  describe('a street driven twice', () => {
    // North 600 m and back down the same line: x is met going out and coming back, z too, y only at the top.
    const spot = (x: number, y: number): Pt => ({ lat: -33.87 + y / 111_195, lng: 151.2 + x / (111_195 * Math.cos((33.87 * Math.PI) / 180)) })
    const doubled: Route = {
      points: [spot(0, 0), spot(0, 600), spot(0, 0)],
      sideChanges: [{ idx: 0, side: 'both' }],
      stops: [
        { id: 'x', type: 'bundle', ...spot(6, 100), pathIdx: 0, label: 'Corner shop', qty: 6 },
        { id: 'z', type: 'bundle', ...spot(6, 400), pathIdx: 0, qty: 10 },
        { id: 'y', type: 'bundle', ...spot(6, 600), pathIdx: 0, address: '9 Top Road' },
        { id: 'n', type: 'nothrow', ...spot(6, 300), pathIdx: 0 },
      ],
    }
    const occs2 = occurrences(doubled)

    it('lists a bundle for each time through, in the order the route reaches them', () => {
      const list = bundleList(occs2, round(), 0)
      expect(keys(list)).toEqual(['x', 'z', 'y', 'z#2', 'x#2'])
      expect(list.map((b) => b.stopId)).toEqual(['x', 'z', 'y', 'z', 'x'])
      expect(list.map((b) => b.at)).toEqual([...list.map((b) => b.at)].sort((a, b) => a - b))
    })

    it('numbers the times through, and says how many there are', () => {
      const list = bundleList(occs2, round(), 0)
      expect(list.map((b) => [b.key, b.pass, b.passes])).toEqual([
        ['x', 1, 2],
        ['z', 1, 2],
        ['y', 1, 1],
        ['z#2', 2, 2],
        ['x#2', 2, 2],
      ])
    })

    it('has the same name and amount for both times through', () => {
      const list = bundleList(occs2, round(), 0)
      expect(list.filter((b) => b.stopId === 'x').map((b) => [b.name, b.papers])).toEqual([
        ['Corner shop', 6],
        ['Corner shop', 6],
      ])
    })

    it('keeps each time through apart, with the second covered by the drop of the first', () => {
      const list = bundleList(occs2, round({ handledStopIds: ['x', 'z', 'y'], dropped: ['x'], missed: ['z'] }), 650)
      expect(statuses(list)).toEqual([
        ['x', 'dropped'],
        ['z', 'missed'],
        ['y', 'skipped'],
        ['z#2', 'next'],
        ['x#2', 'skipped'],
      ])
      expect(list.map((b) => b.coveredBy)).toEqual([null, null, null, null, 1])
      expect(list[3].ahead).toBeGreaterThan(0)
      expect(list[4].ahead).toBeGreaterThan(list[3].ahead)
    })

    it('takes a key it cannot read a time through from as the first', () => {
      const odd = [bundle('a', 100, {}, 'a'), bundle('a', 300, {}, 'a#oops'), bundle('a', 500, {}, 'a#0'), bundle('a', 700, {}, 'a#1.5')]
      expect(bundleList(odd, round(), 0).map((b) => b.pass)).toEqual([1, 1, 1, 1])
    })

    it('does not list the no-throw house', () => {
      expect(bundleList(occs2, round(), 0).some((b) => b.stopId === 'n')).toBe(false)
    })

    it('counts a stop the route goes by twice once in the totals, papers included', () => {
      const totals = bundleTotals(bundleList(occs2, round(), 0))
      expect(totals.total).toBe(3)
      expect(totals.toDrop).toBe(3)
      expect(totals.toDropPapers).toBe(6 + 10)
    })
  })

  describe('old saved rounds', () => {
    it('read as before: the stops done are skipped, not dropped or missed', () => {
      const old: RoundState = { handledStopIds: ['a', 'b'], furthest: 500 }
      expect(statuses(bundleList(occs, old, 450))).toEqual([
        ['a', 'skipped'],
        ['b', 'skipped'],
        ['c', 'next'],
      ])
    })
  })
})

describe('adding up the bundle drops', () => {
  const items = (): BundleItem[] => {
    const occs = [
      bundle('a', 100, { qty: 12 }),
      bundle('b', 200, { qty: 8 }),
      bundle('c', 300, { qty: 5 }),
      bundle('d', 400, { qty: 20 }),
      bundle('e', 500),
      bundle('f', 600, { qty: 3 }),
    ]
    return bundleList(occs, round({ handledStopIds: ['a', 'b', 'c'], dropped: ['a'], missed: ['b'] }), 350)
  }

  it('counts each state', () => {
    expect(bundleTotals(items())).toMatchObject({ total: 6, dropped: 1, missed: 1, skipped: 1, toDrop: 3 })
  })

  it('adds up the papers dropped, missed and still to drop apart', () => {
    expect(bundleTotals(items())).toMatchObject({ droppedPapers: 12, missedPapers: 8, toDropPapers: 23 })
  })

  it('leaves out the papers of a bundle that was skipped over', () => {
    const t = bundleTotals(items())
    expect(t.droppedPapers + t.missedPapers + t.toDropPapers).toBe(12 + 8 + 20 + 3)
  })

  it('counts a bundle with no amount as a bundle that adds no papers', () => {
    const t = bundleTotals(items())
    expect(t.toDrop).toBe(3)
    expect(t.toDropPapers).toBe(20 + 3)
  })

  it('counts a bundle not done and behind the driver as still to drop', () => {
    const t = bundleTotals(bundleList([bundle('a', 100, { qty: 4 }), bundle('b', 500, { qty: 6 })], round(), 300))
    expect(t).toMatchObject({ toDrop: 2, toDropPapers: 10 })
  })

  it('is all zeros for no bundles', () => {
    expect(bundleTotals([])).toEqual({ total: 0, dropped: 0, missed: 0, skipped: 0, toDrop: 0, droppedPapers: 0, missedPapers: 0, toDropPapers: 0 })
  })

  it('drops by one and adds the papers when a missed bundle is marked dropped', () => {
    const occs = [bundle('a', 100, { qty: 12 }), bundle('b', 200, { qty: 8 })]
    let r = reconcile(round({ handledStopIds: ['a', 'b'], missed: ['a'], dropped: ['b'] }))
    expect(bundleTotals(bundleList(occs, r, 300))).toMatchObject({ dropped: 1, missed: 1, droppedPapers: 8, missedPapers: 12 })
    r = markDropped(r, 'a')
    expect(bundleTotals(bundleList(occs, r, 300))).toMatchObject({ dropped: 2, missed: 0, droppedPapers: 20, missedPapers: 0 })
  })
})

describe('what the sheet offers', () => {
  it('offers Mark dropped for a missed bundle and one still to come, and for no other', () => {
    const offered: Record<BundleStatus, boolean> = { dropped: false, missed: true, skipped: false, next: false, later: true }
    for (const [status, yes] of Object.entries(offered)) expect(canMarkDropped({ status: status as BundleStatus }), status).toBe(yes)
  })

  it('has a word for every status', () => {
    expect(BUNDLE_STATUS_LABEL).toEqual({ dropped: 'Dropped', missed: 'Missed', skipped: 'Skipped', next: 'Next', later: 'Later' })
  })
})

describe('the words for papers and distances', () => {
  it('says how many papers as an alert does', () => {
    expect(papersText(12)).toBe('12 papers')
    expect(papersText(1)).toBe('1 paper')
    expect(papersText(null)).toBeNull()
  })

  it('says how far away a bundle is', () => {
    expect(bundleAheadText(340)).toBe('340 m')
    expect(bundleAheadText(344)).toBe('340 m')
    expect(bundleAheadText(346)).toBe('350 m')
    expect(bundleAheadText(15)).toBe('20 m')
    expect(bundleAheadText(1234)).toBe('1.2 km')
    expect(bundleAheadText(5000)).toBe('5.0 km')
    expect(bundleAheadText(996)).toBe('1.0 km')
    expect(bundleAheadText(994)).toBe('990 m')
  })

  it('says Now when it is right here, and Passed once it is behind', () => {
    expect(bundleAheadText(14.9)).toBe('Now')
    expect(bundleAheadText(0)).toBe('Now')
    expect(bundleAheadText(-9.9)).toBe('Now')
    expect(bundleAheadText(-10)).toBe('Passed')
    expect(bundleAheadText(-300)).toBe('Passed')
  })
})

describe('the line for the next bundle', () => {
  const first = (extra: Partial<Stop>, along = 0) => bundleList([bundle('a', 340, extra)], round(), along)[0]

  it('names the place, how far it is and how many papers', () => {
    expect(nextBundleLine(first({ label: 'Co-op', qty: 12 }))).toBe('Next bundle: Co-op · 340 m · 12 papers')
  })

  it('says 1 paper for one', () => {
    expect(nextBundleLine(first({ label: 'Co-op', qty: 1 }))).toBe('Next bundle: Co-op · 340 m · 1 paper')
  })

  it('leaves the papers out when there is no amount', () => {
    expect(nextBundleLine(first({ label: 'Co-op' }))).toBe('Next bundle: Co-op · 340 m')
  })

  it('uses the address for a place with no name, and Bundle drop for one with neither', () => {
    expect(nextBundleLine(first({ address: '3 High Street', qty: 4 }))).toBe('Next bundle: 3 High Street · 340 m · 4 papers')
    expect(nextBundleLine(first({}))).toBe('Next bundle: Bundle drop · 340 m')
  })

  it('says Now when the driver is at it, and counts kilometres', () => {
    expect(nextBundleLine(first({ label: 'Co-op' }, 335))).toBe('Next bundle: Co-op · Now')
    expect(nextBundleLine(bundleList([bundle('a', 1700, { label: 'Co-op', qty: 2 })], round(), 0)[0])).toBe('Next bundle: Co-op · 1.7 km · 2 papers')
  })

  describe('on the bar', () => {
    const occs = [bundle('a', 100, { label: 'Spar', qty: 6 }), bundle('b', 800, { label: 'Co-op', qty: 12 })]

    it('is the next bundle', () => {
      expect(bundleLine(bundleList(occs, round(), 0))).toBe('Next bundle: Spar · 100 m · 6 papers')
      expect(bundleLine(bundleList(occs, round({ handledStopIds: ['a'], dropped: ['a'] }), 150))).toBe('Next bundle: Co-op · 650 m · 12 papers')
    })

    it('is nothing when the route has no bundle drops', () => {
      expect(bundleLine([])).toBeNull()
    })

    it('says all are dropped once they are', () => {
      expect(bundleLine(bundleList(occs, round({ handledStopIds: ['a', 'b'], dropped: ['a', 'b'] }), 900))).toBe('All bundles dropped')
    })

    it('says how many are missed when there is none left ahead', () => {
      expect(bundleLine(bundleList(occs, round({ handledStopIds: ['a', 'b'], dropped: ['a'], missed: ['b'] }), 900))).toBe('No more bundles ahead · 1 missed')
      expect(bundleLine(bundleList(occs, round({ handledStopIds: ['a', 'b'], missed: ['a', 'b'] }), 900))).toBe('No more bundles ahead · 2 missed')
    })

    it('just says there are no more when the rest were skipped', () => {
      expect(bundleLine(bundleList(occs, round({ handledStopIds: ['a', 'b'], dropped: ['a'] }), 900))).toBe('No more bundles ahead')
    })
  })
})

describe('the sheet summary', () => {
  it('says what is dropped and what is to drop, and the missed when there are some', () => {
    const occs = [bundle('a', 100, { qty: 12 }), bundle('b', 200, { qty: 8 }), bundle('c', 300, { qty: 1 })]
    const list = bundleList(occs, round({ handledStopIds: ['a', 'b'], dropped: ['a'], missed: ['b'] }), 250)
    expect(bundleTotalsText(bundleTotals(list))).toBe('12 papers dropped · 1 paper to drop · 1 missed')
  })

  it('leaves the missed out when there are none', () => {
    const list = bundleList([bundle('a', 100, { qty: 12 })], round(), 0)
    expect(bundleTotalsText(bundleTotals(list))).toBe('0 papers dropped · 12 papers to drop')
  })

  it('is empty for no bundles', () => {
    expect(bundleTotalsText(bundleTotals([]))).toBe('')
  })
})

describe('what is said after a drop', () => {
  const next = (ahead: number, extra: Partial<Stop> = {}) => bundleList([bundle('a', ahead, extra)], round(), 0)[0]

  it('names the next bundle and how far it is', () => {
    expect(nextBundleSpeech(next(300, { label: 'Co-op' }))).toBe('Next bundle, Co-op, 300 metres')
    expect(nextBundleSpeech(next(80, { label: 'Co-op' }))).toBe('Next bundle, Co-op, 80 metres')
  })

  it('says kilometres a long way off', () => {
    expect(nextBundleSpeech(next(1500, { label: 'Co-op' }))).toBe('Next bundle, Co-op, 1.5 kilometres')
    expect(nextBundleSpeech(next(2000, { label: 'Co-op' }))).toBe('Next bundle, Co-op, 2 kilometres')
  })

  it('goes by the address, or Bundle drop', () => {
    expect(nextBundleSpeech(next(300, { address: 'Oak Road' }))).toBe('Next bundle, Oak Road, 300 metres')
    expect(nextBundleSpeech(next(300))).toBe('Next bundle, Bundle drop, 300 metres')
  })

  it('leaves the distance out when it is right there', () => {
    expect(nextBundleSpeech(next(5, { label: 'Co-op' }))).toBe('Next bundle, Co-op')
  })
})

describe('making a round consistent', () => {
  it('keeps what was dropped or missed while it is still done', () => {
    const r = reconcile({ handledStopIds: ['a', 'b', 'c'], dropped: ['a'], missed: ['b'] })
    expect(r).toEqual({ handledStopIds: ['a', 'b', 'c'], dropped: ['a'], missed: ['b'] })
  })

  it('forgets what is no longer among the stops done', () => {
    const r = reconcile({ handledStopIds: ['a'], dropped: ['a', 'x'], missed: ['y', 'z'] })
    expect(r).toEqual({ handledStopIds: ['a'], dropped: ['a'] })
  })

  it('forgets every one when none is done', () => {
    expect(reconcile({ handledStopIds: [], dropped: ['a'], missed: ['b'] })).toEqual({ handledStopIds: [] })
  })

  it('leaves a key in the dropped list only, when it is in both', () => {
    expect(reconcile({ handledStopIds: ['a', 'b'], dropped: ['a', 'b'], missed: ['a'] })).toEqual({ handledStopIds: ['a', 'b'], dropped: ['a', 'b'] })
  })

  it('leaves out empty lists, as a round with none has none', () => {
    const r = reconcile({ handledStopIds: ['a'], dropped: [], missed: [] })
    expect(Object.keys(r)).toEqual(['handledStopIds'])
    expect(Object.keys(reconcile({ handledStopIds: ['a'] }))).toEqual(['handledStopIds'])
  })

  it('removes repeats, keeping the order', () => {
    expect(reconcile({ handledStopIds: ['a', 'b', 'c'], dropped: ['c', 'a', 'c', 'a'], missed: ['b', 'b'] })).toEqual({
      handledStopIds: ['a', 'b', 'c'],
      dropped: ['c', 'a'],
      missed: ['b'],
    })
  })

  it('drops anything that is not a key, and a list that is not a list', () => {
    const r = reconcile({ handledStopIds: ['a', 'b'], dropped: ['a', 7, null, {}] as unknown as string[], missed: 'b' as unknown as string[] })
    expect(r).toEqual({ handledStopIds: ['a', 'b'], dropped: ['a'] })
  })

  it('keeps how far the round got and where it started, and the stops done as they are', () => {
    const r = reconcile({ handledStopIds: ['b', 'a'], furthest: 300, startM: 120, dropped: ['a'] })
    expect(r).toEqual({ handledStopIds: ['b', 'a'], furthest: 300, startM: 120, dropped: ['a'] })
  })

  it('does not change the round it is given, and does not share its lists', () => {
    const given: RoundState = { handledStopIds: ['a'], dropped: ['a', 'x'], missed: [] }
    const copy = structuredClone(given)
    const r = reconcile(given)
    expect(given).toEqual(copy)
    expect(r).not.toBe(given)
    expect(r.handledStopIds).not.toBe(given.handledStopIds)
    expect(r.dropped).not.toBe(given.dropped)
  })

  it('is the same again when it is done twice', () => {
    const once = reconcile({ handledStopIds: ['a', 'b'], dropped: ['a', 'x', 'b'], missed: ['b', 'a'] })
    expect(reconcile(once)).toEqual(once)
  })
})

describe('marking a bundle dropped', () => {
  it('does it: the bundle is done and dropped', () => {
    expect(markDropped(round(), 'a')).toEqual({ handledStopIds: ['a'], dropped: ['a'] })
  })

  it('adds it after the stops done and the bundles dropped already', () => {
    const r = markDropped({ handledStopIds: ['x', 'y'], dropped: ['x'], furthest: 300, startM: 40 }, 'b')
    expect(r).toEqual({ handledStopIds: ['x', 'y', 'b'], dropped: ['x', 'b'], furthest: 300, startM: 40 })
  })

  it('is not missed any more when it was', () => {
    const r = markDropped({ handledStopIds: ['a', 'b'], missed: ['a', 'b'] }, 'a')
    expect(r).toEqual({ handledStopIds: ['a', 'b'], dropped: ['a'], missed: ['b'] })
  })

  it('drops a bundle that was skipped over, which is done already', () => {
    expect(markDropped({ handledStopIds: ['a', 'b'] }, 'b')).toEqual({ handledStopIds: ['a', 'b'], dropped: ['b'] })
  })

  it('changes nothing when it is dropped already', () => {
    const r = { handledStopIds: ['a', 'b'], dropped: ['a', 'b'], furthest: 5 }
    expect(markDropped(r, 'a')).toEqual(r)
  })

  it('drops one time through and not the other', () => {
    const r = markDropped(round(), 'b')
    expect(r.dropped).toEqual(['b'])
    expect(r.handledStopIds).not.toContain('b#2')
  })

  it('does not change the round it is given', () => {
    const given: RoundState = { handledStopIds: ['a'], missed: ['a'] }
    const copy = structuredClone(given)
    const r = markDropped(given, 'a')
    expect(given).toEqual(copy)
    expect(r).not.toBe(given)
  })

  it('shows as dropped in the list', () => {
    const occs = [bundle('a', 100), bundle('b', 200)]
    const list = bundleList(occs, markDropped(round(), 'a'), 120)
    expect(statuses(list)).toEqual([
      ['a', 'dropped'],
      ['b', 'next'],
    ])
  })
})

describe('taking back a drop', () => {
  it('puts the bundle back to not done', () => {
    expect(undoDropped({ handledStopIds: ['a'], dropped: ['a'] }, 'a')).toEqual({ handledStopIds: [] })
  })

  it('undoes marking it exactly', () => {
    const before: RoundState = { handledStopIds: ['x', 'y'], dropped: ['x'], missed: ['y'], furthest: 300, startM: 40 }
    expect(undoDropped(markDropped(before, 'b'), 'b')).toEqual(before)
  })

  it('leaves the other stops done and bundles dropped, and the progress, alone', () => {
    const r = undoDropped({ handledStopIds: ['x', 'b', 'y'], dropped: ['x', 'b'], missed: ['y'], furthest: 300, startM: 40 }, 'b')
    expect(r).toEqual({ handledStopIds: ['x', 'y'], dropped: ['x'], missed: ['y'], furthest: 300, startM: 40 })
  })

  it('takes back one time through only', () => {
    const r = undoDropped({ handledStopIds: ['b', 'b#2'], dropped: ['b', 'b#2'] }, 'b#2')
    expect(r).toEqual({ handledStopIds: ['b'], dropped: ['b'] })
  })

  it('does nothing to a bundle that is not dropped: skipped over, missed, or not done', () => {
    const r: RoundState = { handledStopIds: ['s', 'm'], missed: ['m'] }
    expect(undoDropped(r, 's')).toEqual(r)
    expect(undoDropped(r, 'm')).toEqual(r)
    expect(undoDropped(r, 'never')).toEqual(r)
  })

  it('does nothing after the round has been started over', () => {
    expect(undoDropped({ handledStopIds: [] }, 'a')).toEqual({ handledStopIds: [] })
  })

  it('does not change the round it is given', () => {
    const given: RoundState = { handledStopIds: ['a'], dropped: ['a'] }
    const copy = structuredClone(given)
    undoDropped(given, 'a')
    expect(given).toEqual(copy)
  })

  it('brings the bundle back as the next one', () => {
    const occs = [bundle('a', 100), bundle('b', 200)]
    const list = bundleList(occs, undoDropped(markDropped(round(), 'a'), 'a'), 100)
    expect(list[0].status).toBe('next')
  })
})

describe('marking bundles missed', () => {
  it('records the bundles that are done and not dropped', () => {
    expect(markMissed({ handledStopIds: ['a', 'b'] }, ['a', 'b'])).toEqual({ handledStopIds: ['a', 'b'], missed: ['a', 'b'] })
  })

  it('leaves out a bundle that is not done', () => {
    expect(markMissed({ handledStopIds: ['a'] }, ['a', 'b'])).toEqual({ handledStopIds: ['a'], missed: ['a'] })
    expect(markMissed(round(), ['a'])).toEqual({ handledStopIds: [] })
  })

  it('leaves out a bundle that was dropped', () => {
    const r = markMissed({ handledStopIds: ['a', 'b'], dropped: ['a'] }, ['a', 'b'])
    expect(r).toEqual({ handledStopIds: ['a', 'b'], dropped: ['a'], missed: ['b'] })
  })

  it('records only the bundle drops among the keys, when it is told which they are', () => {
    const r = markMissed({ handledStopIds: ['a', 'n', 'b'] }, ['a', 'n', 'b'], new Set(['a', 'b']))
    expect(r.missed).toEqual(['a', 'b'])
  })

  it('records nothing when none of the keys is a bundle', () => {
    expect(markMissed({ handledStopIds: ['n'] }, ['n'], new Set(['a']))).toEqual({ handledStopIds: ['n'] })
  })

  it('adds to those missed already, once each', () => {
    const r = markMissed({ handledStopIds: ['a', 'b', 'c'], missed: ['a'] }, ['b', 'a', 'b'])
    expect(r.missed).toEqual(['a', 'b'])
  })

  it('keeps the progress and what was dropped', () => {
    const r = markMissed({ handledStopIds: ['a', 'b'], dropped: ['a'], furthest: 200, startM: 50 }, ['b'])
    expect(r).toEqual({ handledStopIds: ['a', 'b'], dropped: ['a'], missed: ['b'], furthest: 200, startM: 50 })
  })

  it('does nothing for no keys', () => {
    expect(markMissed({ handledStopIds: ['a'], dropped: ['a'] }, [])).toEqual({ handledStopIds: ['a'], dropped: ['a'] })
  })

  it('does not change the round it is given', () => {
    const given: RoundState = { handledStopIds: ['a'] }
    const copy = structuredClone(given)
    const r = markMissed(given, ['a'])
    expect(given).toEqual(copy)
    expect(r).not.toBe(given)
  })

  it('shows as missed in the list, and can be marked dropped after', () => {
    const occs = [bundle('a', 100, { qty: 5 }), bundle('b', 300)]
    const passed = markMissed({ handledStopIds: ['a'] }, ['a'])
    expect(statuses(bundleList(occs, passed, 150))).toEqual([
      ['a', 'missed'],
      ['b', 'next'],
    ])
    expect(statuses(bundleList(occs, markDropped(passed, 'a'), 150))[0]).toEqual(['a', 'dropped'])
  })
})

describe('a round through its stops', () => {
  const occs = [bundle('a', 100, { qty: 10 }), bundle('b', 300, { qty: 5 }), bundle('c', 500, { qty: 7 }), bundle('d', 700, { qty: 2 })]

  it('goes from alert to dropped, passed to missed, and skipped over', () => {
    let r = round({ furthest: 0 })
    // a: the driver taps Dropped.
    r = markDropped(r, 'a')
    // b: driven past in its zone with no tap.
    r = markMissed(reconcile({ ...r, handledStopIds: [...r.handledStopIds, 'b'] }), ['b'])
    // c: skipped over by skipping ahead to a spot after it.
    r = reconcile({ ...r, handledStopIds: [...r.handledStopIds, 'c'] })
    expect(statuses(bundleList(occs, r, 650))).toEqual([
      ['a', 'dropped'],
      ['b', 'missed'],
      ['c', 'skipped'],
      ['d', 'next'],
    ])
    expect(bundleTotals(bundleList(occs, r, 650))).toMatchObject({ droppedPapers: 10, missedPapers: 5, toDropPapers: 2, skipped: 1 })
  })

  it('forgets a drop once the round is carried on from a place before it', () => {
    const r: RoundState = { handledStopIds: ['a', 'b', 'c'], dropped: ['a', 'c'], missed: ['b'], startM: 600, furthest: 600 }
    // Carrying on from 250 m: only a is done now. (The same list the restart builds, see handledForResume.)
    const back = reconcile({ ...r, handledStopIds: ['a'], startM: 250, furthest: 250 })
    expect(back).toEqual({ handledStopIds: ['a'], dropped: ['a'], startM: 250, furthest: 250 })
  })

  it('forgets every drop when the round is started over', () => {
    expect(reconcile({ handledStopIds: [], dropped: ['a'], missed: ['b'] })).toEqual({ handledStopIds: [] })
  })

  it('keeps a drop when the round skips ahead of it and marks more as done', () => {
    const r: RoundState = { handledStopIds: ['a'], dropped: ['a'] }
    const ahead = reconcile({ ...r, handledStopIds: ['a', 'b', 'c'], startM: 600 })
    expect(ahead).toEqual({ handledStopIds: ['a', 'b', 'c'], dropped: ['a'], startM: 600 })
  })
})

describe('a stop the route goes by twice is one delivery', () => {
  // The Co-op (12 papers) is on a street the route goes up and back down: met at 500 m and again at 3500 m. The school (5 papers) is passed once,
  // between them, and the garage (3 papers) is on a street gone by three times.
  const coop = (at: number, key: string) => bundle('coop', at, { label: 'Co-op', qty: 12 }, key)
  const occs = [
    coop(500, 'coop'),
    bundle('school', 1500, { label: 'School', qty: 5 }),
    bundle('garage', 2000, { label: 'Garage', qty: 3 }, 'garage'),
    bundle('garage', 2600, { label: 'Garage', qty: 3 }, 'garage#2'),
    bundle('garage', 3100, { label: 'Garage', qty: 3 }, 'garage#3'),
    coop(3500, 'coop#2'),
  ]
  const states = (r: RoundState, ...ks: string[]) => ks.map((k) => passState(r, k))
  const sorted = (r: RoundState) => ({ handled: [...r.handledStopIds].sort(), dropped: [...(r.dropped ?? [])].sort(), missed: [...(r.missed ?? [])].sort() })

  describe('which passes a drop settles', () => {
    it('are the other times the route goes by the stop, in route order', () => {
      expect(otherPasses(occs, 'coop')).toEqual(['coop#2'])
      expect(otherPasses(occs, 'coop#2')).toEqual(['coop'])
      expect(otherPasses(occs, 'garage#2')).toEqual(['garage', 'garage#3'])
      expect(otherPasses([...occs].reverse(), 'garage')).toEqual(['garage#2', 'garage#3'])
    })

    it('are none for a stop the route goes by once, and for a key that is not on the route', () => {
      expect(otherPasses(occs, 'school')).toEqual([])
      expect(otherPasses(occs, 'nobody')).toEqual([])
      expect(otherPasses([], 'coop')).toEqual([])
    })

    it('do not include the passes of any other stop', () => {
      expect(otherPasses([...occs, bundle('other', 700)], 'coop')).toEqual(['coop#2'])
    })
  })

  describe('where a pass stands', () => {
    const r: RoundState = { handledStopIds: ['a', 'b', 'c'], dropped: ['a'], missed: ['b'] }

    it('is open, skipped, missed or dropped', () => {
      expect(states(r, 'a', 'b', 'c', 'd')).toEqual(['dropped', 'missed', 'skipped', 'open'])
    })

    it('is kept for some passes in one go', () => {
      expect(passStates(r, ['d', 'b', 'a'])).toEqual(
        new Map<string, PassState>([
          ['d', 'open'],
          ['b', 'missed'],
          ['a', 'dropped'],
        ]),
      )
    })

    it('is dropped, as the list reads it, for a key in both lists', () => {
      expect(passState({ handledStopIds: ['a'], dropped: ['a'], missed: ['a'] }, 'a')).toBe('dropped')
    })

    it('is dropped for a key that is in the dropped list but not among those done, as the list reads it', () => {
      expect(passState({ handledStopIds: [], dropped: ['a'] }, 'a')).toBe('open')
    })
  })

  describe('dropping one pass', () => {
    it('settles a pass still to come: it is done, and neither dropped nor missed', () => {
      const r = markDropped(round(), 'coop', ['coop#2'])
      expect(r).toEqual({ handledStopIds: ['coop', 'coop#2'], dropped: ['coop'] })
      expect(states(r, 'coop', 'coop#2')).toEqual(['dropped', 'skipped'])
    })

    it('settles a pass that was missed: it is not missed any more', () => {
      const missed = markMissed({ handledStopIds: ['coop'] }, ['coop'])
      const r = markDropped(missed, 'coop#2', ['coop'])
      expect(r).toEqual({ handledStopIds: ['coop', 'coop#2'], dropped: ['coop#2'] })
      expect(r.missed).toBeUndefined()
    })

    it('settles every other pass of a stop the route goes by more than twice', () => {
      const r = markDropped(round({ handledStopIds: ['garage#3'], missed: ['garage#3'] }), 'garage#2', ['garage', 'garage#3'])
      expect(states(r, 'garage', 'garage#2', 'garage#3')).toEqual(['skipped', 'dropped', 'skipped'])
    })

    it('leaves a pass that was skipped over skipped, and one already dropped dropped', () => {
      const r = markDropped(round({ handledStopIds: ['garage', 'garage#3'], dropped: ['garage#3'] }), 'garage#2', ['garage', 'garage#3'])
      expect(states(r, 'garage', 'garage#2', 'garage#3')).toEqual(['skipped', 'dropped', 'dropped'])
    })

    it('leaves the passes of other stops alone', () => {
      const r = markDropped(round({ handledStopIds: ['school'], missed: ['school'] }), 'coop', ['coop#2'])
      expect(states(r, 'school')).toEqual(['missed'])
    })

    it('ignores its own key among the others, and a key listed twice', () => {
      expect(markDropped(round(), 'coop', ['coop', 'coop#2', 'coop#2'])).toEqual({ handledStopIds: ['coop', 'coop#2'], dropped: ['coop'] })
    })

    it('settles the others even when it is dropped already', () => {
      const r = markDropped({ handledStopIds: ['coop'], dropped: ['coop'] }, 'coop', ['coop#2'])
      expect(r).toEqual({ handledStopIds: ['coop', 'coop#2'], dropped: ['coop'] })
    })

    it('settles nothing when it is given no other passes, as before', () => {
      expect(markDropped(round(), 'coop')).toEqual({ handledStopIds: ['coop'], dropped: ['coop'] })
    })

    it('keeps how far the round got, and does not change the round it is given', () => {
      const given: RoundState = { handledStopIds: ['coop'], missed: ['coop'], furthest: 800, startM: 100 }
      const copy = structuredClone(given)
      const r = markDropped(given, 'coop#2', ['coop'])
      expect(given).toEqual(copy)
      expect(r).toMatchObject({ furthest: 800, startM: 100 })
    })

    it('never alerts for a settled pass', () => {
      // Up the road and back: the stop is met going out and again coming back. Drop it going out, and the way back has no alert for it.
      const spot = (x: number, y: number): Pt => ({ lat: -33.87 + y / 111_195, lng: 151.2 + x / (111_195 * Math.cos((33.87 * Math.PI) / 180)) })
      const route: Route = {
        points: [spot(0, 0), spot(0, 600), spot(0, 0)],
        sideChanges: [{ idx: 0, side: 'both' }],
        stops: [{ id: 'x', type: 'bundle', ...spot(6, 100), pathIdx: 0, label: 'Corner shop', qty: 6 }],
      }
      const all = occurrences(route)
      expect(all.map((o) => o.key)).toEqual(['x', 'x#2'])
      const there = spot(6, 100)
      const open = new Set<string>()
      expect(approachingOccurrences(all[1].at, there, all, open).map((o) => o.key)).toEqual(['x#2'])
      const dropped = markDropped(round(), 'x', otherPasses(all, 'x'))
      expect(approachingOccurrences(all[1].at, there, all, new Set(dropped.handledStopIds))).toEqual([])
      // Without the other passes settled, the second pass would alert again.
      expect(approachingOccurrences(all[1].at, there, all, new Set(markDropped(round(), 'x').handledStopIds)).map((o) => o.key)).toEqual(['x#2'])
    })
  })

  describe('how the list reads a settled pass', () => {
    const dropFirst = markDropped(round(), 'coop', ['coop#2'])

    it('is covered by the pass that was dropped, and skipped', () => {
      const list = bundleList(occs, dropFirst, 1000)
      expect(list.filter((b) => b.stopId === 'coop').map((b) => [b.key, b.status, b.coveredBy])).toEqual([
        ['coop', 'dropped', null],
        ['coop#2', 'skipped', 1],
      ])
    })

    it('is covered by the first pass dropped when more than one is', () => {
      const r: RoundState = { handledStopIds: ['garage', 'garage#2', 'garage#3'], dropped: ['garage', 'garage#3'] }
      const list = bundleList(occs, r, 3200).filter((b) => b.stopId === 'garage')
      expect(list.map((b) => [b.key, b.status, b.coveredBy])).toEqual([
        ['garage', 'dropped', null],
        ['garage#2', 'skipped', 1],
        ['garage#3', 'dropped', null],
      ])
    })

    it('says which pass, when it was the second that was dropped', () => {
      const list = bundleList(occs, markDropped(round(), 'coop#2', ['coop']), 1000)
      expect(list.filter((b) => b.stopId === 'coop').map((b) => [b.key, b.status, b.coveredBy])).toEqual([
        ['coop', 'skipped', 2],
        ['coop#2', 'dropped', null],
      ])
    })

    it('is covered even by a round kept before the drop settled it, so it never reads as missed or still to come', () => {
      const old: RoundState = { handledStopIds: ['coop'], dropped: ['coop'] }
      expect(bundleList(occs, old, 1000).find((b) => b.key === 'coop#2')).toMatchObject({ status: 'skipped', coveredBy: 1 })
      const missed: RoundState = { handledStopIds: ['coop', 'coop#2'], dropped: ['coop'], missed: ['coop#2'] }
      expect(bundleList(occs, missed, 3600).find((b) => b.key === 'coop#2')).toMatchObject({ status: 'skipped', coveredBy: 1 })
    })

    it('is never the next bundle, nor one to mark dropped', () => {
      const old: RoundState = { handledStopIds: ['coop', 'school', 'garage', 'garage#2', 'garage#3'], dropped: ['coop'] }
      const list = bundleList(occs, old, 3400)
      expect(nextBundle(list)).toBeNull()
      expect(list.find((b) => b.key === 'coop#2')).toMatchObject({ status: 'skipped' })
      expect(canMarkDropped(list.find((b) => b.key === 'coop#2')!)).toBe(false)
    })

    it('is not covered by a drop that is not among the stops done', () => {
      const list = bundleList(occs, { handledStopIds: [], dropped: ['coop'] }, 0)
      expect(list.find((b) => b.key === 'coop#2')).toMatchObject({ status: 'later', coveredBy: null })
    })

    it('leaves a pass of another stop as it is', () => {
      expect(bundleList(occs, dropFirst, 1000).find((b) => b.key === 'school')).toMatchObject({ status: 'next', coveredBy: null })
    })

    it('reads each pass dropped as dropped when more than one is', () => {
      const both = bundleList(occs, { handledStopIds: ['coop', 'coop#2'], dropped: ['coop', 'coop#2'] }, 3600).filter((b) => b.stopId === 'coop')
      expect(both.map((b) => [b.status, b.coveredBy])).toEqual([
        ['dropped', null],
        ['dropped', null],
      ])
    })

    it('says a pass that was not settled is still to come', () => {
      expect(bundleList(occs, round(), 0).filter((b) => b.stopId === 'coop').map((b) => [b.status, b.coveredBy])).toEqual([
        ['next', null],
        ['later', null],
      ])
    })
  })

  describe('adding up', () => {
    const totalsFor = (r: RoundState, along = 0) => bundleTotals(bundleList(occs, r, along))

    it('counts a stop once, however many times the route goes by it', () => {
      const t = totalsFor(round())
      expect(t).toMatchObject({ total: 3, toDrop: 3, dropped: 0, missed: 0, skipped: 0 })
      expect(t.toDropPapers).toBe(12 + 5 + 3)
    })

    it('counts the papers of a stop once when it is dropped on either pass', () => {
      expect(totalsFor(markDropped(round(), 'coop', ['coop#2']))).toMatchObject({ dropped: 1, droppedPapers: 12, toDrop: 2, toDropPapers: 5 + 3, missed: 0 })
      expect(totalsFor(markDropped(round(), 'coop#2', ['coop']), 3600)).toMatchObject({ dropped: 1, droppedPapers: 12 })
    })

    it('does not call a stop missed because its first pass was, while a pass is still to come', () => {
      const r = markMissed({ handledStopIds: ['coop'] }, ['coop'])
      const t = totalsFor(r, 600)
      expect(t).toMatchObject({ missed: 0, missedPapers: 0, toDrop: 3, toDropPapers: 12 + 5 + 3 })
    })

    it('does not call a stop dropped on its second pass missed because its first was', () => {
      const missed = markMissed({ handledStopIds: ['coop'] }, ['coop'])
      const t = totalsFor(markDropped(missed, 'coop#2', ['coop']), 3600)
      expect(t).toMatchObject({ dropped: 1, droppedPapers: 12, missed: 0, missedPapers: 0 })
    })

    it('counts a stop missed once when every pass was driven past untapped, with its papers once', () => {
      const r = markMissed({ handledStopIds: ['coop', 'coop#2'] }, ['coop', 'coop#2'])
      expect(totalsFor(r, 3600)).toMatchObject({ missed: 1, missedPapers: 12 })
    })

    it('counts a stop skipped once when every pass was skipped over', () => {
      expect(totalsFor({ handledStopIds: ['coop', 'coop#2'] }, 3600)).toMatchObject({ skipped: 1, dropped: 0, missed: 0, toDrop: 2 })
    })

    it('has every stop in one state, and the papers of the states add up to the papers of the stops', () => {
      const r = markMissed(markDropped({ handledStopIds: ['school'] }, 'coop', ['coop#2']), ['school'])
      const t = totalsFor(r, 1600)
      expect(t.dropped + t.missed + t.skipped + t.toDrop).toBe(t.total)
      expect(t.droppedPapers + t.missedPapers + t.toDropPapers).toBe(12 + 5 + 3)
    })

    it('reads a bundle with no amount as a stop adding no papers, once', () => {
      const two = [bundle('a', 100, {}, 'a'), bundle('a', 900, {}, 'a#2')]
      expect(bundleTotals(bundleList(two, round(), 0))).toMatchObject({ total: 1, toDrop: 1, toDropPapers: 0 })
    })
  })

  describe('the stops, as the totals see them', () => {
    it('are listed in the order the route first reaches them, one for each', () => {
      expect(bundleStops(bundleList(occs, round(), 0)).map((s) => [s.stopId, s.name, s.papers, s.status])).toEqual([
        ['coop', 'Co-op', 12, 'toDrop'],
        ['school', 'School', 5, 'toDrop'],
        ['garage', 'Garage', 3, 'toDrop'],
      ])
    })

    it('are dropped when any pass is, and otherwise still to drop while a pass is to come, then missed, then skipped', () => {
      const of = (r: RoundState, along: number) => bundleStops(bundleList(occs, r, along)).map((s) => s.status)
      expect(of(markDropped(round(), 'garage#3', ['garage', 'garage#2']), 3200)).toEqual(['toDrop', 'toDrop', 'dropped'])
      expect(of({ handledStopIds: ['coop'], missed: ['coop'] }, 600)).toEqual(['toDrop', 'toDrop', 'toDrop'])
      expect(of({ handledStopIds: ['coop', 'coop#2'], missed: ['coop#2'] }, 3600)).toEqual(['missed', 'toDrop', 'toDrop'])
      expect(of({ handledStopIds: ['coop', 'coop#2'] }, 3600)).toEqual(['skipped', 'toDrop', 'toDrop'])
    })

    it('are none for no bundles', () => {
      expect(bundleStops([])).toEqual([])
    })
  })

  describe('the line for the bar and the summary', () => {
    it('says all are dropped once every stop is, though a pass of one was never tapped', () => {
      const r = markDropped(markDropped(markDropped(round(), 'coop', ['coop#2']), 'school'), 'garage', ['garage#2', 'garage#3'])
      expect(bundleLine(bundleList(occs, r, 3600))).toBe('All bundles dropped')
    })

    it('does not say a stop was missed that was dropped on the other pass', () => {
      const r = markDropped(markMissed({ handledStopIds: ['coop', 'school', 'garage', 'garage#2', 'garage#3'] }, ['coop']), 'coop#2', ['coop'])
      expect(bundleLine(bundleList(occs, r, 3600))).toBe('No more bundles ahead')
    })

    it('says a stop is missed once, though both its passes were', () => {
      const keys = ['coop', 'coop#2', 'school', 'garage', 'garage#2', 'garage#3']
      const r = markMissed({ handledStopIds: keys }, ['coop', 'coop#2'])
      expect(bundleLine(bundleList(occs, r, 3600))).toBe('No more bundles ahead · 1 missed')
    })

    it('adds the papers of a stop only once to the summary', () => {
      expect(bundleTotalsText(bundleTotals(bundleList(occs, round(), 0)))).toBe('0 papers dropped · 20 papers to drop')
      const dropped = bundleList(occs, markDropped(round(), 'coop', ['coop#2']), 1000)
      expect(bundleTotalsText(bundleTotals(dropped))).toBe('12 papers dropped · 8 papers to drop')
    })
  })

  describe('taking a drop back', () => {
    const exactly = (a: RoundState, b: RoundState) => expect(sorted(a)).toEqual(sorted(b))
    const droppedWith = (r: RoundState, key: string) => {
      const others = otherPasses(occs, key)
      const before = passStates(r, [key, ...others])
      return { before, after: markDropped(r, key, others) }
    }

    it('puts a settled pass that was still to come back to come, and the pass itself', () => {
      const { before, after } = droppedWith(round(), 'coop')
      exactly(undoDropped(after, 'coop', before), round())
      expect(states(undoDropped(after, 'coop', before), 'coop', 'coop#2')).toEqual(['open', 'open'])
    })

    it('puts a pass that was missed back to missed, when the drop was on the second pass', () => {
      const missed = markMissed({ handledStopIds: ['coop'] }, ['coop'])
      const { before, after } = droppedWith(missed, 'coop#2')
      expect(states(after, 'coop', 'coop#2')).toEqual(['skipped', 'dropped'])
      const back = undoDropped(after, 'coop#2', before)
      exactly(back, missed)
      expect(states(back, 'coop', 'coop#2')).toEqual(['missed', 'open'])
    })

    it('puts the pass back to missed that was marked dropped from the list while it was missed', () => {
      const missed = markMissed({ handledStopIds: ['coop'] }, ['coop'])
      const { before, after } = droppedWith(missed, 'coop')
      exactly(undoDropped(after, 'coop', before), missed)
    })

    it('puts a pass that was skipped over back to skipped, not to come', () => {
      const skipped: RoundState = { handledStopIds: ['coop', 'coop#2'] }
      const { before, after } = droppedWith(skipped, 'coop')
      exactly(undoDropped(after, 'coop', before), skipped)
    })

    it('puts every pass of a stop gone by three times back as it was', () => {
      const r: RoundState = { handledStopIds: ['garage', 'garage#3'], missed: ['garage'] }
      const { before, after } = droppedWith(r, 'garage#2')
      expect(states(after, 'garage', 'garage#2', 'garage#3')).toEqual(['skipped', 'dropped', 'skipped'])
      const back = undoDropped(after, 'garage#2', before)
      exactly(back, r)
      expect(states(back, 'garage', 'garage#2', 'garage#3')).toEqual(['missed', 'open', 'skipped'])
    })

    it('leaves other stops and the progress as they were', () => {
      const r: RoundState = { handledStopIds: ['school', 'coop'], missed: ['school', 'coop'], dropped: [], furthest: 900, startM: 40 }
      const { before, after } = droppedWith(r, 'coop#2')
      const back = undoDropped(after, 'coop#2', before)
      exactly(back, reconcile(r))
      expect(back).toMatchObject({ furthest: 900, startM: 40 })
    })

    it('leaves alone a pass that has changed since the drop, such as by a restart', () => {
      const missed = markMissed({ handledStopIds: ['coop'] }, ['coop'])
      const { before, after } = droppedWith(missed, 'coop#2')
      // The round is started again from a spot between the passes: the first pass is done and the second is not, so the drop is gone,
      // and a late Undo must not make the first pass missed again.
      const restarted: RoundState = { handledStopIds: ['coop'] }
      expect(undoDropped(restarted, 'coop#2', before)).toEqual(restarted)
      // A pass of the stop that has been dropped itself since is not touched either.
      const other: RoundState = { ...after, dropped: ['coop#2', 'coop'] }
      expect(states(undoDropped(other, 'coop#2', before), 'coop')).toEqual(['dropped'])
    })

    it('does not erase a miss recorded since the drop, nor a drop made since', () => {
      const { before, after } = droppedWith(round(), 'coop#2')
      // The first pass was settled by the drop. Since then it has been recorded missed: that stays.
      expect(states(undoDropped(markMissed(after, ['coop']), 'coop#2', before), 'coop', 'coop#2')).toEqual(['missed', 'open'])
      // Or dropped itself: that stays too.
      const both: RoundState = { ...after, dropped: ['coop#2', 'coop'] }
      expect(states(undoDropped(both, 'coop#2', before), 'coop', 'coop#2')).toEqual(['dropped', 'open'])
    })

    it('only takes the bundle itself back without the states from before', () => {
      const missed = markMissed({ handledStopIds: ['coop'] }, ['coop'])
      const after = markDropped(missed, 'coop#2', ['coop'])
      const back = undoDropped(after, 'coop#2')
      expect(states(back, 'coop', 'coop#2')).toEqual(['skipped', 'open'])
    })

    it('does nothing when the states from before say it was dropped already', () => {
      const dropped = markDropped(round(), 'coop', ['coop#2'])
      const again = droppedWith(dropped, 'coop')
      expect(again.before.get('coop')).toBe('dropped')
      expect(undoDropped(again.after, 'coop', again.before)).toEqual(dropped)
    })

    it('does nothing for a bundle that is not dropped, with or without the states from before', () => {
      const r: RoundState = { handledStopIds: ['coop#2'] }
      const before = passStates(round(), ['coop', 'coop#2'])
      expect(undoDropped(r, 'coop', before)).toEqual(r)
      expect(undoDropped(r, 'coop#2', before)).toEqual(r)
    })

    it('does not change the round or the states it is given', () => {
      const missed = markMissed({ handledStopIds: ['coop'] }, ['coop'])
      const { before, after } = droppedWith(missed, 'coop#2')
      const copy = structuredClone(after)
      const beforeCopy = new Map(before)
      undoDropped(after, 'coop#2', before)
      expect(after).toEqual(copy)
      expect(before).toEqual(beforeCopy)
    })
  })

  describe('settling the drops that stay', () => {
    it('does every other pass of a stop with a pass dropped', () => {
      const r = settleDrops({ handledStopIds: ['coop'], dropped: ['coop'] }, occs)
      expect(r).toEqual({ handledStopIds: ['coop', 'coop#2'], dropped: ['coop'] })
    })

    it('un-misses a pass of a stop dropped on another', () => {
      const r = settleDrops({ handledStopIds: ['coop', 'coop#2'], dropped: ['coop'], missed: ['coop#2'] }, occs)
      expect(r.missed).toBeUndefined()
    })

    it('leaves stops with no drop, and a round with none, as they are', () => {
      const r: RoundState = { handledStopIds: ['coop', 'school'], missed: ['coop'], furthest: 5 }
      expect(settleDrops(r, occs)).toEqual(r)
    })

    it('forgets a drop that is not among the stops done, as reconcile does', () => {
      expect(settleDrops({ handledStopIds: [], dropped: ['coop'] }, occs)).toEqual({ handledStopIds: [] })
    })

    it('does nothing more when done again', () => {
      const once = settleDrops({ handledStopIds: ['garage#2'], dropped: ['garage#2'] }, occs)
      expect(once.handledStopIds.sort()).toEqual(['garage', 'garage#2', 'garage#3'])
      expect(settleDrops(once, occs)).toEqual(once)
    })
  })
})
