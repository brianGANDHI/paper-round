/** The credit OpenStreetMap asks for wherever its map is shown, as a small chip that is always in view (not inside a map that may be turned). */
export function MapCredit() {
  return (
    <div className="map-credit">
      &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors &middot;{' '}
      <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noreferrer">Fix the map</a>
    </div>
  )
}
