/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { reusedPlaces, score, simDrive, simTrack, type SimOptions, type SimScore } from './driveSim'
import type { Pt } from './types'

/*
 * The real round, driven through the simulation, where it folds back on itself or uses a street twice. The route is private: it is read from a file
 * kept outside the repository, on this computer only, and nothing of it (no place, no name) is written here. With no such file the tests are skipped.
 *
 * The file is looked for at PAPER_ROUND_ROUTE if that is set (a route.json, or a backup exported from Routes, with every route in it), or else at
 * .claude/worktrees/prototype/route.json in this checkout or the one it is a worktree of. PAPER_ROUND_HOTSPOTS can add places to drive through,
 * as "lat,lng;lat,lng". Every third place the route uses twice is driven, with one seed; PAPER_ROUND_FULL=1 drives every one, with two (a minute
 * or so for a route of 2,000 points).
 *
 * Driven with GPS error of 10 to 15 m (the phone claiming 15), crawling and stop-start: on the round of October, before the window of where the
 * driver can have got to (see TRACK_SPEED in progress.ts), in 1,420 drives the tracker put the driver on another pass 60 times, 4 of them more than
 * 300 m away (the worst 76 km), and the furthest reached went up to 253 m past both the car and where the fixes pointed. After: 50, none past
 * 300 m (the worst 270 m, for 38 s), and the furthest reached 123 m. Most of what is left is 50 to 100 m for a few seconds at corners.
 */

function findRouteFile(): string | null {
  if (process.env.PAPER_ROUND_ROUTE) return existsSync(process.env.PAPER_ROUND_ROUTE) ? process.env.PAPER_ROUND_ROUTE : null
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    for (const rel of ['.claude/worktrees/prototype/route.json', 'prototype/route.json']) {
      const p = join(dir, rel)
      if (existsSync(p)) return p
    }
    dir = resolve(dir, '..')
  }
  return null
}

/** The routes in the file: a single route.json, or a backup with them all. */
function readRoutes(path: string): { name: string; points: Pt[] }[] {
  const text = readFileSync(path, 'utf8')
  const data = JSON.parse(text.slice(text.indexOf('{')))
  const list: { name: string; route: { points: Pt[] } }[] = Array.isArray(data.routes) ? data.routes : [data]
  return list.filter((r) => r.route?.points?.length > 1).map((r) => ({ name: r.name, points: r.route.points }))
}

const file = findRouteFile()
const routes = file ? readRoutes(file) : []

const POOR: Omit<SimOptions, 'seed'>[] = [
  { speed: 3, sigma: 10, accuracy: 15, headingNoise: 12, stopEvery: 30, stopFor: 6, round: 10 },
  { speed: 3, sigma: 15, accuracy: 15, headingNoise: 20, stopEvery: 30, stopFor: 6 },
  { speed: 7, sigma: 15, accuracy: 15, headingNoise: 12, round: 10 },
  { speed: 7, sigma: 10, accuracy: 15, headingNoise: 20, stopEvery: 30, stopFor: 6 },
  { speed: 13, sigma: 15, accuracy: 15, headingNoise: 6, stopEvery: 30, stopFor: 6, round: 10 },
]

describe.skipIf(!routes.length)('the real round, where it folds back on itself or uses a street twice', () => {
  for (const route of routes) {
    it(`never puts the driver on another pass: ${routes.indexOf(route) + 1}`, { timeout: 1_800_000 }, () => {
      const track = simTrack(route.points)
      const full = process.env.PAPER_ROUND_FULL === '1'
      const places = reusedPlaces(track).filter((_, k) => full || k % 3 === 0)
      const hot = (process.env.PAPER_ROUND_HOTSPOTS ?? '')
        .split(';')
        .filter(Boolean)
        .map((s) => {
          const [lat, lng] = s.split(',').map(Number)
          let best = 0
          let bestD = Infinity
          for (let i = 0; i < track.points.length; i++) {
            const d = Math.hypot((track.points[i].lat - lat) * 111_000, (track.points[i].lng - lng) * 98_000)
            if (d < bestD) {
              bestD = d
              best = track.cum[i]
            }
          }
          return best
        })
      const results: { at: number; o: SimOptions; score: SimScore }[] = []
      for (const at of [...hot, ...places]) {
        for (const [k, base] of POOR.entries()) {
          for (const seed of full ? [1, 2] : [1]) {
            const o: SimOptions = { ...base, seed: seed * 1009 + k * 31 + Math.round(at), from: Math.max(0, at - 350), to: at + 250 }
            results.push({ at, o, score: score(simDrive(track, o)) })
          }
        }
      }
      const spells = results.flatMap((r) => r.score.spells.map((s) => ({ ...s, at: r.at, o: r.o })))
      const ahead = Math.max(...results.map((r) => r.score.furthestUnexplained))
      console.log(
        `route ${routes.indexOf(route) + 1}: ${places.length} places used twice, ${hot.length} hotspots, ${results.length} drives, ${results.reduce((a, r) => a + r.score.fixes, 0)} fixes, ` +
          `${results.reduce((a, r) => a + r.score.wrong, 0)} over 50 m (${results.reduce((a, r) => a + r.score.explained, 0)} where the fix itself points), jumps ${spells.length}, ` +
          `furthest past the fixes ${ahead.toFixed(0)} m`,
      )
      for (const s of spells.slice(0, 40)) console.log(`  at ${Math.round(s.at)} m: ${Math.round(s.worst)} m for ${s.seconds} s (${s.o.speed} m/s, error ${s.o.sigma} m${s.o.stopEvery ? ', stop-start' : ''})`)
      // Never on another pass further than 300 m away, nor for more than a minute; and the furthest reached never 150 m past both the car and the fixes.
      for (const s of spells) {
        expect(Math.abs(s.worst), `at ${Math.round(s.at)} m`).toBeLessThan(300)
        expect(s.seconds, `at ${Math.round(s.at)} m`).toBeLessThan(60)
      }
      expect(ahead).toBeLessThan(150)
    })
  }
})
