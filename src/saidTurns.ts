import type { TurnCue } from './turns'

/**
 * What has been said about each turn, as the round keeps it: the last cue asked for, by the turn's key (see `turnKey`). A cue is marked as it
 * is asked for, not as it is heard, so that the fixes that come while its words wait their turn don't ask for them again. Words that are
 * dropped unsaid as out of date (the card blanked, or went on to another turn, before their turn came) were never heard, though, and while
 * the mark stood, a turn that came back on the card got nothing more: in a court whose way in bends, the U-turn's last word was lost so.
 */

/**
 * Which words each mark was made for, so that words dropped late take back only their own mark. Kept apart from the marks themselves, by the
 * map they are in, so the round's map stays one of cues, as everything else that reads it has it.
 */
const makers = new WeakMap<Map<number, TurnCue>, Map<number, symbol>>()

/**
 * Marks `cue` as said about the turn at `key` in `said`, and gives the check to say its words with: `stale`, which tells whether they are out of
 * date by the time they would start, and, when they are, puts back what had been said of the turn before them, so that the cue for where the
 * turn is then is said if it comes back on the card. Only while the mark is still theirs: one made since, by later words for the same turn,
 * stands, and so does a mark taken out by the round in the meantime (all of them for a fresh start, or those near where the route was left).
 * The speech engine asks the check only before the words start (see `SayOptions.stale`), and a true answer is always words dropped, so words
 * that are heard keep their mark, and no cue is said twice: a cue is only ever asked for once it is later than the one marked (see `turnCue`).
 * Anything else that asks the check once the words have started would take the mark back as well, so nothing else is to. Words the engine
 * lets go without asking, as when newer words take their place while they wait, keep their mark as before.
 */
export function markTurnSaid(said: Map<number, TurnCue>, key: number, cue: TurnCue, stale: () => boolean): () => boolean {
  const before = said.get(key)
  said.set(key, cue)
  const mine = Symbol(cue)
  let owners = makers.get(said)
  if (!owners) makers.set(said, (owners = new Map()))
  owners.set(key, mine)
  return () => {
    const out = stale()
    if (out && owners.get(key) === mine && said.get(key) === cue) {
      owners.delete(key)
      if (before === undefined) said.delete(key)
      else said.set(key, before)
    }
    return out
  }
}
