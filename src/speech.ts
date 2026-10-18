/**
 * Saying things out loud, for the voice directions. It uses the phone's own speech, so it works with no signal.
 * Nothing here throws: where the phone won't speak, the arrow still shows.
 */

/** Whether this browser can speak at all. */
export function speechAvailable(): boolean {
  return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined'
}

/** English, in the phone's own kind of English where it has one, so distances are said the way they are written here. */
function voiceLanguage(): string {
  const lang = typeof navigator === 'undefined' ? '' : navigator.language
  return /^en\b/i.test(lang) ? lang : 'en-AU'
}

/** Say it now, in place of anything still being said: on the road only the latest word matters. */
export function speak(text: string): void {
  if (!speechAvailable()) return
  try {
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel()
    const words = new SpeechSynthesisUtterance(text)
    words.lang = voiceLanguage()
    speechSynthesis.speak(words)
  } catch {
    // The phone won't speak.
  }
}

/** Stop talking, and drop anything waiting to be said. */
export function stopSpeaking(): void {
  if (!speechAvailable()) return
  try {
    speechSynthesis.cancel()
  } catch {
    // Nothing to stop.
  }
}

/** Call from a tap handler: iOS only lets a page speak after a tap, so a word said silently here lets the later ones through. */
export function unlockSpeech(): void {
  if (!speechAvailable()) return
  try {
    const silent = new SpeechSynthesisUtterance('Ready')
    silent.volume = 0
    speechSynthesis.speak(silent)
  } catch {
    // The phone won't speak.
  }
}
