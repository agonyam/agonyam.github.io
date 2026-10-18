# WebODM Location Workflow

This guide is for agents adding, maintaining, or replacing survey locations on the Agonyam map site.

## Architecture

- GitHub Pages hosts the site and shared viewer code.
- Cloudflare R2 stores survey binaries and generated map assets.
- `https://map-assets-proxy.akyoltarik.workers.dev/<slug>` exposes each R2 location to the browser.
- `.env.r2.local` contains the local R2 configuration and credentials.
- `viewer.js`, `map.js`, `viewer.css`, `hydrology-worker.js`, and `vendor/` are shared by every location.
- Each location has a small HTML entry point at `<slug>/index.html`.

Never read, print, copy into logs, commit, or expose `.env.r2.local`. It is already covered by the `.env*` ignore rule. Commands may load it into the process environment without displaying its contents.

## Before changing anything

1. Work in `/Users/tarikakyol/Developer/Agonyam/map`.
2. Run `git status --short` and preserve all existing unrelated changes.
3. Confirm the WebODM task is complete and identify the exact project/task; never guess a task UUID.
4. Open its WebODM 2D and 3D views as the visual reference.
5. Choose a stable lowercase ASCII slug, for example `lokman`.

Do not overwrite an existing location unless the user explicitly asks to replace it.

## Required WebODM outputs

Prepare these assets in a temporary staging directory outside the repository first:

Do not create or retain `<slug>/assets/` in this repository. The directory below describes the R2 object layout only.

```text
<slug>/assets/
  entwine_pointcloud/
    ept.json
    ept-build.json
    ept-data/*.laz
    ept-hierarchy/*
  shots.geojson
  textured_model.glb               optional
  map/
    orthophoto/{z}/{x}/{y}.png
    plant-health/{z}/{x}/{y}.png    optional
    elevation.json
    dtm-elevation.png
    dtm-hillshade-normal.png
    dtm-hillshade-extruded.png
    dsm-elevation.png
    dsm-hillshade-normal.png
    dsm-hillshade-extruded.png
```

Contours are generated live in the browser from the DTM at any 0.1–10 m interval, so no contour file is uploaded; a working DTM is required for the contour control. The browser-facing files must use WGS 84 extents. Preserve the original survey CRS in metadata; metric calculations use a UTM zone derived automatically from the midpoint of `extent4326`. Pass `utmDefinition` in `SURVEY_CONFIG` only when a location needs an explicit override.

Do not publish raw source photographs, raw GeoTIFFs, the original full LAZ, reports, caches, or WebODM credentials. The EPT hierarchy and tiled/derived map products are the deployable outputs.

## Asset generation

`tools/gen.py` is the single generalized pipeline (GDAL + numpy + Pillow, runs inside the
`node-odx-1` container where those are installed). It takes any completed WebODM task and
produces the whole `map/` tree plus `meta.json` for `SURVEY_CONFIG`:

```text
in_dir:  dtm.tif, dsm.tif, odm_orthophoto.tif   (copied from the task outputs)
out_dir: dtm/dsm-elevation.png (R*256+G packed, 0.01 scale)
         dtm/dsm-hillshade-{normal,extruded}.png (gdaldem, z1/z2, az315/alt45)
         orthophoto/{z}/{x}/{y}.png + plant-health/{z}/{x}/{y}.png (XYZ z15-22,
           bilinear; VARI = (G-R)/(G+R-B) with the house brown-green ramp)
         elevation.json, meta.json (extent4326, gsdMeters, areaSquareMeters)
```

Terrain rasters are bilinear-warped so the longest side is `MAXEDGE` (default 3000 px, override
with the environment for high-relief sites; Aşağıçavuş used 6000). Tiles skip fully
transparent cells. `contours-wgs84.geojson` is also emitted but never uploaded.

