/// <reference types="node" />
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseDrive } from './driveLog'
import { replayDrive } from './driveSim'

/*
 * Real drives, kept with Record this round and saved from Setup as JSON, played through the tracker as it is now. They are private (where the
 * driver went, and the route), so they are never in the repository: they are read from PAPER_ROUND_DRIVES if that is set (a file, or a folder of
 * them), or else from .claude/worktrees/prototype/drives in this checkout or the one it is a worktree of. With none, the tests are skipped.
 *
 * Each drive's jumps along the route are reported: moves between two fixes further than a car can have gone (see TRACK_SPEED in progress.ts), and
 * how each came about. One the tracker had not seen for long enough, and was not holding as a turn round not sure yet, fails the test. So are the
 * fixes where the tracker now puts the driver more than 50 m from where the tracker of the day did.
 */

function findDrives(): string[] {
  const named = process.env.PAPER_ROUND_DRIVES
  const look = (p: string): string[] => {
    if (!existsSync(p)) return []
    if (statSync(p).isDirectory()) return readdirSync(p).filter((f) => f.endsWith('.json')).map((f) => join(p, f))
    return [p]
  }
  if (named) return look(named)
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    for (const rel of ['.claude/worktrees/prototype/drives', 'prototype/drives']) {
      const found = look(join(dir, rel))
      if (found.length) return found
    }
    dir = resolve(dir, '..')
  }
  return []
}

const files = findDrives()

describe.skipIf(!files.length)('real drives, played back', () => {
  for (const [k, path] of files.entries()) {
    it(`makes no jump along the route it has not seen for long enough: drive ${k + 1}`, { timeout: 600_000 }, () => {
      const drive = parseDrive(readFileSync(path, 'utf8'))
      expect(drive, 'a drive saved from Setup').not.toBeNull()
      const { steps, jumps, differ } = replayDrive(drive!)
      const minutes = steps.length ? (steps[steps.length - 1].time - steps[0].time) / 60_000 : 0
      console.log(`drive ${k + 1}: ${drive!.fixes.length} fixes over ${minutes.toFixed(0)} min; ${jumps.length} jumps; ${differ} fixes more than 50 m from where the tracker of the day put the driver`)
      for (const j of jumps) {
        const t = new Date(j.time).toISOString().slice(11, 19)
        console.log(`  ${t}: ${Math.round(j.from)} m to ${Math.round(j.to)} m along the route (${Math.round(j.to - j.from)} m) in ${j.seconds.toFixed(0)} s, ${Math.round(j.ground)} m on the ground: ${j.kind}`)
      }
      expect(jumps.filter((j) => j.kind === 'other')).toEqual([])
    })
  }
})
