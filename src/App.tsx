import { useState } from 'react'
import { Round } from './Round'
import { Setup } from './Setup'
import { loadRound, loadRoute, saveRound, saveRoute } from './storage'
import type { RoundState, Route } from './types'

export default function App() {
  const [tab, setTab] = useState<'round' | 'setup'>('round')
  const [route, setRoute] = useState<Route>(loadRoute)
  const [round, setRound] = useState<RoundState>(loadRound)

  const updateRoute = (r: Route) => {
    setRoute(r)
    saveRoute(r)
    // Stop ids may no longer exist; a changed route also restarts the round.
    const fresh = { handledStopIds: [] }
    setRound(fresh)
    saveRound(fresh)
  }

  const updateRound = (r: RoundState) => {
    setRound(r)
    saveRound(r)
  }

  return (
    <div className="app">
      <main>
        {tab === 'round' ? (
          <Round route={route} round={round} onRound={updateRound} />
        ) : (
          <Setup route={route} onChange={updateRoute} />
        )}
      </main>
      <nav>
        <button className={tab === 'round' ? 'on' : ''} onClick={() => setTab('round')}>Round</button>
        <button className={tab === 'setup' ? 'on' : ''} onClick={() => setTab('setup')}>Setup</button>
      </nav>
    </div>
  )
}
