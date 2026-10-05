# Agonyam WebODM Survey Viewers

Static GitHub Pages reconstructions of the WebODM 2D and 3D viewers. They require no WebODM login or application backend.

The 3D view uses the original WebODM Potree interface, the complete 39.9-million-point EPT cloud, the Hires textured model, camera positions, measurements, clipping, navigation, projection, filters, and scene controls.

The 2D view includes orthophoto, VARI plant health, DTM, DSM, hillshade, live-generated contours at any 0.1–10 m interval, camera positions, opacity, distance/area measurement, annotations, temporary GeoJSON overlays, satellite context, GPS, fullscreen, and sharing.

Visitors can optionally use **Location** to place their phone GPS position on the georeferenced survey. Location data stays in the browser and is not uploaded or stored.

## GitHub Pages

Publish from the `main` branch and repository root. The public survey selector is:

https://agonyam.github.io/map/

The Lokman viewer is available at:

https://agonyam.github.io/map/lokman/

## Maintenance

Agents adding or updating WebODM locations should follow [WEBODM_LOCATION_WORKFLOW.md](./WEBODM_LOCATION_WORKFLOW.md). It documents the R2 asset workflow, location configuration, testing, and GitHub Pages publication safeguards.
