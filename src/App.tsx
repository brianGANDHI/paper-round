import { useState } from 'react'
import { Icon, type IconName } from './Icon'
import { Round } from './Round'
import { Setup } from './Setup'
import { loadRound, loadRoute, saveRound, saveRoute } from './storage'
import type { RoundState, Route } from './types'

type Tab = 'round' | 'setup'

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'round', label: 'Round', icon: 'navigation' },
  { id: 'setup', label: 'Setup', icon: 'sliders' },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('round')
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
          <Round route={route} round={round} onRound={updateRound} onGoSetup={() => setTab('setup')} />
        ) : (
          <Setup route={route} onChange={updateRoute} />
        )}
      </main>
      <nav className="tabbar" aria-label="Main">
        {TABS.map((t) => (
          <button key={t.id} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} size={24} fill={tab === t.id} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}