```sh
# 1. stage task outputs (node container paths)
docker exec node-odx-1 mkdir -p /var/www/data/gen/<slug>/in /var/www/data/gen/<slug>/out
docker exec node-odx-1 bash -c "cp /var/www/data/<node-uuid>/odm_dem/dtm.tif \
  /var/www/data/<node-uuid>/odm_dem/dsm.tif /var/www/data/gen/<slug>/in/ && \
  cp /var/www/data/<node-uuid>/odm_orthophoto/odm_orthophoto.tif /var/www/data/gen/<slug>/in/"
# 2. run (MAXEDGE=3000 default; export MAXEDGE=6000 only for hi-res exceptions)
docker exec node-odx-1 bash -c "cd /var/www/data/gen && python3 gen.py <slug> \
  /var/www/data/gen/<slug>/in /var/www/data/gen/<slug>/out"
# 3. copy out/ back to the host staging dir, dropping contours-*.geojson, *_small.tif, *.aux.xml
```

Assemble the rest of the tree on the host from the WebODM task media directory:

- `entwine_pointcloud/` ← `ept.json`, `ept-build.json`, `ept-data/`, `ept-hierarchy/`
- `shots.geojson` ← `odm_report/shots.geojson`
- `textured_model.glb` ← `odm_texturing/odm_textured_model_geo.glb`, Draco-compressed:
  `gltf-transform optimize in.glb out.glb --compress draco --texture-compress webp`
  (expect ~5–10× smaller; verify the `glTF` magic bytes afterwards).

`meta.json` carries the measured `extent4326`, `areaSquareMeters`, and `gsdMeters` for the
`SURVEY_CONFIG` block; `elevation.json` carries the measured DTM/DSM display ranges.

## R2 upload

R2 is the canonical source for new survey binaries.

1. Load `.env.r2.local` into the upload process without printing it.
2. Upload the staged `assets/` tree under the exact key prefix `<slug>/assets/`.
3. Preserve paths and filename case exactly.
4. Upload EPT metadata only after all referenced hierarchy and LAZ objects are present, or validate everything before publishing the HTML entry.
5. Delete the temporary staging directory after validation; do not copy it into the repository.
6. Do not commit `.env.r2.local` or credentials.

Use the repository's established authenticated R2/AWS-compatible upload method. If the environment variable contract or bucket name is unavailable, stop and ask the maintainer instead of guessing or exposing the environment file.

Upload per file class so each gets its content type (all immutable, one year):

```sh
# source .env.r2.local first (never print it); <R2> = configured endpoint, <B> = bucket
aws s3 sync <staging>/map <B>/<slug>/assets/map --endpoint-url <R2> \
  --content-type image/png --cache-control 'public, max-age=31536000, immutable' --only-show-errors --exclude '*.json'
aws s3 cp <staging>/map/elevation.json <B>/<slug>/assets/map/elevation.json \
  --endpoint-url <R2> --content-type application/json --cache-control 'public, max-age=31536000, immutable' --only-show-errors
aws s3 sync <staging> <B>/<slug>/assets --endpoint-url <R2> \
  --exclude '*' --include '*.laz' --content-type application/octet-stream \
  --cache-control 'public, max-age=31536000, immutable' --only-show-errors
aws s3 cp <staging>/textured_model.glb <B>/<slug>/assets/textured_model.glb \
  --endpoint-url <R2> --content-type model/gltf-binary --cache-control 'public, max-age=31536000, immutable' --only-show-errors
# ept.json / ept-build.json / ept-hierarchy as application/json, shots.geojson as application/geo+json, same flags
```

Verify at least these URLs before updating the site:

```text
https://map-assets-proxy.akyoltarik.workers.dev/<slug>/assets/entwine_pointcloud/ept.json
https://map-assets-proxy.akyoltarik.workers.dev/<slug>/assets/shots.geojson
https://map-assets-proxy.akyoltarik.workers.dev/<slug>/assets/map/elevation.json
```

Also sample one EPT LAZ object and one orthophoto tile referenced by the uploaded data. A metadata response alone does not prove the complete hierarchy was uploaded.

## Add the location entry

Copy the newest working location HTML as the template. Keep the shared script and stylesheet references unchanged. Update:

- document title;
- visible location name and survey date;
- `SURVEY_CONFIG`;
- selector entry in the root `index.html`.

Example configuration:

```js
window.SURVEY_CONFIG = {
  slug: 'example',
  sharedBase: '..',
  assetBase: 'https://map-assets-proxy.akyoltarik.workers.dev/example',
  extent4326: [west, south, east, north],
  elevationRanges: {
    dtm: { min: 0, max: 0 },
    dsm: { min: 0, max: 0 }
  },
  areaSquareMeters: 0,
  hasTexturedModel: true,
  waterPlanStorageKey: 'example-water-plan-v1'
};
```

