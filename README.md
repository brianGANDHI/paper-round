# Paper Round

Offline PWA for a fixed newspaper round. React + Vite, data in localStorage, no server.

## Use
1. **Setup**: tap *Trace route*, drive the round, tap *Stop and save*. Then add bundle drops and no-throw houses (tap the map or *Mark here*), and set the delivery side (both/left/right) from any point on the route. Left/right is relative to your direction of travel.
2. **Round**: tap *Start round* (unlocks sound, keeps the screen awake). You only get alerts for bundle drops and no-throw houses. Tap *Handled* to tick one off (several alerts queue up, no-throw first); *Whole route* zooms out to the entire round and *Follow me* returns; *Reset* starts the round again.

## iPhone notes
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
