# Paper Round

Offline PWA for a fixed newspaper round. React + Vite, data in localStorage, no server. It follows the iPhone's light or dark appearance and is styled like a native iOS app.

## Use
**Setup** has three steps, shown as a segmented control at the top of the sheet. Each ends with a *Next* button.

1. **Route**: no driving needed. Search for a street or town, tap *Draw Route*, then tap along your route in the order you drive it. *Undo* removes mistakes; zoom in for the bends. *Done* finishes. (*Record by Driving Instead* still works if you prefer to trace it with GPS.)
2. **Throw Side**: each section of the route has a *Both / Left / Right* toggle, and the route on the map is coloured to match (blue both, green left, orange right). A new route starts as one section on both sides. Tap *Add a Side Change* and then the route where the side changes to make another section; *Merge* joins a section back to the one before. Left and right are as you face the way you drive, and the arrows on the map show that direction.
3. **Stops**: choose *No-Throw* or *Bundle Drop*. Type or paste addresses, one per line (with the town or postcode), and tap *Look Up Addresses*. Each is matched on the map near your route and ticked when it is a close, exact match; check any that are flagged, then *Add*. You can also tap the map or use your current location to place a stop without an address. Swipe or tap the grabber at the top of the sheet to see more of the list.

**Round**: tap *Start Round* (unlocks sound, keeps the screen awake). You only get alerts for bundle drops and no-throw houses. Tap *Handled* to tick one off (several alerts queue up, no-throw first). The buttons at the top right follow your location or show the whole route, and *Reset* in the bottom card starts the round again.

## Notes
- Address lookup and place search use OpenStreetMap's free Nominatim service and need internet. House numbers are not always in OpenStreetMap: when only the street is found, the position is approximate and the app says so. Everything else works offline.
- Your route and stops are saved on the device you use, so draw the route on the phone you will drive with.
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
