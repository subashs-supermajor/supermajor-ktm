# 390 Duke 3D Experience

Interactive 3D product viewer for the KTM 390 Duke: a Super Major proposal concept, pending KTM approval.
The full brief is in `../README_KTM_3D_Experience_Antigravity.md`.

## Run

```bash
npm install        # also copies the Draco/KTX2 decoders into public/decoders
npm run dev        # http://localhost:5173 (also exposed on your LAN for phone testing)
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build
```

Requires Node 18+. On Windows machines with Application Control turned on, Rollup's native
binary is blocked, so `package.json` overrides it with `@rollup/wasm-node`. The output is the same.

## Public URL through Cloudflare Tunnel (Windows)

Publishes the production build at **https://vida-3d.softsuaveai.space** through a dedicated
Cloudflare Tunnel named `vida-3d`. The app listens only on `127.0.0.1:4173`; nothing is opened
on the firewall.

```powershell
.\scripts\start.ps1            # build if sources changed, start app + tunnel, run health checks
.\scripts\start.ps1 -Rebuild   # force a fresh production build
.\scripts\stop.ps1             # stop this project's app + tunnel only
```

If PowerShell blocks the scripts, run them with
`powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1`.

**One-time setup** (already done on this machine):

1. Install cloudflared: `winget install --id Cloudflare.cloudflared`
2. Log in: `cloudflared tunnel login`, open the printed URL and authorize `softsuaveai.space`.
   If you authorize on another machine and it downloads `cert.pem`, copy it to
   `%USERPROFILE%\.cloudflared\cert.pem` on this machine.

`start.ps1` creates the tunnel and the `vida-3d` DNS record the first time and reuses them after
that. It never overwrites a DNS record that points to a different tunnel.

| What                        | Where                                                                         |
| --------------------------- | ----------------------------------------------------------------------------- |
| Tunnel config               | `%USERPROFILE%\.cloudflared\vida-3d.yml`                                      |
| Tunnel credentials (secret) | `%USERPROFILE%\.cloudflared\<tunnel-id>.json`                                 |
| PIDs, state, logs           | `.run\` (`state.json`, `app.log`, `build.log`, `tunnel.log`)                  |
| Health checks               | app: `GET http://127.0.0.1:4173/`; tunnel: `GET http://127.0.0.1:41730/ready` |

The public site serves the production build (`vite preview`), not `npm run dev`: the dev server's
`/__studio` endpoints can overwrite project files and must not be public. The tunnel sends
`Host: localhost` to the app because Vite rejects unknown hostnames.

`stop.ps1` leaves the tunnel, its DNS record and config in place. To remove them for good:
`cloudflared tunnel route dns` records are deleted in the Cloudflare dashboard (DNS → `vida-3d`),
then `cloudflared tunnel delete vida-3d`.

## Adding the real assets

| What              | Where                                          |
| ----------------- | ---------------------------------------------- |
| 3D model (web)    | `public/assets/models/ktm-390-duke/model.glb`  |
| 3D model (iOS AR) | `public/assets/models/ktm-390-duke/model.usdz` |
| Client logo       | `public/assets/logos/client-logo.svg`          |
| No-WebGL image    | set `asset.fallbackImage` in the model config  |

Until the GLB exists, the stage explains what's missing. You can also drop any `.glb` onto the stage
to preview it locally; it isn't uploaded anywhere.

Draco, Meshopt and KTX2-compressed GLBs are all supported.

## Configuring the model: `src/config/models/ktm-390-duke.json`

- **`frontAxis`**: the direction the bike's nose points in the file (`+z` is the glTF convention).
  Camera presets and hotspots depend on it. If "Front" shows the rear, flip it.
- **`paintSlots`**: which parts change colour. Each `match` entry is compared, case-insensitively,
  against mesh and material names in the GLB. In dev mode the browser console lists every material
  name in the loaded model, which makes mapping quick. Unmatched parts (tyres, engine, frame…) keep
  their original materials. If nothing matches, the swatches are disabled and the page says so.
- **`variants`**: the three current finishes are clearly labelled demo colours (`approvalStatus: "demo"`).
  Replace them with KTM-approved names and values and set `approvalStatus` to `"approved"`.
- **`hotspots`**: positions are relative to the bike, so they survive a model swap:
  `along` 0 = rear → 1 = front, `height` 0 = ground → 1 = top, `side` −1 = left → 1 = right.
  Descriptions are placeholders until KTM supplies approved copy.

## Studio tools (dev server only)

Both run inside `npm run dev` and write straight into the project. They aren't in the production build.

**360° frames: `http://localhost:5173/?edit=360`**
Click _Render 360° frames_. Each colour with its own model file is rendered as 72 WebP frames
(5° steps, 1600×900, black stage and turntable ring) into `public/assets/360/<variant>/`, plus
`public/assets/360/manifest.json`. The 360° section on the page plays these frames. Re-run it whenever a
model changes.

**Hotspot placement: `http://localhost:5173/?edit=hotspots`**
Pick a colour, pick a hotspot in the panel, then click the model where it belongs (drag still rotates).
It moves to the next hotspot automatically. Repeat for each colour, then press _Save positions_: they're
written to `src/config/models/ktm-390-duke.anchors.json`, one exact position per model file. Hotspots
without a saved position are snapped onto the model surface automatically.

## AR

- **iPhone / iPad**: Apple Quick Look with the USDZ file.
- **Android**: Google Scene Viewer with the GLB. This needs the site served over **HTTPS**, because
  Scene Viewer downloads the file itself.
- **Everything else**: the AR button explains where AR works and offers to copy the link.

AR viewers show the model's default finish, not the colour selected on the page.

## Structure

```
src/
  components/
    Viewer/          MotorcycleViewer (React) + viewerEngine (three.js: scene, camera, loading, paint)
    ViewerControls/  zoom / reset / auto-rotate / fullscreen rail, camera presets
    VariantSelector/ colour swatches
    Hotspots/        feature detail card
    AR/              AR launcher
    Layout/          top bar, footer, share, toast
  config/            model JSON, brand, design tokens
  services/          model download, AR detection, analytics
  hooks/ utils/ styles/
```

## Analytics

`src/services/analytics.ts` pushes the events listed in the brief to `window.dataLayer`, but only when
an approved analytics tag has created it. Nothing is collected otherwise.

## Before this goes in front of the client

- [ ] Real 390 Duke GLB in place, `frontAxis` checked, paint slots mapped
- [ ] Approved logo in `public/assets/logos/`
- [ ] Demo variants replaced or still clearly labelled
- [ ] Hosted on HTTPS and AR tested on a real Android phone and a real iPhone

Start
& "C:\Users\HP\Desktop\Super Major\Projects\Presentation\KTM\ktm-3d-experience\scripts\start.ps1"

Stop
& "C:\Users\HP\Desktop\Super Major\Projects\Presentation\KTM\ktm-3d-experience\scripts\stop.ps1"
