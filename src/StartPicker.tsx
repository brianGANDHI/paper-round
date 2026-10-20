import { useMemo, useRef, useState } from 'react'
import { useDialogs } from './confirm'
import { Icon } from './Icon'
import { alongPath, cumulativeDistances, snapAtDistance, type Occurrence } from './geo'
import { MapCredit } from './MapCredit'
import { MapView, type ViewCmd } from './MapView'
import { resolveSections, sectionAt, sectionPoint, sectionStatus } from './namedSections'
import { passesAt, passLabel } from './passChoice'
import { handledForResume } from './resume'
import { formatDistance, nearestOnRoute, ON_ROUTE_M, sections as throwSections } from './routeEdit'
import { Sheet } from './ui'
import type { NamedSection, Pt, Route } from './types'

interface Props {
  route: Route
  /** The route's named sections. */
  sections: readonly NamedSection[]
  /** The stops that alert, by pass, and which of them are done now. */
  occs: readonly Occurrence[]
  handled: ReadonlySet<string>
  /** How far before the spot a stop still counts as ahead of it, in metres: see `slackFor`. */
  slack: number
  /** Where the phone is, if it is known. */
  position: Pt | null
  /** Starting a round at a spot, or skipping on or back to one part way through it. */
  mode: 'start' | 'jump'
  /** A spot has been chosen: how far along the route it is, in metres, and what to call it. */
  onPick: (metres: number, name: string) => void
  onClose: () => void
}

