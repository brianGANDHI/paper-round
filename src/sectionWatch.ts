import { sectionAt, type ResolvedSection } from './namedSections'

/*
 * Telling the driver where a named section starts and ends. A section runs from its start to where the next one starts (see `ResolvedSection`), so most of the time the end of one
 * and the start of the next are the same moment and are told together. Kept apart from the screen so it can be tested.
 */

/** Faster than the car is ever driven, in metres a second: a move along the route quicker than this is the tracker's, not the car's. */
export const SECTION_FASTEST_M_S = 35
/** A move along the route this far is believed whatever the time between two fixes, as the place along the route runs ahead of the car at times. */
export const SECTION_MOVE_SLACK_M = 100
/** How near the end of the route the last section ends, as the tracker may stop short of the very end. As far as `END_QUIET_M`, where the round is taken to be over. */
export const SECTION_END_M = 50
/** How far from the route a fix can be and say where the car is along it for this: on the way to a stop off the road the car can be level with a line it has not come to. */
export const SECTION_ROAD_M = 30

/** What there is to tell: the name of a section ended, the name of one started, or both. */
export interface SectionNote {
  ended: string | null
  started: string | null
}

/** What is kept from one fix to the next. */
export interface SectionWatch {
  /** The section the car was last taken to be in, and where and when. Null until the first look after a start, a skip or *Continue Round*. */
  last: { id: string | null; along: number; time: number } | null
  /** What has been told, so each start and end is told once, whatever the GPS does at the line between two sections. */
  told: ReadonlySet<string>
  /** The first look is not to say the car is starting the section it is in: it is carrying on in it. */
  quiet: boolean
  /** The driver has said the car is where the tracker has it, so the next look is believed however far on that is. */
  trusted: boolean
  /** The round is over and the section the car was in has been ended, and nothing more is told. */
  closed: boolean
  /** Where the round was started or skipped to. The first look waits for the car to get there: short of it, it is still on the way to where the driver said to start. */
  from: number
}

/** Nothing told yet, and the section the car is in is told as it is found. */
export const NOTHING_WATCHED: SectionWatch = { last: null, told: new Set(), quiet: false, trusted: false, closed: false, from: 0 }
/** At *Continue Round*: what was told went with the screen, and the car is carrying on, not starting. */
export const RESUMED_WATCH: SectionWatch = { ...NOTHING_WATCHED, quiet: true }

/** At a start or a skip to `metres` along the route. */
export const startedAt = (metres: number): SectionWatch => ({ ...NOTHING_WATCHED, from: metres })

/** At a carry-on: the same drive going on, from where the driver says. */
export const carriedOn = (watch: SectionWatch): SectionWatch => ({ ...watch, trusted: true })

/** A look at where the car is, on a fix that can say so. */
export interface SectionLook {
  along: number
  /** When the fix was, in milliseconds. */
  time: number
  /** Whether the car is going the way the route runs, or can't say. */
  forward: boolean
  routeEnd: number
  /** The round is over: every stop is done, and what is left of the route is the way home. */
  over: boolean
}

/**
 * Says what section starts or ends where the car is. A section starts and the one before it ends as the car goes over the line between them going the way of the route, by a move it can
 * have made in the time since the last look. A move it can't have made is left to one side and the last place stands, so a throw along the route tells nothing and is forgotten when the
 * tracker comes back, and a real one over a poor spell or round a bend is told as soon as there has been time for it. Going back over a line tells nothing, and the place is taken as it is.
 * The part of the route before the first section has no name, so it neither starts nor ends. The last section ends near the end of the route (`routeEnd`). The section the car was last
 * in ends where the round is over, and then nothing more is told: a round that is over at the first look, past its last stop, tells nothing at all.
 */
export function watchSection(watch: SectionWatch, list: readonly ResolvedSection[], { along, time, forward, routeEnd, over }: SectionLook): { watch: SectionWatch; note: SectionNote | null } {
  const here = sectionAt(list, along)
  if (!here) return { watch, note: null }
  const told = new Set(watch.told)
  const once = (word: string, section: ResolvedSection): string | null => {
    const key = `${word} ${section.id}`
    if (section.lead || told.has(key)) return null
    told.add(key)
    return section.name
  }
  const noted = (ended: string | null, started: string | null) => (ended !== null || started !== null ? { ended, started } : null)
  const last = watch.last
  if (over) {
    if (watch.closed) return { watch, note: null }
    const was = list.find((s) => s.id === last?.id)
    return { watch: { ...watch, told, closed: true }, note: noted(was ? once('end', was) : null, null) }
  }
  if (!last && along < watch.from) return { watch, note: null }
  let ended: string | null = null
  let started: string | null = null
  if (!last) {
    if (!watch.quiet) started = once('start', here)
  } else {
    const fastest = ((time - last.time) / 1000) * SECTION_FASTEST_M_S + SECTION_MOVE_SLACK_M
    if (!watch.trusted && along - last.along > fastest) return { watch, note: null }
    if (here.id !== last.id) {
      const was = list.find((s) => s.id === last.id)
      if (!was || here.startM > was.startM) {
        if (!forward) return { watch, note: null }
        ended = was ? once('end', was) : null
        started = once('start', here)
      }
    }
    if (started === null && forward && here.id === list[list.length - 1].id && along >= routeEnd - SECTION_END_M) ended ??= once('end', here)
  }
  return { watch: { ...watch, last: { id: here.id, along, time }, told, quiet: false, trusted: false, closed: false }, note: noted(ended, started) }
}

/** What the voice says: the end first, as that is how it comes. */
export const sectionSpeech = ({ ended, started }: SectionNote): string => [ended !== null && `End of ${ended}.`, started !== null && `Start of ${started}.`].filter(Boolean).join(' ')
