# Paper Round

Offline PWA for a fixed newspaper round. React + Vite, data in localStorage, no server. It follows the iPhone's light or dark appearance and is styled like a native iOS app.

## Use
**Routes** keeps every round you run, for example a Monday round and a Saturday round. Tap a route to use it, *New Route* to add one (it takes you straight to Setup to draw it), and *Rename*, *Duplicate* or *Delete* to manage the one in use. Each route keeps its own sections, stops and progress. The route in use is named at the top of Setup and on the Round start screen; tap its name to switch.

**Setup** edits the route in use. It has three steps, shown as a segmented control at the top of the sheet. Each ends with a *Next* button.

1. **Route**: no driving needed. Search for a street or town, tap *Draw Route*, then tap along your route in the order you drive it. The *Both / Left / Right* picker on the drawing panel says which side the stretch you are drawing is thrown on: change it and keep tapping, and a new section starts there, so you can lay out the whole route with its sides in one go. To fix a mistake, drag a point to move it, tap a point to select it and *Delete Point*, tap a **+** between two points to add one there, or *Undo* the last point. Zoom in for the bends. *Done* finishes and fits the route on screen. (*Record by Driving Instead* still works if you prefer to trace it with GPS.)

   **Follow roads** (optional, needs internet): switch it on beside *Undo* and *Done* while drawing, and each tap follows the streets from your last point to the tap instead of joining them with a straight line, so a curvy street takes one tap instead of many. The side you pick works exactly as before. It routes for a car, so one-way streets are respected: a tap on the far side of a one-way pair can send the route round the block, so tap the stretch you actually drive. While a road is being looked up the tap shows as a ring and *Undo* turns into *Cancel*; afterwards, *Undo* takes back a whole stretch of road at once. If there is no signal, the service is slow (over 5 seconds) or down, or there is no road near the tap, that stretch is drawn as a straight line and a note says why. Dragging and adding points work on the result as usual, and the switch is remembered. With it off, tapping is unchanged and works fully offline.
2. **Throw Side**: each section of the route has a *Both / Left / Right* toggle, and the route on the map is coloured to match (blue both, green left, orange right). Tap a coloured line on the map to pick its section in the list. To change just part of the road, tap *Paint a Stretch*, choose a side, then tap the route where the stretch starts and where it ends: it becomes a section of its own, joining a neighbour that is already on that side. *Merge* joins a section back to the one before. Left and right are as you face the way you drive, and the arrows on the map show that direction.

   **Driving a street more than once** (for example down it and back, throwing to a different side each time): tap *Repeat* on the section, then *Drive it back* (the same road the other way) or *Drive it again* (the same way, with a link back to its start). It is added to the end of your route as a new section with a side of its own, starting with the label that covers the other side of the street, and you can change it. Passes over the same road are drawn side by side on the map with their own arrows. The app follows the pass you are on, using the direction you are heading, so the side pill changes as you turn round, and a stop on that street warns you on every pass. To change the side partway along one pass, select its section first and then use *Paint a Stretch*.
3. **Stops**: choose *No-Throw* or *Bundle Drop*. Type or paste addresses, one per line (with the town or postcode), and tap *Look Up Addresses*. Each is matched on the map near your route and ticked when it is a close, exact match; check any that are flagged, then *Add*. You can also tap the map or use your current location to place a stop without an address. Swipe or tap the grabber at the top of the sheet to see more of the list.

**Round**: tap *Start Round* (unlocks sound, keeps the screen awake). If the last round was finished, the button says *Start New Round* and starts from scratch automatically. If it was only part done you can *Continue Round* or *Start Over*. You only get alerts for bundle drops and no-throw houses, once for each time your route goes past one. Tap *Handled* to tick one off (several alerts queue up, no-throw first). The buttons at the top right follow your location or show the whole route, and *Reset* in the bottom card starts the round again.

## Notes
- The map opens on Australia until it finds you or your route, and place searches lean toward Australia when you have no route yet.
- Address lookup and place search use OpenStreetMap's free Nominatim service, and Follow roads (below) uses a free routing service. Both need internet. House numbers are not always in OpenStreetMap: when only the street is found, the position is approximate and the app says so. Everything else works offline.
- **Follow roads** asks the free OSRM routing server that FOSSGIS runs at `routing.openstreetmap.de` (the one behind the directions on openstreetmap.org, car profile) for the way from your last point to each tap. Each lookup sends just the two ends of that stretch, plus your IP address and the app's web address. It is one request per tap, one at a time and never more than one a second, as FOSSGIS's [terms of use](https://www.fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/) require; the map credits OpenStreetMap and links to *Fix the map*, which they also ask for. Those terms say the server is best effort with no promise it keeps running or stays the same, and that heavy or high-traffic use is not allowed, so it suits one person tracing their own rounds. If the app is ever shared widely, run your own OSRM and build with `VITE_ROUTING_URL` set to its address (for example `https://osrm.example.com/route/v1/driving`).
- Routes are saved automatically on the phone, after every change, and are still there next time you open the app. There is no Save button. A red bar appears if the phone refuses to store anything (for example in a private tab).
- They live only on that phone. On an iPhone, Safari and an app added to the Home Screen keep separate copies, so draw your routes in whichever one you will use (the Home Screen app is best). Deleting the app or clearing Safari's website data removes them.
- **Back up and restore** (in Routes): *Back Up This Route* or *Back Up All Routes* shows a block of text. Copy it into Notes, or Share it, to keep a safe copy. *Restore from Backup* takes that text and adds the routes to your list without replacing anything, so it is also how you move routes to another phone.
- Safari has no vibration API, so the no-throw warning is a flashing red screen plus a tone (the phone's silent switch mutes it). Vibration is used where supported.
- GPS only updates while the app is open and the screen is on. Mount the phone and keep it unlocked.
- Map tiles need signal; offline you still see the route, stops and your position on a plain background.

## Install on iPhone
Geolocation needs HTTPS, so host the built files once (GitHub Pages via `.github/workflows/deploy.yml`), open the URL in Safari, then Share > Add to Home Screen. Open it once online so it caches; after that it works offline.

## Develop
```bash
npm install
npm run dev
npm test
npm run build
```

Follow roads is `src/roads.ts` (the routing request, the answer turned into points, the straight-line fallback and undo of a road stretch, tested in `src/roads.test.ts` with `fetch` mocked) and `src/useRoadFollow.ts` (runs the lookups for Setup). Build with `VITE_ROUTING_URL` set to point it at a different OSRM server.

Styling lives in `src/index.css`, built on iOS-style design tokens at the top of the file. Shared pieces (icons, segmented control, sheet, dialogs) are in `src/Icon.tsx`, `src/ui.tsx` and `src/confirm.tsx`.
