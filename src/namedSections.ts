import { cumulativeDistances, passesNear, pathLength, snapAtDistance, type Occurrence, type PathPass } from './geo'
import type { NamedSection, Pt } from './types'

/** The longest a section's name may be. */
export const MAX_SECTION_NAME = 40
/** The most named sections a route keeps, so damaged data can't fill the phone. */
export const MAX_SECTIONS = 200
/** Sections starting closer than this along the route start at the same spot. */
export const SECTION_GAP_M = 25
/** A section that starts further than this from the route has come loose from it. */
export const ANCHOR_MAX_M = 100
/** How far from where it was asked for a section may be placed. */
export const ANCHOR_TOLERANCE_M = 10
/** The stand-in for the part of the route before the first named section. It is never stored. */
export const LEAD_ID = 'start'
export const LEAD_NAME = 'Start of route'
/** The highest pass number kept: no road is driven more often than this. */
const MAX_PASS = 99

/** A named section as it lies on the route now: from where it starts to where the next one does. */
export interface ResolvedSection {
  id: string
  name: string
  startM: number
  endM: number
  /** True for the stand-in that covers the route before the first named section. */
  lead: boolean
}

/** A named section that can't be placed on the route: it lies off it, or starts where another one already does. */
export interface DetachedSection {
  section: NamedSection
  reason: 'off' | 'overlap'
}

