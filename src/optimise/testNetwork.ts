import type { Pt, Route, SavedRoute, Side, SideChange, Stop, StopType } from '../types'
import type { OsmData, OsmElement, OsmRelation } from './types'

/**
 * Made-up streets for the tests, nowhere in particular. A place is a cell on a grid about 110 m square: column east, row south. The
 * standard network is three streets across and four down, with a main road along the bottom, a court, a one-way loop and a private lane:
 *
 *               (1,-1)         (2,-1)→→→(3,-1)
 *                 |  Ivy Ct      ↑        ↓   Juniper Way
 *   (0,0)------(1,0)-----------(2,0)----(3,0)   Ash Street
 *     |          |  ╲ Quince Ln  |        |
 *   (0,1)------(1,1)-----------(2,1)----(3,1)   Birch Street
 *     |          |               |        |
 *   (0,2)======(1,2)===========(2,2)====(3,2)   Main Road
 *
 *   Elm Lane, Fig Lane, Gum Lane and Hazel Lane run down columns 0 to 3.
 */

export type Cell = [number, number]

const STEP_LAT = 0.001
const STEP_LNG = 0.00115

export const place = ([c, r]: Cell): Pt => ({ lat: -30 - r * STEP_LAT, lng: 150 + c * STEP_LNG })

const nodeId = ([c, r]: Cell) => (Math.round(c * 100) + 1000) * 100000 + Math.round(r * 100) + 1000

export interface WaySpec {
  id: number
  cells: Cell[]
  tags: Record<string, string>
}

export const residential = (name: string) => ({ highway: 'residential', name })
export const mainRoad = (name: string) => ({ highway: 'secondary', name })

/** A rule at a node, as Overpass gives it: `restriction` such as no_left_turn. */
export const turnRule = (id: number, restriction: string, from: number, via: Cell, to: number): OsmRelation => ({
  type: 'relation',
  id,
  tags: { type: 'restriction', restriction },
  members: [
    { type: 'way', ref: from, role: 'from' },
    { type: 'node', ref: nodeId(via), role: 'via' },
    { type: 'way', ref: to, role: 'to' },
  ],
})

/** The ways as Overpass would answer, with a barrier on any of `barriers`. */
export function osmOf(ways: WaySpec[], barriers: Cell[] = [], rules: OsmRelation[] = []): OsmData {
  const nodes = new Map<number, OsmElement>()
  for (const w of ways) {
    for (const cell of w.cells) {
      const { lat, lng } = place(cell)
      const id = nodeId(cell)
      const gate = barriers.some(([c, r]) => c === cell[0] && r === cell[1])
      nodes.set(id, { type: 'node', id, lat, lon: lng, ...(gate ? { tags: { barrier: 'gate' } } : {}) })
    }
  }
  return { elements: [...nodes.values(), ...ways.map((w): OsmElement => ({ type: 'way', id: w.id, nodes: w.cells.map(nodeId), tags: w.tags })), ...rules] }
}

export const WAY = { ash: 1, birch: 2, main: 3, elm: 4, fig: 5, gum: 6, hazel: 7, ivy: 8, juniper: 9, quince: 10 }

/** The standard streets. */
export const gridWays = (): WaySpec[] => [
  { id: WAY.ash, cells: [[0, 0], [1, 0], [2, 0], [3, 0]], tags: residential('Ash Street') },
  { id: WAY.birch, cells: [[0, 1], [1, 1], [2, 1], [3, 1]], tags: residential('Birch Street') },
  { id: WAY.main, cells: [[0, 2], [1, 2], [2, 2], [3, 2]], tags: mainRoad('Main Road') },
  { id: WAY.elm, cells: [[0, 0], [0, 1], [0, 2]], tags: residential('Elm Lane') },
  { id: WAY.fig, cells: [[1, 0], [1, 1], [1, 2]], tags: residential('Fig Lane') },
  { id: WAY.gum, cells: [[2, 0], [2, 1], [2, 2]], tags: residential('Gum Lane') },
  { id: WAY.hazel, cells: [[3, 0], [3, 1], [3, 2]], tags: residential('Hazel Lane') },
  { id: WAY.ivy, cells: [[1, 0], [1, -1]], tags: residential('Ivy Court') },
  { id: WAY.juniper, cells: [[2, 0], [2, -1], [3, -1], [3, 0]], tags: { ...residential('Juniper Way'), oneway: 'yes' } },
  { id: WAY.quince, cells: [[1, 0], [2, 1]], tags: { highway: 'service', access: 'private', name: 'Quince Lane' } },
]

