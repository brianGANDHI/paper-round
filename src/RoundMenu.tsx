import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import './roundMenu.css'

interface Props {
  /** How close to a stop its alert comes up, in metres, shown on its row. */
  alertDistance: number
  onClose: () => void
  /** Each of these is called after the menu has closed. */
  onWholeRoute: () => void
  onSkip: () => void
  onAlertDistance: () => void
  onReset: () => void
  /** Opens the list of bundle drops. Without it there is no Bundles row. */
  onBundles?: () => void
}

interface RowProps {
  icon: IconName
  title: string
  detail?: string
  /** What is set now, at the end of the row. */
  value?: ReactNode
  danger?: boolean
  onClick: () => void
}

/** One row of the menu: big enough for a thumb. */
function MenuRow({ icon, title, detail, value, danger, onClick }: RowProps) {
  return (
    <button className="row" onClick={onClick}>
      <span className={danger ? 'icon-danger' : 'icon-tint'}>
        <Icon name={icon} size={24} />
      </span>
      <div className="grow">
        <div className={danger ? 'title danger' : 'title'}>{title}</div>
        {detail && <div className="sub">{detail}</div>}
      </div>
      {value !== undefined && <span className="round-menu-value">{value}</span>}
    </button>
  )
}

/**
 * What the round keeps out of the way while driving, in a sheet that comes up from the bottom: the whole route, skipping to a spot
 * or section, the alert distance, the bundle drops, starting the round again, and the map's credit. Choosing a row closes the sheet
 * first, so what it asks next (a question, the map to pick a spot on) isn't under it. An alert still shows above the sheet.
 */
export function RoundMenu({ alertDistance, onClose, onWholeRoute, onSkip, onAlertDistance, onReset, onBundles }: Props) {
  /** Closes the menu, then does `action`. */
  const pick = (action: () => void) => () => {
    onClose()
    action()
  }
  return (
    <div className="round-menu-scrim" onClick={onClose}>
      <div className="round-menu" role="dialog" aria-modal="true" aria-label="Round menu" onClick={(e) => e.stopPropagation()}>
        <div className="round-menu-head">
          <h2>Menu</h2>
          <button className="btn plain" onClick={onClose}>
            Done
          </button>
        </div>
        <div className="group">
          <MenuRow icon="map" title="Whole route" detail="See all of it, then come back with Re-centre" onClick={pick(onWholeRoute)} />
          <MenuRow icon="flag" title="Skip to a Spot or Section" detail="Carry on from somewhere else on the route" onClick={pick(onSkip)} />
          <MenuRow icon="sliders" title="Alert Distance" detail="How close to a stop its alert comes up" value={`${alertDistance} m`} onClick={pick(onAlertDistance)} />
          {onBundles && <MenuRow icon="package" title="Bundles" detail="Every bundle drop, and which are done" onClick={pick(onBundles)} />}
        </div>
        <div className="group">
          <MenuRow icon="undo" title="Reset Round" detail="Every special stop counts as not done again" danger onClick={pick(onReset)} />
        </div>
        <div className="group">
          <a className="row" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
            <span className="icon-tint">
              <Icon name="info" size={24} />
            </span>
            <div className="grow">
              <div className="title">&copy; OpenStreetMap contributors</div>
              <div className="sub">Where the map comes from</div>
            </div>
          </a>
          <a className="row" href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noreferrer">
            <span className="icon-tint">
              <Icon name="edit" size={24} />
            </span>
            <div className="grow">
              <div className="title">Fix the Map</div>
              <div className="sub">Report something that is wrong on it</div>
            </div>
          </a>
        </div>
      </div>
    </div>
  )
}
