# WORLDVIEW OSINT — Progress Log

> Hand-off file. Any AI/dev continuing this work: read this first, then continue from **Next steps**.
> Source repo: https://github.com/daggerm29-oss/sky8 (branch `main`, imported into the v0 workspace without `.git`).

## Architecture (as found)

```
next dev (port 3000, scripts/dev.mjs)  --rewrites /*-->  Vite dev server (5173)
                                                           artifacts/worldview (React 19 + MapLibre GL v5 + Cesium + three)
                                                           vite.config.ts mounts the Express routers from
                                                           artifacts/api-server/src/routes (proxy.ts, cctv.ts) at /api
Express proxy (/api/proxy/*)  --> upstream maritime backend (SHIPS_UPSTREAM_URL) + adsb.lol + CelesTrak + CCTV feeds
```

- `artifacts/worldview/src/pages/WorldviewMap.tsx` (~2.5k lines) — main map page, state, layers, toolbar.
- `components/ShipsLayer.tsx`, `SatelliteLayer.tsx`, `PlaybackLayer.tsx`, `CctvLayer.tsx` — MapLibre layers.
- `components/CesiumFollowCam.tsx` — Cesium 3D follow camera (pre-existing, aircraft only).
- `components/CinematicOverlay.tsx`, `FloatingPanel.tsx`, `MaritimePanel.tsx`, `MasterToolbar.tsx`.
- `artifacts/api-server/src/routes/proxy.ts` — all upstream proxies (ships, dark-fleet, oil, status, playback, adsb).
- 3D models in `artifacts/worldview/public/`: `aeroplane.glb`, `military-aircraft.glb`, `satellite.glb`, `iss.glb`, `ship.glb`, `tanker.glb`.
- npm workspaces (root `package.json`); install with `npm install` at repo root.

## New backend: https://worldview-intel.ai.studio

Verified live 2026-10-17 (same JSON schema as the old Render backend):
- `/api/status` → `{live_vessels, dark_ships_tracked, ais:{...}, uptime_min}`
- `/api/radar` → `[{mmsi, vessel_name, lat, lon, sog, cog, last_updated, dwt, est_barrels, category, source}]` (~3.3 MB)
- `/api/live` → same without dwt/category
- `/api/dark-fleet` → `[{mmsi, ship_name, last_known_lat, last_known_lon, time_went_dark, last_sog, last_cog}]`
- `/api/analytics/live-oil`, `/api/playback/config` → OK

## Step log

- [x] **Step 1** — Cloned repo, mapped architecture, probed new backend (all endpoints 200).
- [x] **Step 2** — Imported repo into v0 workspace; removed conflicting v0 template files.
- [x] **Step 3** — Backend migration: `proxy.ts` default `SHIPS_UPSTREAM_URL` → `https://worldview-intel.ai.studio`,
      `.env.example` + `replit.md` updated. `grep -r onrender` is clean.
- [x] **Step 4** — Single-click → right-side `EntityInfoPanel` (ship / aircraft / satellite). `ShipsLayer` got `onSelect/onTrack`
      (padded bbox picking); `SatelliteLayer` got `onFocus/onTrack` (dblclick); aircraft already had click/dblclick and now also feeds the panel via `focus` state in `WorldviewMap.tsx`.
- [x] **Step 5** — Double-click → cinematic 3D follow view. New `lib/tracked-entity.ts`, `components/CinematicTracker.tsx`
      (Cesium, own lookAt camera: log-range intro zoom-in from 3000 km, drag-orbit, wheel zoom, dead reckoning, trail, fade),
      `CinematicHost.tsx` (keeps last target mounted so exit = pull-back + fade, ~1.5s), `CinematicController` in `WorldviewMap.tsx`.
      Models: aeroplane/military-aircraft/ship/tanker/satellite/iss .glb. Esc or panel EXIT 3D exits. Old `CesiumFollowCam.tsx` is now unused (safe to delete).
- [x] **Step 6** — `npm install` + `node scripts/dev.mjs` (Next :3000 -> Vite :5173). Browser-verified aircraft path end to end:
      click -> right panel, TRACK 3D -> intro zoom + GLB aircraft over 3D terrain with panel kept visible, Esc -> pull-back + fade + map restore.
      Ships/satellites share the same code path and type-check, but were NOT live-tested: the new backend currently reports
      `live_vessels: 0` (AIS socket closed), only 50 dark-fleet gap candidates; satellites need 3D ORBITAL + SATS on.

## Next steps
- Live-test ship (dblclick a dark-fleet dot) and satellite (3D ORBITAL, SATS) cinematic views; tune `KIND_CONFIG` in `CinematicTracker.tsx` (scale/range per kind).
- Aircraft wingtip/strobe lights use fixed metre offsets and look too wide vs the min-pixel-sized model; scale them or drop them.
- Exiting 3D currently also deselects the aircraft (legacy behaviour); ships/satellites keep their panel open.
- Remaining pre-existing TS errors are only in `src/components/ui/*` (React type version mismatch).

## Design for steps 4–5

New / changed files:
- `src/lib/tracked-entity.ts` — `EntityRef = {kind:"aircraft"|"ship"|"satellite", id}`, `FollowTarget`
  (lat, lon, altM, headingDeg, speedMs), model-URL/scale picker per entity.
- `src/components/EntityInfoPanel.tsx` — right-side panel (top-right, zIndex 30) with live name / position /
  movement / intel fields + "TRACK 3D" / "EXIT 3D" button. Stays visible during tracking.
- `src/components/CinematicTracker.tsx` — generic Cesium follow-cam (replaces aircraft-only CesiumFollowCam usage):
  camera.lookAt each frame with own drag/wheel orbit, dead-reckoning between samples (heading+speed),
  intro zoom-in + fade, exit zoom-out + fade then `onExited`. Trail polyline behind the model.
- `ShipsLayer.tsx` — `onSelect(ship)` on click, `onTrack(ship)` on dblclick.
- `SatelliteLayer.tsx` — `onSelect` + `onTrack` (dblclick) via the projected hit test.
- `WorldviewMap.tsx` — `selectedEntity` + `trackedEntity` state.

Models: `aeroplane.glb` (civil), `military-aircraft.glb` (mil — old code pointed at a missing `jet.glb`),
`ship.glb`, `tanker.glb` (TANKER), `satellite.glb`, `iss.glb` (ISS/ZARYA). All ~1.9 units long on X →
same `heading - 90°` orientation; scale per kind.