/** The map a spot on the route is picked on: tap the line, or choose a named section from the list. */
export function StartPicker({ route, sections, occs, handled, slack, position, mode, onPick, onClose }: Props) {
  const [picked, setPicked] = useState<{ m: number; pos: Pt } | null>(null)
  const [view, setView] = useState<ViewCmd>()
  // On a short screen (a phone on its side) the header alone fills the usual height of the sheet, so it opens tall.
  const [expanded, setExpanded] = useState(() => window.innerHeight < 560)
  const [notice, setNotice] = useState<string | null>(null)
  const { choose, dialog } = useDialogs()
  const viewKey = useRef(0)
  const cum = useMemo(() => cumulativeDistances(route.points), [route.points])
  const resolved = useMemo(() => resolveSections(route.points, sections), [route.points, sections])
  const throws = useMemo(() => throwSections(route), [route])
  const status = useMemo(() => new Map(sectionStatus(resolved.list, occs, handled).map((s) => [s.id, s])), [resolved, occs, handled])
  const marks = useMemo(() => resolved.list.filter((s) => !s.lead).map((s) => ({ pos: sectionPoint(route.points, s), label: s.name })), [resolved, route.points])
  const length = cum[cum.length - 1] ?? 0

  const goTo = (cmd: Omit<ViewCmd, 'key'>) => setView({ ...cmd, key: (viewKey.current += 1) })

  const pickAt = (m: number, fly: boolean) => {
    const at = snapAtDistance(route.points, m)?.point ?? route.points[0]
    setPicked({ m, pos: at })
    setNotice(null)
    if (fly) goTo({ center: at, zoom: 17 })
  }

  /** A tap on the route. Where a road is driven more than once, the time through is asked, since the passes may lie on the same line. */
  const tapRoute = async (pos: Pt, within?: { idx: number; endIdx: number }) => {
    const snap = nearestOnRoute(route, pos, within ? { from: within.idx, to: within.endIdx } : undefined)
    if (!snap || snap.dist > ON_ROUTE_M) return setNotice('Tap on the route, or pick a section from the list.')
    const passes = passesAt(route.points, snap.point, within)
    if (passes.length < 2) return pickAt(alongPath(cum, snap.idx, snap.t), false)
    const choice = await choose<string>({
      title: 'Which Time Through?',
      message: 'The route goes along this road more than once.',
      choices: passes.map((p, i) => ({ value: String(i), ...passLabel(i, p.at) })),
    })
    const pass = passes[Number(choice)]
    if (choice !== null && pass) pickAt(pass.at, false)
  }

  const here = picked ? sectionAt(resolved.list, picked.m) : null
  // What the spot is called: the start of the route, a named section where it starts, or a spot in one (how far along is under it).
  const spot = !picked
    ? ''
    : picked.m < slack
      ? 'the beginning of the route'
      : here && !here.lead && picked.m - here.startM < 5
        ? here.name
        : here && !here.lead
          ? `a spot in ${here.name}`
          : 'this spot'
  // What choosing the spot does to the stops: those before it count as done, and those after it that are done come up again.
  const done = picked ? handledForResume(occs, picked.m, slack) : []
  const comeBack = picked ? occs.filter((o) => handled.has(o.key) && !done.includes(o.key)).length : 0
  const newlyDone = done.filter((k) => !handled.has(k)).length

  return (
    <div className="picker">
      <MapView
        route={route}
        position={position}
        selectable
        onSectionTap={(index, _at, pos) => void tapRoute(pos, throws[index])}
        onTap={(p) => void tapRoute(p)}
        marks={marks}
        pin={picked ? { pos: picked.pos, label: mode === 'start' ? 'Start here' : 'Skip to here', color: '#007aff' } : null}
        bottomFrac={0.45}
        view={view}
        outsideCredit
      />
      <MapCredit />
      <button className="picker-close" onClick={onClose}>
        <Icon name="x" size={18} strokeWidth={2.4} />
        Cancel
      </button>
      <Sheet
        expanded={expanded}
        onExpandedChange={setExpanded}
        header={
          <div className="picker-head">
            <div className="picker-title">{mode === 'start' ? 'Choose Where to Start' : 'Skip to a Spot or Section'}</div>
            {picked ? (
              <div className="row">
                <span className="icon-tint">
                  <Icon name="flag" size={22} />
                </span>
                <div className="grow">
                  <div className="title">
                    {mode === 'start' ? 'Start at' : 'Skip to'} {spot}
                  </div>
                  <div className="sub">
                    {formatDistance(picked.m)} along the {formatDistance(length)} route
                    {newlyDone > 0 && ` · ${newlyDone} ${newlyDone === 1 ? 'stop' : 'stops'} before it will count as done`}
                    {comeBack > 0 && ` · ${comeBack} done ${comeBack === 1 ? 'stop' : 'stops'} after it will come up again`}
                  </div>
                </div>
              </div>
            ) : (
              <p className="footnote">{notice ?? 'Tap the route on the map where you want to begin, or choose a section below.'}</p>
            )}
            <button className="btn primary block" disabled={!picked} onClick={() => picked && onPick(picked.m, spot)}>
              {mode === 'start' ? 'Start Here' : 'Skip to Here'}
            </button>
          </div>
        }
      >
        <div className="group picker-list">
          <button className="row" onClick={() => pickAt(0, true)}>
            <div className="grow">
              <div className="title">Beginning of the route</div>
              <div className="sub">The whole route, from the start</div>
            </div>
          </button>
          {resolved.list
            .filter((s) => !s.lead)
            .map((s) => {
              const st = status.get(s.id)
              return (
                <button key={s.id} className="row" onClick={() => pickAt(s.startM, true)}>
                  <div className="grow">
                    <div className="title">{s.name}</div>
                    <div className="sub">
                      {formatDistance(s.startM)} to {formatDistance(s.endM)}
                      {st && (mode === 'jump' ? ` · ${st.left} of ${st.total} ${st.total === 1 ? 'stop' : 'stops'} not done yet` : ` · ${st.total} ${st.total === 1 ? 'stop' : 'stops'}`)}
                    </div>
                  </div>
                </button>
              )
            })}
        </div>
        {resolved.list.length === 0 && <p className="footnote">Name parts of your route in Setup, under Sections, to start from them here.</p>}
      </Sheet>
      {dialog}
    </div>
  )
}
