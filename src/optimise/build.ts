import type { Pt, Side, SideChange } from '../types'
import type { Edge } from './demand'
import { toPt, type Origin, type XY } from './graph'
import type { Leg, Problem } from './problem'

/** From a solved drive to a route: each side thrown goes on a pass, to port wherever there is a pass that has it there, and the points come from the map. */

/** Runs of a side shorter than this are absorbed where that only adds to what is thrown, in metres. */
const SHORT_RUN_M = 30
/** A run of transit with nothing to throw at this short isn't worth a change of side, in metres. */
const EMPTY_RUN_M = 60
/** Saved routes keep this many decimal places, and everything is checked on the rounded points. */
const DECIMALS = 1e6

/** Each pass's side. A side the edge needs goes on the first pass with it to port, or if none has, the first pass of all. */
export function assignSides(pr: Problem, run: Leg[], edges: Edge[]): Side[] {
  const passes = new Map<number, number[]>()
  run.forEach((leg, i) => {
    const e = pr.arcs[leg.arc].edge
    const list = passes.get(e)
    if (list) list.push(i)
    else passes.set(e, [i])
  })
  const port = new Uint8Array(run.length)
  const starboard = new Uint8Array(run.length)
  for (const e of edges) {
    const list = passes.get(e.id) ?? []
    const place = (dirWithItToPort: 1 | -1) => {
      const pass = list.find((i) => pr.arcs[run[i].arc].dir === dirWithItToPort)
      if (pass !== undefined) port[pass] = 1
      else if (list.length) starboard[list[0]] = 1
    }
    if (e.reqL) place(1)
    if (e.reqR) place(-1)
  }
  return run.map((_, i) => (port[i] && starboard[i] ? 'both' : port[i] ? 'left' : starboard[i] ? 'right' : 'transit'))
}

interface SideRun {
  a: number
  b: number
  side: Side
  len: number
}

function sideRuns(pr: Problem, run: Leg[], sides: Side[]): SideRun[] {
  const runs: SideRun[] = []
  sides.forEach((s, i) => {
    const last = runs[runs.length - 1]
    const len = pr.arcs[run[i].arc].len
    if (last && last.side === s) {
      last.b = i
      last.len += len
    } else runs.push({ a: i, b: i, side: s, len })
  })
  return runs
}

/** Whether side `a` throws at everything side `b` does. */
const covers = (a: Side, b: Side) => a === b || a === 'both' || b === 'transit'

/**
 * Sides as driven, with short stretches absorbed so the voice isn't saying a new side every few seconds. It's the neighbours that get
 * longer, and only over what they cover, so a stretch is only ever given more to throw at, never less. A stretch doesn't take on
 * starboard over a road where `allowed` says the driver turned it off, unless that stretch had starboard already.
 */
export function smoothSides(pr: Problem, run: Leg[], edges: Edge[], sides: Side[], allowed: (e: Edge) => boolean = () => true): Side[] {
  const out = [...sides]
  const hasStarboard = (s: Side) => s === 'right' || s === 'both'
  const turnedOff = (r: SideRun) => {
    for (let i = r.a; i <= r.b; i++) if (!allowed(edges[pr.arcs[run[i].arc].edge])) return true
    return false
  }
  const nothingNeeded = (a: number, b: number) => {
    for (let i = a; i <= b; i++) {
      const e = edges[pr.arcs[run[i].arc].edge]
      if (e.reqL || e.reqR) return false
    }
    return true
  }
  // Each merge changes the runs around it, so it starts again. A run only ever merges away, so this ends.
  for (let again = true; again; ) {
    again = false
    const runs = sideRuns(pr, run, out)
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i]
      if (r.len >= (r.side === 'transit' && nothingNeeded(r.a, r.b) ? EMPTY_RUN_M : SHORT_RUN_M)) continue
      const p = runs[i - 1]
      const q = runs[i + 1]
      let to: Side | null = null
      if (p && q && p.side === q.side && covers(p.side, r.side)) to = p.side
      else if (r.side === 'transit' && p) to = p.side
      else if (r.side === 'transit' && q) to = q.side
      else if (p && covers(p.side, r.side)) to = p.side
      else if (q && covers(q.side, r.side)) to = q.side
      if (to && to !== r.side && !(hasStarboard(to) && !hasStarboard(r.side) && turnedOff(r))) {
        for (let k = r.a; k <= r.b; k++) out[k] = to
        again = true
        break
      }
    }
  }
  return out
}

const rounded = (p: Pt): Pt => ({ lat: Math.round(p.lat * DECIMALS) / DECIMALS, lng: Math.round(p.lng * DECIMALS) / DECIMALS })

/** Rows as `sideAt` reads them: sorted, one to an index, a row at 0, none repeating the side before it, and none past the last segment. */
export function tidySides(rows: SideChange[], segments: number): SideChange[] {
  const out: SideChange[] = []
  for (const row of rows) {
    if (row.idx >= segments) continue
    if (out.length && out[out.length - 1].idx === row.idx) out.pop()
    if (!out.length || out[out.length - 1].side !== row.side) out.push(row)
  }
  return out
}

export interface BuiltRoute {
  points: Pt[]
  sideChanges: SideChange[]
}

/**
 * The drive as a route: points along the map from the start node back to it, each rounded as it is added, as saved routes are. Rounding
 * first means two points can fall together only here, not after the side changes have been counted against them.
 */
export function buildRoute(origin: Origin, pr: Problem, run: Leg[], edges: Edge[], sides: Side[]): BuiltRoute {
  const points: Pt[] = []
  const rows: SideChange[] = []
  const push = (xy: XY) => {
    const p = rounded(toPt(origin, xy))
    const last = points[points.length - 1]
    if (!last || last.lat !== p.lat || last.lng !== p.lng) points.push(p)
  }
  run.forEach((leg, i) => {
    const a = pr.arcs[leg.arc]
    const e = edges[a.edge]
    const pts = a.dir === 1 ? e.pts : [...e.pts].reverse()
    if (!points.length) push(pts[0])
    // The side applies from the point this stretch begins at.
    rows.push({ idx: points.length - 1, side: sides[i] })
    for (const p of pts.slice(1)) push(p)
  })
  return { points, sideChanges: tidySides(rows, points.length - 1) }
}
