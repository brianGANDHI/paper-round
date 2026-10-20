import { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from './Icon'
import { activeRoute, adjustActiveRoute, editActiveRoute, setActiveRound, setActiveSections, setActiveStreets } from './library'
import { Round } from './Round'
import { Routes } from './Routes'
import { Setup } from './Setup'
import { canSave, loadLibrary, saveLibrary } from './storage'
import type { Library } from './types'

type Tab = 'round' | 'routes' | 'setup'

/** A route with no named sections or street names, as one stable value so nothing is redone for it on every render. */
const NONE: never[] = []

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
  // Names for parts of the route are saved for the route that was in use when they were made. Street names found by a lookup that was
  // running are kept only if the route is still the one (and has the points) it was asked about.
  const routeId = current.id

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
            sections={current.sections ?? NONE}
            streets={current.streets ?? NONE}
            onRound={(r) => update((lib) => setActiveRound(lib, r))}
            onAdjustRoute={(r) => update((lib) => adjustActiveRoute(lib, r))}
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
            sections={current.sections ?? NONE}
            onSections={(s) => update((lib) => (lib.activeId === routeId ? setActiveSections(lib, s) : lib))}
            streets={current.streets ?? NONE}
            onStreets={(s, points) => update((lib) => (lib.activeId === routeId && (!points || activeRoute(lib).route.points === points) ? setActiveStreets(lib, s) : lib))}
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
