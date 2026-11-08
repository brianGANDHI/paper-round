/** How long a step between two reads of the clock can be and still be time spent on the work, in ms. */
const LONGEST_STEP_MS = 5000

/**
 * A clock that leaves out any step over about 5 s between two reads. Whatever reads it reads it many times a second, so a step that long
 * is the page stopped by the phone locking or the app going behind another, with no work done. Counted as time, it would use up a search
 * or make a match look too slow to leave room for a search. A real run has to read it often enough, or its own time goes missing as well.
 */
export function wakingClock(read: () => number, longest: number = LONGEST_STEP_MS): () => number {
  let last = read()
  let asleep = 0
  return () => {
    const now = read()
    if (now - last > longest) asleep += now - last
    last = now
    return now - asleep
  }
}
