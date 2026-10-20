import { tidyText } from './namedSections'

/**
 * How a street's name is written on the screen and how it is said aloud. It lives apart from the lookup (streets.ts)
 * so that the turn directions (turns.ts) can use it without the two files importing each other; streets.ts passes
 * these on, so the rest of the app gets them from there.
 */

/**
 * The longest a street name is kept or shown, in units of text (an emoji or a rare character takes two): the cap, counted
 * the same way, that the names saved with a route get (MAX_STREET_NAME in library.ts), so a name is never cut again once kept.
 */
export const MAX_STREET_CHARS = 60

/** A name with its spaces tidied: nothing at either end, one space between words. */
const tidy = (name: string): string => (typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '')

/** Where a bilingual or double name divides: a slash, dash or bar with a space either side. A hyphen inside a word is not one. */
const DIVIDER = /\s[/|-]\s/

/**
 * What a trailing abbreviation stands for. Only the ones in common use on road signs: the phone's own voice may say
 * some of these right already (not checked), so the list is kept short rather than complete. A Map, since the word
 * looked up is a name from the server, and a plain object would answer for names such as "constructor".
 */
const ABBREVIATIONS = new Map([
  ['st', 'Street'],
  ['rd', 'Road'],
  ['ave', 'Avenue'],
  ['dr', 'Drive'],
  ['cres', 'Crescent'],
  ['pl', 'Place'],
  ['ct', 'Court'],
  ['pde', 'Parade'],
  ['hwy', 'Highway'],
  ['tce', 'Terrace'],
  ['cl', 'Close'],
  ['blvd', 'Boulevard'],
])

/**
 * The name for the screen: the whole of it (a bilingual name too, which the line cuts short if it must), spaces tidied
 * and no more than MAX_STREET_CHARS. It is tidied the way names are when they are saved with a route (control characters
 * as spaces, text that shows nothing as no name, and no character cut in half), so a name reads the same after it is kept.
 */
export function cardStreet(name: string): string {
  if (typeof name !== 'string') return ''
  let text = tidyText(name, MAX_STREET_CHARS)
  // Tidying a name that ends in two lone halves of an emoji takes off one, and tidying it when it is kept takes off the other:
  // so go on until it holds still, and what is kept is what was shown.
  for (let again = tidyText(text, MAX_STREET_CHARS); again !== text; again = tidyText(text, MAX_STREET_CHARS)) text = again
  return text
}

/**
 * The name for speech: the part before the first ' / ', ' - ' or ' | ' (the first language of a bilingual name), with a
 * trailing St, Rd, Ave and the like said in full, and a leading St as Saint. A name of one word is left alone.
 */
export function spokenStreet(name: string): string {
  const words = tidy(name).split(DIVIDER)[0].split(' ')
  if (words.length < 2) return words.join(' ')
  const last = words.length - 1
  const full = ABBREVIATIONS.get(words[last].replace(/\.$/, '').toLowerCase())
  if (full) words[last] = full
  if (/^st\.?$/i.test(words[0])) words[0] = 'Saint'
  return words.join(' ')
}

/** What two spellings of a street must agree on to be the same street: capital letters, spaces and the way accents are stored do not matter. */
export const streetKey = (name: string): string => tidy(name).normalize('NFC').toLowerCase()
