import { Icon } from './Icon'
import { sectionRows, sectionSpeech, type SectionNote } from './sectionWatch'
import './sectionBanner.css'

/**
 * The banner that says a named section has finished, one is beginning, or both, one under the other in the order they come: "Section 1 finished",
 * over "Moving on to Section 2" with its name. It is for a look on the move, so the words are big, in colours none of the stops' alerts use: green for
 * a section beginning, and dark for one finished. It stays clear of any stop's alert, which matters more, and takes no touch.
 */
export function SectionBanner(note: SectionNote) {
  return (
    <div className="section-banner" role="status" aria-label={sectionSpeech(note)}>
      {sectionRows(note).map((row) => (
        <div key={row.kind} className={`section-row ${row.kind}`}>
          <Icon name={row.kind === 'ended' ? 'check' : 'arrow-right'} size={26} strokeWidth={3} />
          <div className="section-text">
            <span className="section-title">{row.title}</span>
            {row.lines.map((line, i) => (
              // By place, as the name and "That was the last section" can be the same words.
              <span key={i} className="section-name">
                {line}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
