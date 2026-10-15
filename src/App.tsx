import { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from './Icon'
import { activeRoute, editActiveRoute, setActiveRound } from './library'
import { Round } from './Round'
import { Routes } from './Routes'
import { Setup } from './Setup'
import { canSave, loadLibrary, saveLibrary } from './storage'
import type { Library } from './types'

type Tab = 'round' | 'routes' | 'setup'

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'round', label: 'Round', icon: 'navigation' },
  { id: 'routes', label: 'Routes', icon: 'list' },
  { id: 'setup', label: 'Setup', icon: 'sliders' },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('round')
  const [library, setLibrary] = useState<Library>(loadLibrary)
  // False if the phone won't let the app keep anything, for example in a private tab.
  const [saveFailed, setSaveFailed] = useState(() => !canSave())
  const latest = useRef(library)

  // Ask the browser not to clear our data when space runs short. Harmless if it declines.
  useEffect(() => {
    try {
      navigator.storage?.persist?.()?.catch(() => {})
    } catch {
      // Not supported here.
    }
  }, [])

  /** Every change goes through here, so it is saved the moment it happens. */
  const update = (change: (lib: Library) => Library) => {
    const next = change(latest.current)
    latest.current = next
    setLibrary(next)
    setSaveFailed(!saveLibrary(next))
  }

  const current = activeRoute(library)

  return (
    <div className="app">
      {saveFailed && (
        <div className="save-warning" role="alert">
          <Icon name="alert" size={18} />
          <span>This phone isn't letting the app save. Your routes will be lost when you close it. Try a normal (not private) tab.</span>
        </div>
      )}
      <main>
        {tab === 'round' && (
          <Round
            route={current.route}
            round={current.round}
            routeName={current.name}
            onRound={(r) => update((lib) => setActiveRound(lib, r))}
            onGoSetup={() => setTab('setup')}
            onGoRoutes={() => setTab('routes')}
          />
        )}
        {tab === 'routes' && <Routes library={library} update={update} onGoSetup={() => setTab('setup')} />}
        {tab === 'setup' && (
          <Setup
            route={current.route}
            routeName={current.name}
            onChange={(r) => update((lib) => editActiveRoute(lib, r))}
            onGoRoutes={() => setTab('routes')}
          />
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