let counter = 0
// Never 'start', which is the stand-in's.
const newSectionId = () => `sec${(++counter).toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** An id that is not in `taken`. */
function freshId(taken: ReadonlySet<string>): string {
  let id = newSectionId()
  while (taken.has(id)) id = newSectionId()
  return id
}

/** Nothing but spaces and the marks that show nothing by themselves, such as a zero-width space. */
const SHOWS_NOTHING = /^[\s\p{Default_Ignorable_Code_Point}]*$/u

/**
 * Some text with its spaces tidied, cut to `max` units at most without leaving half of a character that takes two, such
 * as an emoji. Control characters count as spaces, and text that shows nothing, such as zero-width spaces, is nothing.
 * Marks that show nothing on their own are kept in text that does show something, where an emoji or a script needs them.
 */
export function tidyText(text: string, max: number): string {
  const name = text.replace(/[\s\p{Cc}]+/gu, ' ').trim().slice(0, max)
  const whole = (/[\uD800-\uDBFF]$/.test(name) ? name.slice(0, -1) : name).trim()
  return SHOWS_NOTHING.test(whole) ? '' : whole
}

/** A section's name as it was typed: spaces tidied and kept short enough to show. Nothing when it is blank. */
export const cleanSectionName = (text: string): string | undefined => tidyText(text, MAX_SECTION_NAME) || undefined

/** Which pass of a spot a section is on, counted from the first, and kept to the passes there are. */
function passIndex(section: Pick<NamedSection, 'pass'>, passes: number): number {
  const wanted = typeof section.pass === 'number' && Number.isFinite(section.pass) ? Math.trunc(section.pass) : 1
  return Math.min(Math.max(wanted, 1), passes) - 1
}

/** Finds the passes of a spot on the route, remembering each spot it has been asked about: finding them walks the whole route. */
function passesLookup(points: Pt[]): (spot: Pt) => PathPass[] {
  const known = new Map<string, PathPass[]>()
  return (spot) => {
    const key = `${spot.lat},${spot.lng}`
    let passes = known.get(key)
    if (!passes) known.set(key, (passes = passesNear(points, spot)))
    return passes
  }
}

/**
 * Where each named section lies on the route now, in route order, each running to the start of the next (the last
 * to the end of the route). A section is found by the spot it is anchored at and which pass of that spot it is, so
 * it follows the route when that is edited. Those that can't be placed are returned apart: ones further than
 * ANCHOR_MAX_M from the route, and ones starting within SECTION_GAP_M of an earlier one. When the first starts more
 * than SECTION_GAP_M in, a stand-in called "Start of route" covers what comes before; otherwise the first starts at
 * 0. With no sections there is nothing to say, so no stand-in either.
 */
export function resolveSections(points: Pt[], sections: readonly NamedSection[]): { list: ResolvedSection[]; detached: DetachedSection[] } {
  return resolveWith(points, sections, passesLookup(points))
}

/** `resolveSections` with the way to find the passes of a spot given, so that callers making several checks can share one. */
function resolveWith(points: Pt[], sections: readonly NamedSection[], passesFor: (spot: Pt) => PathPass[]): { list: ResolvedSection[]; detached: DetachedSection[] } {
  const loose: { section: NamedSection; reason: DetachedSection['reason']; order: number }[] = []
  const found: { section: NamedSection; order: number; startM: number }[] = []
  sections.forEach((section, order) => {
    const passes = passesFor(section)
    if (!passes.length || passes[0].off > ANCHOR_MAX_M) loose.push({ section, reason: 'off', order })
    else found.push({ section, order, startM: passes[passIndex(section, passes.length)].at })
  })

  // Sorting is stable, so two at the same place stay in the order they were stored.
  found.sort((a, b) => a.startM - b.startM)
  const kept: typeof found = []
  for (const f of found) {
    const last = kept[kept.length - 1]
    if (last && f.startM - last.startM < SECTION_GAP_M) loose.push({ section: f.section, reason: 'overlap', order: f.order })
    else kept.push(f)
  }

  const length = cumulativeDistances(points).at(-1) ?? 0
  const list: ResolvedSection[] = kept.map((k, i) => ({
    id: k.section.id,
    name: k.section.name,
    startM: i === 0 && k.startM <= SECTION_GAP_M ? 0 : k.startM,
    endM: kept[i + 1]?.startM ?? length,
    lead: false,
  }))
  if (list.length && list[0].startM > 0) list.unshift({ id: LEAD_ID, name: LEAD_NAME, startM: 0, endM: list[0].startM, lead: true })

  return { list, detached: loose.sort((a, b) => a.order - b.order).map(({ section, reason }) => ({ section, reason })) }
}

/**
 * A section starting `m` metres along the route, held by the spot it is at and which pass of it that is (the one that
 * comes nearest to `m`). Null when the name is blank, `m` is not a number, the route has no length, or the section
 * would not start where `m` is: where a road is driven out and back, the two passes of a spot within about 30 m of
 * the far end run together, and a spot on the way back there would be found on the way out. It is kept within the
 * route: a distance past either end is the end. It does not check for other sections or the end: see `addSection`.
 */
export function anchorAt(points: Pt[], m: number, name: string, id?: string): NamedSection | null {
  return anchorWith(points, m, name, id, passesLookup(points))
}

/** `anchorAt` with the way to find the passes of a spot given. */
function anchorWith(points: Pt[], m: number, name: string, id: string | undefined, passesFor: (spot: Pt) => PathPass[]): NamedSection | null {
  const clean = cleanSectionName(name)
  const length = pathLength(points)
  if (!clean || !Number.isFinite(m) || length <= 0) return null
  const snap = snapAtDistance(points, m)
  if (!snap) return null
  // A distance past either end is the end, and then the pass nearest to it is the same one.
  const passes = passesFor(snap.point)
  let nearest = 0
  passes.forEach((p, i) => {
    if (Math.abs(p.at - m) < Math.abs(passes[nearest].at - m)) nearest = i
  })
  // Where the section would be found again. Within reach of a turn right back it is the other side of it, so it is refused.
  const placed = passes[nearest]?.at
  if (placed === undefined || Math.abs(placed - Math.min(Math.max(m, 0), length)) > ANCHOR_TOLERANCE_M) return null
  const section: NamedSection = { id: id || freshId(new Set()), name: clean, lat: snap.point.lat, lng: snap.point.lng }
  if (nearest > 0) section.pass = nearest + 1
  return section
}

/**
 * The sections with a new one starting `m` metres along the route. Null when nothing can be added there: the name is
 * blank, the route has no length, there are MAX_SECTIONS already, the spot is within SECTION_GAP_M of the end of the
 * route (there would be next to nothing in the section), it is one `anchorAt` refuses, or it is within SECTION_GAP_M
 * of another section's start (so adding it would push that one out, or itself be pushed out).
 */
export function addSection(points: Pt[], sections: readonly NamedSection[], m: number, name: string): { sections: NamedSection[]; added: NamedSection } | null {
  if (sections.length >= MAX_SECTIONS || m > pathLength(points) - SECTION_GAP_M) return null
  // The same spots are asked about again and again below, so each is only walked the once.
  const passesFor = passesLookup(points)
  const added = anchorWith(points, m, name, freshId(new Set(sections.map((s) => s.id))), passesFor)
  if (!added) return null
  const next = [...sections, added]
  const kept = new Set(resolveWith(points, next, passesFor).list.map((s) => s.id))
  if (!kept.has(added.id) || resolveWith(points, sections, passesFor).list.some((s) => !s.lead && !kept.has(s.id))) return null
  return { sections: next, added }
}

/** The sections with one renamed. The same sections when there is no such one or the name is blank. */
export function renameSection(sections: readonly NamedSection[], id: string, name: string): NamedSection[] {
  const clean = cleanSectionName(name)
  return sections.map((s) => (clean && s.id === id ? { ...s, name: clean } : s))
}

/** The sections without one. The same sections when there is no such one. */
export function removeSection(sections: readonly NamedSection[], id: string): NamedSection[] {
  return sections.filter((s) => s.id !== id)
}

/** The position of the section that `along` metres is in, or -1 for a distance that is not a number. A boundary belongs to the section that starts there. */
function indexAt(list: readonly ResolvedSection[], along: number): number {
  if (Number.isNaN(along)) return -1
  let found = 0
  for (let i = 1; i < list.length && list[i].startM <= along; i++) found = i
  return found
}

/**
 * The section that `along` metres along the route is in: where a section starts belongs to that section, not the one
 * before, and anything at or past the end is the last. Null for no sections, and for a distance that is not a number.
 */
export function sectionAt(list: readonly ResolvedSection[], along: number): ResolvedSection | null {
  return list[indexAt(list, along)] ?? null
}

/** For each section, how many stops lie along it and how many of those are not done yet. A stop belongs to the section it is met in. */
export function sectionStatus(
  list: readonly ResolvedSection[],
  occs: readonly Occurrence[],
  handled: ReadonlySet<string>,
): { id: string; total: number; left: number }[] {
  const status = list.map((s) => ({ id: s.id, total: 0, left: 0 }))
  for (const o of occs) {
    const found = status[indexAt(list, o.at)]
    if (!found) continue
    found.total++
    if (!handled.has(o.key)) found.left++
  }
  return status
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/**
 * Make anything read from storage or a backup safe to use: junk is dropped (not an object, a place that is not on
 * Earth, a blank name, a pass that is not a number), names are tidied, ids are made unique, pass numbers are kept
 * to whole numbers from 1 to 99, and no more than MAX_SECTIONS are kept. Anything that isn't a list gives none.
 */
export function normalizeSections(raw: unknown): NamedSection[] {
  if (!Array.isArray(raw)) return []
  const taken = new Set<string>([LEAD_ID])
  const clean: NamedSection[] = []
  for (const item of raw) {
    if (clean.length >= MAX_SECTIONS) break
    if (!isRecord(item)) continue
    const { id, name, lat, lng, pass } = item
    if (typeof name !== 'string' || typeof lat !== 'number' || typeof lng !== 'number') continue
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue
    const tidy = cleanSectionName(name)
    if (!tidy) continue
    let which = 1
    if (pass !== undefined) {
      if (typeof pass !== 'number' || !Number.isFinite(pass)) continue
      // 1 or less is the first pass, which is left out.
      which = Math.min(Math.trunc(pass), MAX_PASS)
    }
    const unique = typeof id === 'string' && id && !taken.has(id) ? id : freshId(taken)
    taken.add(unique)
    clean.push({ id: unique, name: tidy, lat, lng, ...(which > 1 ? { pass: which } : {}) })
  }
  return clean
}

/** Where on the map a section starts, for a marker. The first point of the route when it has no length. */
export function sectionPoint(points: Pt[], section: Pick<ResolvedSection, 'startM'>): Pt {
  return snapAtDistance(points, section.startM)?.point ?? points[0] ?? { lat: 0, lng: 0 }
}
