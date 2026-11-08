import { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from './Icon'
import { activeRoute, adjustActiveRoute, editActiveRoute, setActiveRound, setActiveSections, setActiveStreets, setBundleOrder, setLoad } from './library'
import { Round } from './Round'
import { Routes } from './Routes'
import { Setup } from './Setup'
import { canSave, loadLibrary, saveLibrary, type SaveTrouble } from './storage'
import type { Library, LoadList } from './types'

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
  const [saveTrouble, setSaveTrouble] = useState<SaveTrouble | null>(() => (canSave() ? null : 'blocked'))
  const latest = useRef(library)

  // Ask the browser not to clear our data when space runs short. Harmless if it declines.
  useEffect(() => {
    try {
      navigator.storage?.persist?.()?.catch(() => {})
    } catch {
      // Not supported here.
    }
  }, [])

  /**
   * Every change goes through here, so it is saved the moment it happens. It says what kept the phone from saving it, or null when it was saved: when
   * it wasn't, the change is held only until the app closes, and a screen that can't let that stand (Accept) puts the routes back and says why.
   */
  const update = (change: (lib: Library) => Library): SaveTrouble | null => {
    const next = change(latest.current)
    latest.current = next
    setLibrary(next)
    // A phone that still takes a tiny note has room for something, just not for all the routes.
    const trouble = saveLibrary(next) ? null : canSave() ? 'full' : 'blocked'
    setSaveTrouble(trouble)
    return trouble
  }

  const current = activeRoute(library)
  // Names for parts of the route are saved for the route that was in use when they were made. Street names found by a lookup that was
  // running are kept only if the route is still the one (and has the points) it was asked about.
  const routeId = current.id
  // The driver's order of bundle drops is kept with the route it was set for, in the round's list or in Setup.
  const onBundleOrder = (order: string[]) => update((lib) => setBundleOrder(lib, routeId, order))
  // What is loaded before the round is kept with the route it was set for, as the order is.
  const onLoad = (list: LoadList) => update((lib) => setLoad(lib, routeId, list))

  return (
    <div className="app">
      {saveTrouble && (
        <div className="save-warning" role="alert">
          <Icon name="alert" size={18} />
          <span>
            {saveTrouble === 'full'
              ? "This phone has no room left for your routes, so your latest changes aren't saved. Delete a route you no longer need."
              : "This phone isn't letting the app save. Your routes will be lost when you close it. Try a normal (not private) tab."}
          </span>
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
            bundleOrder={current.bundleOrder}
            onBundleOrder={onBundleOrder}
            load={current.load}
            onLoad={onLoad}
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
            bundleOrder={current.bundleOrder}
            onBundleOrder={onBundleOrder}
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
