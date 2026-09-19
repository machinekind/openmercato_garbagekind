# Room digital twin

The ERP exposes `/backend/digital-twins`, a read-only spatial twin reconstructed from the supplied LiDAR scan and room video. It has no live sensor connection and creates no operational state or tenant observations. Access requires an authenticated organization context and `digital_twins.view`.

The geometric scene is exported independently from the cleaned Blender project. Reference scans, comparison overlays, control-point empties, cameras and packed film frames remain in Blender and never enter the web asset. Units are metres; conversion is Blender `(x,y,z)` → glTF `(x,z,-y)`. Absolute scale has not been independently verified. The seven table surfaces were fitted to LiDAR; other geometry retains its approximate classification.

## User flows

- Open the module from the Facilities navigation. The renderer and GLB load only on this page; a poster and loading state cover initialization.
- Orbit, pan and zoom; switch to an orthographic floor plan and fit the room again.
- Toggle eleven semantic layers, including curtains, services and the ceiling. The ceiling starts disabled for a cutaway view.
- Select geometry by pointer or use the searchable keyboard-accessible element list. The inspector reports bounds and reconstruction confidence.
- Failed requests or unavailable WebGL show an explicit error and retry. Leaving the page releases WebGL resources and cancels pending model requests.

## Rebuild

From `mercato/digital-twin-web`, run `npm ci --ignore-scripts`, then `npm run build` and `npm test`. Three.js and esbuild are pinned build-time dependencies; the committed local renderer needs neither a CDN nor a new ERP runtime package dependency. Three.js licensing is retained with the assets.

Export with Blender 5.2:

```text
blender -b --python mercato/digital-twin-web/export_blender.py -- /path/to/Digital_Twin_uporzadkowany.blend mercato/modules/digital_twins/assets
```

The source `.blend` remains untouched. `room.manifest.json` and `room.glb` must be replaced together. `poster.webp` is a reduced preview of the same room. Install into an Open Mercato runtime using the module README and `mercato/install-digital-twins.mjs`; run the official generators after registration or translation changes. Standalone deployment must include the protected asset directory.

## Verification

The model tests load the actual GLB with the production loader, check every element identifier and world-space bound against its manifest, verify retention of source objects and eleven curtains, and enforce a four-megabyte asset budget with no external textures. Module Jest tests cover authentication, feature denial, traversal/asset allowlisting and manifest validation. Browser acceptance covers loading, top view, layer changes, selection, search and returning to the complete room. No database schema changes are required.
