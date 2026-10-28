interface Props {
  /** Only the credit itself, as small as it can be, for a screen with no room (the round): the link to fix the map is in its menu instead. */
  compact?: boolean
}

/** The credit OpenStreetMap asks for wherever its map is shown, as a small chip that is always in view (not inside a map that may be turned). */
export function MapCredit({ compact = false }: Props) {
  if (compact) {
    return (
      <div className="map-credit compact">
        &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors
      </div>
    )
  }
  return (
    <div className="map-credit">
      &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors &middot;{' '}
      <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noreferrer">Fix the map</a>
    </div>
  )
}
