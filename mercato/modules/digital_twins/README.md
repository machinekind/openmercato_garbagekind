# Digital twins

Geometric twin of the packaged room, reconstructed from LiDAR and video references, with an initial camera-management and anonymous person-tracking layer. The camera pipeline detects people in a locally selected recording, projects the bottom-center of each detection onto the twin floor, associates nearby detections into session tracks, and renders them in the 3D viewer. It does not identify people or upload the raw recording.

The supplied camera pose and four-point floor mapping are explicitly `estimated`: the model scale and the camera extrinsics have not yet been independently surveyed. Use track coordinates as a commissioning preview, not as a safety, payroll, access-control, or productivity measurement. A verified deployment must replace the estimated image/twin control polygons with surveyed points.

## Routes

- `/backend/digital-twins`: authenticated viewer; requires `digital_twins.view`.
- `GET /api/digital_twins/room`: validated room manifest, with layers, objects, bounds in meters (glTF Y-up), statistics and provenance.
- `GET /api/digital_twins/cameras`: validated camera registry with source metadata, privacy mode and floor calibration; raw paths and stream credentials are never returned.
- `GET /api/digital_twins/assets/{name}`: fixed allowlist of the room, renderer, tracker, preview and packaged detector-model files. All require the same authentication, organization context and feature permission. Unknown names return 404; unavailable packaged assets return 503. Raw manifests, source Blender files and LiDAR scans cannot be downloaded through this route.

The browser-side tracker uses TensorFlow.js and COCO-SSD. Model weights are packaged with the module and served through the same authenticated API, so analysis does not require an external model host; detections and frames stay in the browser. Track identifiers are anonymous and live only for the current page session. The integration is architecturally inspired by the Camtracker pipeline supplied for this project; the ERP-specific calibration, tracking adapter, access controls, and twin renderer are maintained here. The packaged COCO-SSD model is distributed under the Apache-2.0 notice in `assets/COCO-SSD-LICENSE.txt`.

Responses are private and `no-store`; never place room geometry in `public/`. The manifest schema strips unknown fields and rejects external model/poster URLs. File paths never derive from request input.

## Installation and deployment

From the outer repository, run `node mercato/install-digital-twins.mjs /path/to/open-mercato`. The argument defaults to the nested `open-mercato` checkout, and `MERCATO_ROOT` is also supported. This cross-platform installer copies only this module, including `assets/`, into `apps/mercato/src/modules/digital_twins` and registers it idempotently. It does not delete files or replace other modules. Runtime changes to this module are overwritten by its source counterpart; keep edits in the outer repository and repeat the installer after building assets or changing source.

From the runtime repository run `yarn generate`, then from `apps/mercato` run `yarn mercato auth sync-role-acls` and `yarn mercato configs cache structural --all-tenants`. Setup grants `digital_twins.view` to default admin and employee roles. Existing custom roles require an explicit feature grant.

The asset reader supports app-root and monorepo-root process working directories. Standalone deployments must copy the protected assets directory into the app image, or set `DIGITAL_TWINS_ASSET_DIR` to its absolute path. This directory must contain only trusted release build assets; `viewer.js` executes as application code. Include these files in Next output tracing or copy them separately when producing a standalone image. No runtime CDN or public bucket is required.

For Next standalone output, merge the following property into the existing app `nextConfig` (preserving any existing tracing rules): `outputFileTracingIncludes: { '/*': ['./src/modules/digital_twins/assets/**/*'] }`. The installer deliberately does not rewrite Next configuration; alternatively copy the directory explicitly into the deployment image at the same app-relative path.

No database migration, tenant fixture, entity mutation, or dependency on fleet data is required. The current registry is packaged commissioning data. Before connecting RTSP gateways or storing telemetry, replace it with a tenant-and-organization-scoped encrypted camera registry and a retention policy.

## Verification

`__tests__/routes.test.ts` covers anonymous and feature-denied requests, missing organization scope, path traversal and unknown names, MIME types, private caching, unavailable files and invalid manifests. Run with the app Jest configuration after installation.
