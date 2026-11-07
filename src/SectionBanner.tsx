import { Icon } from './Icon'
import { sectionSpeech, type SectionNote } from './sectionWatch'
import './sectionBanner.css'

/**
 * The banner that says a named section has ended, one has started, or both, one under the other in the order they come. It is for a look on the move, so it has one word and the name
 * in big type, in colours none of the stops' alerts use: green for a start, and dark for an end. It stays clear of any stop's alert, which matters more, and takes no touch.
 */
export function SectionBanner(note: SectionNote) {
  const { ended, started } = note
  return (
    <div className="section-banner" role="status" aria-label={sectionSpeech(note)}>
      {ended !== null && (
        <div className="section-row ended">
          <span className="section-word">
            <Icon name="check" size={20} strokeWidth={3} />
            End
          </span>
          <span className="section-name">{ended}</span>
        </div>
      )}
      {started !== null && (
        <div className="section-row started">
          <span className="section-word">
            <Icon name="arrow-right" size={20} strokeWidth={3} />
            Start
          </span>
          <span className="section-name">{started}</span>
        </div>
      )}
    </div>
  )
}