Rules:

- `assetBase` must use the R2 proxy and end at the location slug, not `/assets`.
- `extent4326` order is west, south, east, north; it is required — the viewer throws without it.
- `elevationRanges` is required for both dtm and dsm — the viewer throws without it.
- UTM zone is derived from the extent midpoint; override only via `utmDefinition` in `SURVEY_CONFIG`.
- Use measured DTM/DSM ranges, not copied values from another survey.
- Give every location a unique `waterPlanStorageKey` so saved irrigation plans do not collide.
- Set `hasTexturedModel: false` when no verified GLB is available.
- Do not duplicate or edit shared viewer code merely to add one location.

## Local verification

Serve the repository root over HTTP; do not open the files directly with `file://`.

Test both:

```text
http://localhost:<port>/<slug>/
http://localhost:<port>/<slug>/?view=2d
```

### 3D checklist

- The point cloud appears without requiring a click or drag.
- It progressively refines as it loads and after navigation.
- Orbit, zoom, pan, full extent, projection, measurements, and clipping work.
- Lighting and shadows do not change merely because the mouse button is held.
- The optional textured model and camera layer load when enabled.
- There are no console errors or failed EPT hierarchy/LAZ requests.

Compare navigation and visual behavior directly with the same WebODM task. Keep Potree's native rendering behavior. Do not reintroduce fixed-time point-cloud freezing, per-interaction EDL switching, or an artificial frame cap; those previously caused blank, sparse, and brightness-changing 3D views.

### 2D checklist

- Orthophoto aligns with satellite context.
- Plant health appears only when its tiles exist.
- DTM and DSM load at full survey resolution.
- Elevation range, histogram, palettes, shading, and opacity work.
- Contours and camera positions align with the imagery.
- Measurement, GPS location, fullscreen, and share controls work.
- Water planning uses the location's DTM and retains a unique saved-plan key.
- Mobile tools open and close without obscuring the entire map.

Test at desktop and phone-sized viewports.

## Updating an existing location

1. Stage the replacement assets under a **new versioned prefix**: `<slug>/assets-v2/`, `<slug>/assets-v3/`, … Never overwrite an existing version in place.
2. Verify the complete EPT, imagery, terrain products, and metadata under the new prefix.
3. Point the location HTML's `assetBase` at the new versioned prefix and remove the old R2 prefix only afterwards.
4. Update the location HTML only when bounds, ranges, area, date, or model availability changed.
5. Retest both 2D and 3D; browser caches can retain old metadata, so use a cache-busting query during verification.

Versioned prefixes are mandatory because R2 assets are served `immutable` for a year: returning visitors hold old EPT chunks and tiles under the exact same keys, and replacing a survey in place makes their browsers mix old cached point chunks with the new hierarchy — rendering ghost or doubled point clouds that only a hard refresh clears. A fresh prefix makes every replacement safe for every visitor.

Do not change shared code while updating survey data unless the same defect is reproduced across locations. Shared changes must be regression-tested on at least one existing location and the new/updated location.

## Git and publication

R2 assets must be working before GitHub Pages points to them.

1. Run `git status --short` again.
2. Review the diff and stage only files belonging to this location/update.
3. Never stage `.env.r2.local`, credentials, caches, raw WebODM exports, or unrelated user changes.
4. Check for files near or above GitHub's 100 MB limit. Heavy survey assets belong in R2.
5. Commit and push `main` only when the user asks to publish/push.
6. Verify `https://agonyam.github.io/<slug>/` after Pages deploys.

If publication fails, check in this order:

1. the location's `assetBase`;
2. proxy/R2 availability and CORS;
3. missing EPT hierarchy or LAZ objects;
4. missing map tiles or elevation products;
5. browser console errors;
6. GitHub Pages deployment status and caching.

## Definition of done

A location is complete only when the selector links to it, its R2 asset tree is reachable, 2D and 3D pass the checklists, behavior has been compared with WebODM, the public URL has been verified, and no credentials or unrelated files are included in the commit.