/** A stretch of the drive: a side, and the places it goes through. Each carries on from where the last one ended. */
export type Stretch = [Side, ...Cell[]]

/** A route through the stretches, with a side change where each begins. */
export function drive(stretches: Stretch[]): Pick<Route, 'points' | 'sideChanges'> {
  const points: Pt[] = []
  const sideChanges: SideChange[] = []
  for (const [side, ...cells] of stretches) {
    let from = points.length - 1
    for (const cell of cells) {
      const p = place(cell)
      const last = points[points.length - 1]
      if (!last || last.lat !== p.lat || last.lng !== p.lng) points.push(p)
    }
    from = Math.max(from, 0)
    if (!sideChanges.length || sideChanges[sideChanges.length - 1].side !== side) sideChanges.push({ idx: from, side })
  }
  return { points, sideChanges }
}

/** A stop a few metres off the road at a place. */
export const stopAt = (id: string, type: StopType, cell: Cell, extra: Partial<Stop> = {}): Stop => {
  const { lat, lng } = place(cell)
  return { id, type, lat: lat + 0.00004, lng, pathIdx: 0, label: id, ...extra }
}

export function savedRoute(route: Pick<Route, 'points' | 'sideChanges'>, stops: Stop[] = [], extra: Partial<SavedRoute> = {}): SavedRoute {
  return { id: 'r1', name: 'Test round', route: { ...route, stops }, round: { handledStopIds: [] }, updatedAt: 1, ...extra }
}

/**
 * A roundabout drawn as four ways with no name, one for each quarter, as the map often has one: 32 points round on a ring about 44 m across, a
 * road into the end of each quarter, and roads outside it to come back by. Today's drive comes in from West Road, goes round to East Road and
 * back by the roads outside, and throws to port only for `reach` points of the ring either side of the north junction, where North Road comes in.
 * That is a short run at the end of one quarter and another at the start of the next: each alone looks like the match nibbling at a junction.
 * `at` is a point of the ring, counted clockwise from the north junction (8 is the east one, 24 the west), and `around` the drive round the ring
 * from one point to another, as cells.
 */
export function quarteredRoundabout(reach = 2) {
  const POINTS = 32
  const quarter = POINTS / 4
  const centre: Cell = [2, 1]
  const at = (k: number): Cell => {
    const a = (2 * Math.PI * k) / POINTS
    return [centre[0] + 0.2 * Math.sin(a), centre[1] - 0.2 * Math.cos(a)]
  }
  const around = (from: number, to: number): Cell[] => Array.from({ length: to - from + 1 }, (_, i) => at((((from + i) % POINTS) + POINTS) % POINTS))
  const ring = { highway: 'residential', junction: 'roundabout' }
  const ways: WaySpec[] = [
    ...[0, 1, 2, 3].map((q): WaySpec => ({ id: q + 1, cells: around(q * quarter, (q + 1) * quarter), tags: ring })),
    { id: 5, cells: [[0, 1], at(3 * quarter)], tags: residential('West Road') },
    { id: 6, cells: [at(0), [2, 0]], tags: residential('North Road') },
    { id: 7, cells: [at(quarter), [4, 1]], tags: residential('East Road') },
    { id: 8, cells: [at(2 * quarter), [2, 2]], tags: residential('South Road') },
    { id: 9, cells: [[4, 1], [4, 2]], tags: residential('Loop Road') },
    { id: 10, cells: [[4, 2], [2, 2], [0, 2]], tags: residential('Back Road') },
    { id: 11, cells: [[0, 2], [0, 1]], tags: residential('Elm Lane') },
  ]
  const today = drive([
    ['left', [0, 1], at(3 * quarter)],
    ['transit', ...around(3 * quarter, POINTS - reach).slice(1)],
    ['left', ...around(POINTS - reach, POINTS + reach).slice(1)],
    ['transit', ...around(POINTS + reach, POINTS + quarter).slice(1), [4, 1], [4, 2], [2, 2], [0, 2], [0, 1]],
  ])
  return { ways, today, around, at }
}
