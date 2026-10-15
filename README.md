# Paper Round

Offline PWA for a fixed newspaper round. React + Vite, data in localStorage, no server. It follows the iPhone's light or dark appearance and is styled like a native iOS app.

## Use
**Routes** keeps every round you run, for example a Monday round and a Saturday round. Tap a route to use it, *New Route* to add one (it takes you straight to Setup to draw it), and *Rename*, *Duplicate* or *Delete* to manage the one in use. Each route keeps its own sections, stops and progress. The route in use is named at the top of Setup and on the Round start screen; tap its name to switch.

**Setup** edits the route in use. It has three steps, shown as a segmented control at the top of the sheet. Each ends with a *Next* button.

1. **Route**: no driving needed. Search for a street or town, tap *Draw Route*, then tap along your route in the order you drive it. *Undo* removes mistakes; zoom in for the bends. *Done* finishes. (*Record by Driving Instead* still works if you prefer to trace it with GPS.)
2. **Throw Side**: each section of the route has a *Both / Left / Right* toggle, and the route on the map is coloured to match (blue both, green left, orange right). A new route starts as one section on both sides. Tap *Add a Side Change* and then the route where the side changes to make another section; *Merge* joins a section back to the one before. Left and right are as you face the way you drive, and the arrows on the map show that direction.

   **Driving a street more than once** (for example down it and back, throwing to a different side each time): tap *Repeat* on the section, then *Drive it back* (the same road the other way) or *Drive it again* (the same way, with a link back to its start). It is added to the end of your route as a new section with a side of its own, starting with the label that covers the other side of the street, and you can change it. Passes over the same road are drawn side by side on the map with their own arrows. The app follows the pass you are on, using the direction you are heading, so the side pill changes as you turn round, and a stop on that street warns you on every pass. To change the side partway along one pass, select its section first and then tap *Add a Side Change*.
3. **Stops**: choose *No-Throw* or *Bundle Drop*. Type or paste addresses, one per line (with the town or postcode), and tap *Look Up Addresses*. Each is matched on the map near your route and ticked when it is a close, exact match; check any that are flagged, then *Add*. You can also tap the map or use your current location to place a stop without an address. Swipe or tap the grabber at the top of the sheet to see more of the list.

**Round**: tap *Start Round* (unlocks sound, keeps the screen awake). If the last round was finished, the button says *Start New Round* and starts from scratch automatically. If it was only part done you can *Continue Round* or *Start Over*. You only get alerts for bundle drops and no-throw houses, once for each time your route goes past one. Tap *Handled* to tick one off (several alerts queue up, no-throw first). The buttons at the top right follow your location or show the whole route, and *Reset* in the bottom card starts the round again.

## Notes
- The map opens on Australia until it finds you or your route, and place searches lean toward Australia when you have no route yet.
- Address lookup and place search use OpenStreetMap's free Nominatim service and need internet. House numbers are not always in OpenStreetMap: when only the street is found, the position is approximate and the app says so. Everything else works offline.
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

Styling lives in `src/index.css`, built on iOS-style design tokens at the top of the file. Shared pieces (icons, segmented control, sheet, dialogs) are in `src/Icon.tsx`, `src/ui.tsx` and `src/confirm.tsx`.
