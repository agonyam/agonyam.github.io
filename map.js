(function () {
  'use strict';

  const surveyConfig = window.SURVEY_CONFIG || {};
  const surveySlug = surveyConfig.slug || 'akcakoyun';
  const sharedBase = surveyConfig.sharedBase || '.';
  const assetBase = (surveyConfig.assetBase || '.').replace(/\/$/, '');
  const assetUrl = function (path) {
    return assetBase + '/' + path.replace(/^\.\//, '');
  };
  if (!Array.isArray(surveyConfig.extent4326) || surveyConfig.extent4326.length !== 4) {
    throw new Error('SURVEY_CONFIG.extent4326 must be set to [west, south, east, north] by ' + document.title);
  }
  const surveyExtent4326 = surveyConfig.extent4326;
  const surveyExtent = ol.proj.transformExtent(surveyExtent4326, 'EPSG:4326', 'EPSG:3857');
  const utmDefinition = surveyConfig.utmDefinition || function () {
    const centerLon = (surveyExtent4326[0] + surveyExtent4326[2]) / 2;
    const centerLat = (surveyExtent4326[1] + surveyExtent4326[3]) / 2;
    const zone = Math.max(1, Math.min(60, Math.floor((centerLon + 180) / 6) + 1));
    return '+proj=utm +zone=' + zone + (centerLat < 0 ? ' +south' : '') + ' +datum=WGS84 +units=m +no_defs';
  }();
  const mapViewElement = document.getElementById('map-view');
  const coordinateReadout = document.getElementById('map-coordinates');
  const mapToolsToggle = document.getElementById('map-tools-toggle');
  const mapTools = document.getElementById('map-tools');

  function setMapToolsOpen(open) {
    if (!mapTools || !mapToolsToggle) return;
    mapTools.classList.toggle('mobile-open', open);
    mapToolsToggle.classList.toggle('active', open);
    mapToolsToggle.setAttribute('aria-expanded', String(open));
    mapToolsToggle.textContent = open ? '× Close' : '☰ Tools';
  }

  if (mapToolsToggle) mapToolsToggle.addEventListener('click', function () {
    setMapToolsOpen(!mapTools.classList.contains('mobile-open'));
  });

  function mapFitPadding() {
    if (window.innerWidth > 600) return [55, 335, 55, 55];
    return mapTools && mapTools.classList.contains('mobile-open') ? [92, 330, 72, 18] : [92, 18, 72, 18];
  }

  function xyz(name, visible, opacity) {
    return new ol.layer.Tile({
      visible: visible,
      opacity: opacity,
      extent: surveyExtent,
      source: new ol.source.XYZ({
        url: assetUrl('assets/map/' + name + '/{z}/{x}/{y}.png'),
        minZoom: 15,
        maxZoom: 22,
        wrapX: false
      })
    });
  }

  const elevationCanvas = document.createElement('canvas');
  const waterSurfaceCanvas = document.createElement('canvas');
  let elevationMetadata = null;
  let elevationPixels = null;
  let hydrologyPixels = null;
  let hydrologyMetadata = null;
  let hydrologyLoadPromise = null;
  let hillshadePixels = null;
  let elevationActive = null;
  let elevationLoadToken = 0;
  let elevationRenderTimer = null;
  let hydrologyGrid = null;
  let waterSimulationState = null;
  let waterAnimationFrame = null;
  let waterPreviousTerrainOpacity = null;
  let waterBackgroundLayer = null;
  let waterTerrainOpacity = .58;
  if (!surveyConfig.elevationRanges || !surveyConfig.elevationRanges.dtm || !surveyConfig.elevationRanges.dsm) {
    throw new Error('SURVEY_CONFIG.elevationRanges must define measured dtm and dsm ranges in ' + document.title);
  }
  const elevationRanges = surveyConfig.elevationRanges;
  const elevationStyle = { color: 'viridis', shading: 'normal' };
  const elevationControls = document.getElementById('elevation-controls');
  const elevationStatus = document.getElementById('elevation-status');
  const histogramCanvas = document.getElementById('elevation-histogram');

  const elevationSource = new ol.source.ImageCanvas({
    projection: 'EPSG:3857',
    ratio: 1,
    canvasFunction: function (extent, resolution, pixelRatio, size) {
      const canvas = document.createElement('canvas');
      canvas.width = size[0];
      canvas.height = size[1];
      if (!elevationCanvas.width) return canvas;
      const context = canvas.getContext('2d');
      context.imageSmoothingEnabled = true;
      const x = (surveyExtent[0] - extent[0]) / resolution * pixelRatio;
      const y = (extent[3] - surveyExtent[3]) / resolution * pixelRatio;
      const width = (surveyExtent[2] - surveyExtent[0]) / resolution * pixelRatio;
      const height = (surveyExtent[3] - surveyExtent[1]) / resolution * pixelRatio;
      context.drawImage(elevationCanvas, x, y, width, height);
      return canvas;
    }
  });
  const elevationLayer = new ol.layer.Image({ visible: false, opacity: 1, extent: surveyExtent, source: elevationSource });
  const waterSurfaceSource = new ol.source.ImageCanvas({
    projection: 'EPSG:3857',
    ratio: 1,
    canvasFunction: function (extent, resolution, pixelRatio, size) {
      const canvas = document.createElement('canvas');
      canvas.width = size[0]; canvas.height = size[1];
      if (!waterSurfaceCanvas.width) return canvas;
      const context = canvas.getContext('2d');
      context.imageSmoothingEnabled = true;
      const x = (surveyExtent[0] - extent[0]) / resolution * pixelRatio;
      const y = (extent[3] - surveyExtent[3]) / resolution * pixelRatio;
      const width = (surveyExtent[2] - surveyExtent[0]) / resolution * pixelRatio;
      const height = (surveyExtent[3] - surveyExtent[1]) / resolution * pixelRatio;
      context.drawImage(waterSurfaceCanvas, x, y, width, height);
      return canvas;
    }
  });
  const waterSurfaceLayer = new ol.layer.Image({ visible: false, opacity: 1, extent: surveyExtent, source: waterSurfaceSource });

  const layers = {
    satellite: new ol.layer.Tile({
      visible: true,
      source: new ol.source.XYZ({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attributions: [new ol.Attribution({ html: 'Tiles © Esri' })],
        crossOrigin: 'anonymous',
        maxZoom: 18
      })
    }),
    osm: new ol.layer.Tile({ visible: false, source: new ol.source.OSM() }),
    orthophoto: xyz('orthophoto', true, 1),
    'plant-health': xyz('plant-health', false, 0.85),
    dtm: elevationLayer,
    dsm: elevationLayer
  };

  const sketchSource = new ol.source.Vector();
  const locationSource = new ol.source.Vector();
  const camerasSource = new ol.source.Vector();
  const contoursSource = new ol.source.Vector();
  const importedSource = new ol.source.Vector();
  const waterEntrySource = new ol.source.Vector();
  const waterPipeSource = new ol.source.Vector();
  const waterZoneSource = new ol.source.Vector();
  const waterResultSource = new ol.source.Vector();
  const waterEntryOverlays = [];
  const sketchLayer = new ol.layer.Vector({
    source: sketchSource,
    style: new ol.style.Style({
      fill: new ol.style.Fill({ color: 'rgba(65, 191, 231, .22)' }),
      stroke: new ol.style.Stroke({ color: '#20b9e8', width: 3 }),
      image: new ol.style.Circle({ radius: 5, fill: new ol.style.Fill({ color: '#20b9e8' }), stroke: new ol.style.Stroke({ color: '#fff', width: 1 }) })
    })
  });
  const locationLayer = new ol.layer.Vector({
    source: locationSource,
    style: new ol.style.Style({
      image: new ol.style.Circle({ radius: 8, fill: new ol.style.Fill({ color: '#168fff' }), stroke: new ol.style.Stroke({ color: '#fff', width: 3 }) })
    })
  });
  layers.cameras = new ol.layer.Vector({
    visible: false,
    source: camerasSource,
    style: new ol.style.Style({ image: new ol.style.Circle({ radius: 3, fill: new ol.style.Fill({ color: '#ffd331' }), stroke: new ol.style.Stroke({ color: '#1b2528', width: 1 }) }) })
  });
  let contourInterval = 1;
  function isIndexLevel(elevation, interval) {
    const step = interval * 5;
    if (!(step > 0)) return false;
    return Math.abs(elevation / step - Math.round(elevation / step)) < 1e-6;
  }
  layers.contours = new ol.layer.Vector({
    visible: false,
    source: contoursSource,
    style: function (feature) {
      const major = isIndexLevel(Number(feature.get('elevation')), contourInterval);
      return [new ol.style.Style({
        stroke: new ol.style.Stroke({ color: major ? '#a93226' : '#e09a1f', width: major ? 2 : 1 })
      })];
    }
  });
  const contourLabelSource = new ol.source.Vector();
  layers.contourLabels = new ol.layer.Vector({
    visible: false,
    source: contourLabelSource,
    style: function (feature) {
      return [new ol.style.Style({
        text: new ol.style.Text({ text: String(feature.get('elevation')), font: '11px Arial', fill: new ol.style.Fill({ color: '#3a2a1a' }), stroke: new ol.style.Stroke({ color: 'rgba(255, 255, 255, .85)', width: 2 }) })
      })];
    }
  });
  const importedLayer = new ol.layer.Vector({
    source: importedSource,
    style: new ol.style.Style({ fill: new ol.style.Fill({ color: 'rgba(255, 100, 25, .2)' }), stroke: new ol.style.Stroke({ color: '#ff6419', width: 3 }), image: new ol.style.Circle({ radius: 5, fill: new ol.style.Fill({ color: '#ff6419' }) }) })
  });
  const waterResultLayer = new ol.layer.Vector({
    source: waterResultSource,
    style: function (feature) {
      const type = feature.get('waterType');
      if (type === 'emitter-low') return new ol.style.Style({
        zIndex: 100,
        image: new ol.style.Circle({ radius: 6, fill: new ol.style.Fill({ color: '#ff3b30' }), stroke: new ol.style.Stroke({ color: '#fff', width: 2 }) }),
        text: new ol.style.Text({ text: '!', font: 'bold 9px Arial', fill: new ol.style.Fill({ color: '#fff' }) })
      });
      if (type === 'emitter-underflow') return new ol.style.Style({
        zIndex: 99,
        image: new ol.style.Circle({ radius: 3.5, fill: new ol.style.Fill({ color: '#ff9f0a' }), stroke: new ol.style.Stroke({ color: '#4a2a00', width: 1 }) })
      });
      if (type === 'emitter') return new ol.style.Style({ image: new ol.style.Circle({ radius: 4, fill: new ol.style.Fill({ color: '#52ffd2' }), stroke: new ol.style.Stroke({ color: '#fff', width: 1.5 }) }) });
      if (type === 'wetting') return new ol.style.Style({ fill: new ol.style.Fill({ color: 'rgba(0, 111, 255, .3)' }), stroke: new ol.style.Stroke({ color: '#dff8ff', width: 3 }) });
      if (type === 'pool') return new ol.style.Style({
        image: new ol.style.Circle({ radius: 11, fill: new ol.style.Fill({ color: '#075be8' }), stroke: new ol.style.Stroke({ color: '#fff', width: 3 }) }),
        text: new ol.style.Text({ text: 'POOL', offsetY: -20, font: 'bold 10px Arial', fill: new ol.style.Fill({ color: '#fff' }), stroke: new ol.style.Stroke({ color: '#092e5f', width: 3 }) })
      });
      return [
        new ol.style.Style({ stroke: new ol.style.Stroke({ color: 'rgba(255, 255, 255, .95)', width: 8 }) }),
        new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#087be8', width: 5 }) })
      ];
    }
  });
  waterResultLayer.setZIndex(900);
  const waterPipeLayer = new ol.layer.Vector({
    source: waterPipeSource,
    style: function (feature) {
      const coordinates = feature.getGeometry().getCoordinates();
      const role = feature.get('pipeRole') || 'delivery';
      const color = role === 'mainline' ? '#143d8f' : role === 'submain' ? '#1788b8' : role === 'dripline' ? '#18a97f' : '#173d79';
      const styles = [new ol.style.Style({ stroke: new ol.style.Stroke({ color: color, width: role === 'mainline' ? 8 : role === 'submain' ? 6 : 4, lineDash: role === 'dripline' ? [5, 4] : undefined }), image: new ol.style.Circle({ radius: 4, fill: new ol.style.Fill({ color: '#77c9f2' }), stroke: new ol.style.Stroke({ color: color, width: 2 }) }) })];
      if (coordinates.length > 1 && role === 'delivery') {
        const previous = coordinates[coordinates.length - 2]; const end = coordinates[coordinates.length - 1];
        const angle = Math.atan2(end[1] - previous[1], end[0] - previous[0]);
        styles.push(new ol.style.Style({
          geometry: new ol.geom.Point(end),
          image: new ol.style.RegularShape({ points: 3, radius: 10, rotation: Math.PI / 2 - angle, fill: new ol.style.Fill({ color: '#77c9f2' }), stroke: new ol.style.Stroke({ color: '#102d52', width: 2 }) })
        }));
      }
      return styles;
    }
  });
  const waterZoneLayer = new ol.layer.Vector({
    source: waterZoneSource,
    style: new ol.style.Style({ fill: new ol.style.Fill({ color: 'rgba(38, 191, 122, .13)' }), stroke: new ol.style.Stroke({ color: '#28bf7b', width: 3 }) })
  });
  const waterEntryLayer = new ol.layer.Vector({
    source: waterEntrySource,
    style: function (feature) {
      return new ol.style.Style({
        zIndex: 1000,
        image: new ol.style.Circle({ radius: 13, fill: new ol.style.Fill({ color: '#ffdc52' }), stroke: new ol.style.Stroke({ color: '#102d52', width: 5 }) }),
        text: new ol.style.Text({ text: 'ENTRY ' + String(feature.get('entryNumber') || ''), offsetY: -25, font: 'bold 12px Arial', fill: new ol.style.Fill({ color: '#fff' }), stroke: new ol.style.Stroke({ color: '#102d52', width: 5 }) })
      });
    }
  });
  waterEntryLayer.setZIndex(1000);

  const map = new ol.Map({
    target: 'map',
    layers: [layers.satellite, layers.osm, layers.orthophoto, layers['plant-health'], elevationLayer, layers.contours, layers.contourLabels, layers.cameras, importedLayer, sketchLayer, waterZoneLayer, waterPipeLayer, waterSurfaceLayer, waterResultLayer, waterEntryLayer, locationLayer],
    controls: ol.control.defaults().extend([new ol.control.ScaleLine()]),
    view: new ol.View({ center: ol.extent.getCenter(surveyExtent), zoom: 19, minZoom: 14, maxZoom: 23 })
  });
  map.getView().fit(surveyExtent, map.getSize(), { padding: mapFitPadding(), maxZoom: 21 });

  fetch(assetUrl('assets/shots.geojson')).then(function (response) {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }).then(function (geojson) {
    camerasSource.addFeatures(new ol.format.GeoJSON().readFeatures(geojson, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }));
  }).catch(function (error) { console.error('Camera positions could not be loaded.', error); });

  let contourGrid = null;
  const contourCache = {};
  const contourCacheOrder = [];
  let contourRequestToken = 0;
  let contourWorker = null;

  function contourStatus(message) {
    const status = document.getElementById('contour-status');
    if (status) status.textContent = message;
  }

  function buildContourGrid() {
    const src = hydrologyPixels.pixels;
    const sourceWidth = hydrologyPixels.width;
    const sourceHeight = hydrologyPixels.height;
    const meta = hydrologyMetadata;
    const step = Math.max(1, Math.floor(Math.max(sourceWidth, sourceHeight) / 1000));
    const width = Math.ceil(sourceWidth / step);
    const height = Math.ceil(sourceHeight / step);
    const elev = new Float32Array(width * height);
    const valid = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      const sourceY = Math.min(sourceHeight - 1, y * step);
      for (let x = 0; x < width; x += 1) {
        const sourceX = Math.min(sourceWidth - 1, x * step);
        const pixel = (sourceY * sourceWidth + sourceX) * 4;
        const output = y * width + x;
        if (!src[pixel + 3]) { elev[output] = NaN; continue; }
        valid[output] = 1;
        elev[output] = meta.offset + (src[pixel] * 256 + src[pixel + 1]) * meta.scale;
      }
    }
    return { width: width, height: height, elev: elev, valid: valid };
  }

  function showContourLevels(levels, interval) {
    contoursSource.clear();
    contourLabelSource.clear();
    const lineFeatures = [];
    const labelFeatures = [];
    const hasIndex = levels.some(function (level) { return isIndexLevel(level.e, interval); });
    levels.forEach(function (level, levelPosition) {
      const flat = new Float32Array(level.coords);
      const lines = [];
      let totalLength = 0;
      for (let s = 0; s < flat.length; s += 4) {
        const dx = flat[s + 2] - flat[s];
        const dy = flat[s + 3] - flat[s + 1];
        totalLength += Math.sqrt(dx * dx + dy * dy);
        lines.push([[flat[s], flat[s + 1]], [flat[s + 2], flat[s + 3]]]);
      }
      const lineFeature = new ol.Feature(new ol.geom.MultiLineString(lines));
      lineFeature.set('elevation', level.e);
      lineFeatures.push(lineFeature);
      const labeled = hasIndex ? isIndexLevel(level.e, interval) : levelPosition % 3 === 0;
      if (labeled && totalLength > 0) {
        const step = Math.max(40, totalLength / 8);
        let travelled = step / 2;
        let acc = 0;
        for (let s = 0; s < flat.length && labelFeatures.length < 500; s += 4) {
          const dx = flat[s + 2] - flat[s];
          const dy = flat[s + 3] - flat[s + 1];
          acc += Math.sqrt(dx * dx + dy * dy);
          if (acc >= travelled) {
            const label = new ol.Feature(new ol.geom.Point([(flat[s] + flat[s + 2]) / 2, (flat[s + 1] + flat[s + 3]) / 2]));
            label.set('elevation', level.e);
            labelFeatures.push(label);
            travelled += step;
          }
        }
      }
    });
    contoursSource.addFeatures(lineFeatures);
    contourLabelSource.addFeatures(labelFeatures);
    return { lines: lineFeatures, labels: labelFeatures };
  }

  function showCachedContours(key, interval) {
    contoursSource.clear();
    contourLabelSource.clear();
    contoursSource.addFeatures(contourCache[key].lines);
    contourLabelSource.addFeatures(contourCache[key].labels);
    contourStatus(contourCache[key].lines.length + ' levels · ' + interval + ' m interval');
  }

  function requestContours() {
    if (!layers.contours.getVisible()) return;
    const interval = contourInterval;
    const key = String(interval);
    if (contourCache[key]) {
      showCachedContours(key, interval);
      return;
    }
    const token = ++contourRequestToken;
    contourStatus('Generating ' + interval + ' m contours…');
    ensureDtm().then(function (ready) {
      if (token !== contourRequestToken) return;
      if (!ready) throw new Error('Terrain data could not be loaded.');
      if (!contourGrid) contourGrid = buildContourGrid();
      if (contourWorker) contourWorker.terminate();
      contourWorker = new Worker(sharedBase + '/contour-worker.js?v=20261005-live2');
      contourWorker.onmessage = function (event) {
        if (token !== contourRequestToken) return;
        contourWorker.terminate();
        contourWorker = null;
        if (event.data.error || !event.data.levels) {
          contourStatus('Contour generation failed.');
          console.error('Contours could not be generated.', event.data.error);
          return;
        }
        const features = showContourLevels(event.data.levels, interval);
        contourCache[key] = features;
        contourCacheOrder.push(key);
        while (contourCacheOrder.length > 3) delete contourCache[contourCacheOrder.shift()];
        contourStatus(features.lines.length + ' levels · ' + interval + ' m interval');
      };
      contourWorker.onerror = function () {
        if (token !== contourRequestToken) return;
        contourWorker = null;
        contourStatus('Contour generation failed.');
      };
      const payload = {
        elev: contourGrid.elev.slice().buffer,
        valid: contourGrid.valid.slice().buffer,
        width: contourGrid.width,
        height: contourGrid.height,
        extent: surveyExtent,
        interval: interval
      };
      contourWorker.postMessage(payload, [payload.elev, payload.valid]);
    }).catch(function (error) {
      if (token !== contourRequestToken) return;
      contourStatus('Contours unavailable: ' + error.message);
      console.error('Contours could not be generated.', error);
    });
  }

  const palettes = {
    viridis: [[0, 68, 1, 84], [.25, 59, 82, 139], [.5, 33, 145, 140], [.75, 94, 201, 98], [1, 253, 231, 37]],
    jet: [[0, 0, 0, 128], [.2, 0, 80, 255], [.4, 0, 220, 220], [.6, 220, 255, 30], [.8, 255, 100, 0], [1, 128, 0, 0]],
    terrain: [[0, 52, 107, 130], [.25, 78, 153, 115], [.5, 176, 176, 106], [.75, 166, 126, 86], [1, 255, 255, 255]],
    earth: [[0, 35, 72, 60], [.3, 90, 128, 78], [.58, 163, 146, 91], [.8, 129, 95, 68], [1, 238, 228, 198]],
    pastel: [[0, 122, 171, 216], [.25, 165, 218, 202], [.5, 255, 238, 157], [.75, 244, 174, 126], [1, 207, 121, 161]]
  };

  function colorLut(name) {
    const stops = palettes[name] || palettes.viridis;
    const lut = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i += 1) {
      const t = i / 255;
      let right = 1;
      while (right < stops.length - 1 && t > stops[right][0]) right += 1;
      const left = stops[right - 1];
      const next = stops[right];
      const mix = (t - left[0]) / (next[0] - left[0]);
      for (let channel = 0; channel < 3; channel += 1) lut[i * 3 + channel] = Math.round(left[channel + 1] + (next[channel + 1] - left[channel + 1]) * mix);
    }
    return lut;
  }

  function rgbToHs(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    if (!delta) return [0, 0];
    let hue;
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    return [((hue / 6) + 1) % 1, delta / max];
  }

  function shadedLut(lut) {
    const table = new Uint8Array(256 * 256 * 3);
    for (let color = 0; color < 256; color += 1) {
      const hs = rgbToHs(lut[color * 3], lut[color * 3 + 1], lut[color * 3 + 2]);
      const h6 = hs[0] * 6;
      const sector = Math.floor(h6) % 6;
      const f = h6 - Math.floor(h6);
      for (let value = 0; value < 256; value += 1) {
        const p = value * (1 - hs[1]);
        const q = value * (1 - hs[1] * f);
        const t = value * (1 - hs[1] * (1 - f));
        const rgb = sector === 0 ? [value, t, p] : sector === 1 ? [q, value, p] : sector === 2 ? [p, value, t] : sector === 3 ? [p, q, value] : sector === 4 ? [t, p, value] : [value, p, q];
        const index = (color * 256 + value) * 3;
        table[index] = rgb[0]; table[index + 1] = rgb[1]; table[index + 2] = rgb[2];
      }
    }
    return table;
  }

  function decodePixels(image) {
    return new Promise(function (resolve) {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        if (image.close) image.close();
        resolve({ width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data });
    });
  }

  function loadPixels(url, attempt) {
    attempt = attempt || 0;
    const separator = url.indexOf('?') === -1 ? '?' : '&';
    const requestUrl = attempt ? url + separator + 'retry=' + attempt : url;
    return fetch(requestUrl, { cache: attempt ? 'reload' : 'default' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.blob();
    }).then(function (blob) {
      if (window.createImageBitmap) return createImageBitmap(blob).then(decodePixels);
      return new Promise(function (resolve, reject) {
        const image = new Image();
        const objectUrl = URL.createObjectURL(blob);
        image.onload = function () { URL.revokeObjectURL(objectUrl); decodePixels(image).then(resolve); };
        image.onerror = function () { URL.revokeObjectURL(objectUrl); reject(new Error('Image decode failed')); };
        image.src = objectUrl;
      });
    }).catch(function (error) {
      if (attempt >= 2) throw error;
      elevationStatus.textContent = 'Connection interrupted; retrying elevation data…';
      return new Promise(function (resolve) { window.setTimeout(resolve, 800 * (attempt + 1)); }).then(function () { return loadPixels(url, attempt + 1); });
    });
  }

  function renderElevation() {
    if (!elevationPixels || !elevationActive || !elevationMetadata) return;
    window.clearTimeout(elevationRenderTimer);
    elevationStatus.textContent = 'Rendering full-resolution ' + elevationActive.toUpperCase() + '…';
    elevationRenderTimer = window.setTimeout(function () {
      const meta = elevationMetadata[elevationActive];
      const range = elevationRanges[elevationActive];
      const input = elevationPixels.pixels;
      const shade = hillshadePixels && elevationStyle.shading !== 'none' ? hillshadePixels.pixels : null;
      const lut = colorLut(elevationStyle.color);
      const shadeTable = shade ? shadedLut(lut) : null;
      elevationCanvas.width = elevationPixels.width;
      elevationCanvas.height = elevationPixels.height;
      const context = elevationCanvas.getContext('2d');
      const output = context.createImageData(elevationCanvas.width, elevationCanvas.height);
      const span = Math.max(.001, range.max - range.min);
      for (let p = 0; p < input.length; p += 4) {
        if (!input[p + 3]) continue;
        const value = meta.offset + (input[p] * 256 + input[p + 1]) * meta.scale;
        const color = Math.max(0, Math.min(255, Math.round((value - range.min) / span * 255)));
        let source = color * 3;
        if (shadeTable) source = (color * 256 + shade[p]) * 3;
        const table = shadeTable || lut;
        output.data[p] = table[source];
        output.data[p + 1] = table[source + 1];
        output.data[p + 2] = table[source + 2];
        output.data[p + 3] = 238;
      }
      context.putImageData(output, 0, 0);
      elevationSource.changed();
      elevationStatus.textContent = meta.width.toLocaleString() + ' × ' + meta.height.toLocaleString() + ' · full-resolution elevation';
    }, 30);
  }

  function updateRangeUi() {
    if (!elevationActive || !elevationMetadata) return;
    const meta = elevationMetadata[elevationActive];
    const range = elevationRanges[elevationActive];
    document.getElementById('elevation-min').value = range.min.toFixed(3);
    document.getElementById('elevation-max').value = range.max.toFixed(3);
    document.getElementById('elevation-global-min').textContent = Math.floor(meta.min) + ' m';
    document.getElementById('elevation-global-max').textContent = Math.ceil(meta.max) + ' m';
    drawHistogram();
  }

  function drawHistogram() {
    if (!elevationActive || !elevationMetadata) return;
    const meta = elevationMetadata[elevationActive];
    const range = elevationRanges[elevationActive];
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(220, histogramCanvas.clientWidth || 272);
    const height = 104;
    histogramCanvas.width = Math.round(width * ratio);
    histogramCanvas.height = Math.round(height * ratio);
    const context = histogramCanvas.getContext('2d');
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);
    const lut = colorLut(elevationStyle.color);
    const maxCount = Math.max.apply(null, meta.histogram);
    for (let i = 0; i < meta.histogram.length; i += 1) {
      const barHeight = Math.log1p(meta.histogram[i]) / Math.log1p(maxCount) * 83;
      context.fillStyle = 'rgb(' + lut[i * 3] + ',' + lut[i * 3 + 1] + ',' + lut[i * 3 + 2] + ')';
      context.fillRect(i / meta.histogram.length * width, 91 - barHeight, Math.ceil(width / meta.histogram.length) + 1, barHeight);
    }
    ['min', 'max'].forEach(function (key) {
      const x = (range[key] - meta.min) / (meta.max - meta.min) * width;
      context.fillStyle = '#87959b';
      context.fillRect(Math.max(0, Math.min(width - 4, x - 2)), 0, 4, 96);
    });
  }

  function loadElevation(name) {
    if (elevationActive === name && elevationPixels && elevationMetadata) {
      elevationLayer.setVisible(true);
      elevationControls.hidden = false;
      return Promise.resolve(true);
    }
    const token = ++elevationLoadToken;
    elevationActive = name;
    elevationLayer.setVisible(true);
    elevationControls.hidden = false;
    document.getElementById('elevation-title').textContent = name === 'dtm' ? 'Terrain Model' : 'Surface Model';
    elevationStatus.textContent = 'Loading full-resolution elevation…';
      return fetch(assetUrl('assets/map/elevation.json')).then(function (response) { return response.json(); }).then(function (metadata) {
      elevationMetadata = metadata;
      updateRangeUi();
      return loadPixels(assetUrl('assets/map/' + name + '-elevation.png'));
    }).then(function (pixels) {
      if (token !== elevationLoadToken) return;
      elevationPixels = pixels;
      if (name === 'dtm') {
        hydrologyPixels = pixels;
        hydrologyMetadata = elevationMetadata.dtm;
        hydrologyGrid = null;
      }
      hillshadePixels = null;
      renderElevation();
      if (elevationStyle.shading === 'none') return null;
      elevationStatus.textContent = 'Adding ' + elevationStyle.shading + ' relief…';
      return loadPixels(assetUrl('assets/map/' + name + '-hillshade-' + elevationStyle.shading + '.png')).then(function (shade) {
        if (token !== elevationLoadToken) return;
        hillshadePixels = shade;
        renderElevation();
        return true;
      }).catch(function () {
        if (token === elevationLoadToken) elevationStatus.textContent = 'Color elevation ready · relief unavailable';
        return true;
      });
    }).catch(function () {
      if (token === elevationLoadToken) elevationStatus.textContent = 'Elevation layer could not be loaded.';
      return false;
    });
  }

  function reloadHillshade() {
    if (!elevationActive || !elevationPixels) return;
    const token = ++elevationLoadToken;
    if (elevationStyle.shading === 'none') {
      hillshadePixels = null;
      renderElevation();
      return;
    }
    elevationStatus.textContent = 'Loading ' + elevationStyle.shading + ' relief…';
    loadPixels(assetUrl('assets/map/' + elevationActive + '-hillshade-' + elevationStyle.shading + '.png')).then(function (pixels) {
      if (token !== elevationLoadToken) return;
      hillshadePixels = pixels;
      renderElevation();
    });
  }

  let draw = null;
  let waterDraw = null;
  let waterSnap = null;
  let waterSnapFeatures = null;
  let waterTool = null;
  let waterPipeSequence = 1;
  const resultOverlays = [];

  function toUtm(coordinate) {
    return proj4('EPSG:4326', utmDefinition, ol.proj.transform(coordinate, 'EPSG:3857', 'EPSG:4326'));
  }

  function formatDistance(coordinates) {
    const distance = distanceMeters(coordinates);
    return distance >= 1000 ? (distance / 1000).toFixed(2) + ' km' : distance.toFixed(2) + ' m';
  }

  function distanceMeters(coordinates) {
    let distance = 0;
    for (let i = 1; i < coordinates.length; i += 1) {
      const a = toUtm(coordinates[i - 1]);
      const b = toUtm(coordinates[i]);
      distance += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return distance;
  }

  function distanceAlongCoordinates(coordinates, point) {
    const target = toUtm(point);
    let travelled = 0;
    let nearestDistance = Infinity;
    let nearestAlong = 0;
    for (let i = 1; i < coordinates.length; i += 1) {
      const start = toUtm(coordinates[i - 1]);
      const end = toUtm(coordinates[i]);
      const dx = end[0] - start[0]; const dy = end[1] - start[1];
      const lengthSquared = dx * dx + dy * dy;
      const length = Math.sqrt(lengthSquared);
      const progress = lengthSquared ? Math.max(0, Math.min(1, ((target[0] - start[0]) * dx + (target[1] - start[1]) * dy) / lengthSquared)) : 0;
      const projectedX = start[0] + dx * progress; const projectedY = start[1] + dy * progress;
      const gap = Math.hypot(target[0] - projectedX, target[1] - projectedY);
      if (gap < nearestDistance) { nearestDistance = gap; nearestAlong = travelled + length * progress; }
      travelled += length;
    }
    return nearestAlong;
  }

  function formatArea(coordinates) {
    const area = areaSquareMeters(coordinates);
    return area >= 10000 ? (area / 10000).toFixed(3) + ' ha' : area.toFixed(2) + ' m²';
  }

  function areaSquareMeters(coordinates) {
    const ring = coordinates[0].map(toUtm);
    let area = 0;
    for (let i = 0; i < ring.length - 1; i += 1) area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    return Math.abs(area / 2);
  }

  function addLabel(position, text, className) {
    const element = document.createElement('div');
    element.className = className || 'map-measure-label';
    element.textContent = text;
    const overlay = new ol.Overlay({ element: element, position: position, positioning: 'bottom-center', offset: [0, -9], stopEvent: false });
    map.addOverlay(overlay);
    resultOverlays.push(overlay);
  }

  function stopDrawing() {
    if (draw) map.removeInteraction(draw);
    draw = null;
    document.querySelectorAll('[data-map-tool]').forEach(function (button) { button.classList.remove('active'); });
  }

  function startDrawing(tool, button) {
    stopWaterTools();
    stopDrawing();
    if (tool === 'clear') {
      sketchSource.clear();
      resultOverlays.splice(0).forEach(function (overlay) { map.removeOverlay(overlay); });
      return;
    }
    const type = tool === 'distance' ? 'LineString' : tool === 'area' ? 'Polygon' : 'Point';
    button.classList.add('active');
    draw = new ol.interaction.Draw({ source: sketchSource, type: type });
    map.addInteraction(draw);
    draw.on('drawend', function (event) {
      const geometry = event.feature.getGeometry();
      if (tool === 'distance') addLabel(geometry.getLastCoordinate(), formatDistance(geometry.getCoordinates()));
      if (tool === 'area') addLabel(geometry.getInteriorPoint().getCoordinates(), formatArea(geometry.getCoordinates()));
      if (tool === 'marker') {
        const label = window.prompt('Annotation label', 'Point of interest');
        if (label) addLabel(geometry.getCoordinates(), label, 'map-marker-label');
      }
    });
  }

  const surveyAreaSquareMeters = surveyConfig.areaSquareMeters || 9262;
  const greenAmptSoils = {
    sandy: { conductivity: 30, suction: 60, moistureDeficit: .20, manning: .035 },
    loam: { conductivity: 12, suction: 110, moistureDeficit: .25, manning: .05 },
    clay: { conductivity: 2, suction: 220, moistureDeficit: .30, manning: .06 },
    saturated: { conductivity: .5, suction: 20, moistureDeficit: .02, manning: .055 }
  };

  function numberValue(id, fallback) {
    const value = Number(document.getElementById(id).value);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  function flowLitersMinuteValue() {
    const value = numberValue('water-flow', 8);
    return document.getElementById('water-flow-unit').value === 'hour' ? value / 60 : value;
  }

  function totalIrrigationFlow(entryCount) {
    const flow = flowLitersMinuteValue();
    return document.getElementById('water-flow-basis').value === 'total' ? flow : flow * entryCount;
  }

  function stopWaterTools() {
    waterTool = null;
    if (waterDraw) map.removeInteraction(waterDraw);
    if (waterSnap) map.removeInteraction(waterSnap);
    waterDraw = null;
    waterSnap = null;
    waterSnapFeatures = null;
    ['water-place', 'water-pipe', 'water-erase', 'water-zone'].forEach(function (id) { document.getElementById(id).classList.remove('active'); });
    map.getTargetElement().style.cursor = '';
  }

  function addWaterEntryOverlay(feature) {
    const element = document.createElement('div');
    element.className = 'water-entry-map-marker';
    element.textContent = 'ENTRY ' + feature.get('entryNumber');
    const overlay = new ol.Overlay({ element: element, position: feature.getGeometry().getCoordinates(), positioning: 'bottom-center', offset: [0, -10], stopEvent: false });
    map.addOverlay(overlay);
    waterEntryOverlays.push(overlay);
  }

  function clearWaterEntryOverlays() {
    waterEntryOverlays.splice(0).forEach(function (overlay) { map.removeOverlay(overlay); });
  }

  function ensureDtm() {
    if (hydrologyPixels && hydrologyMetadata) return Promise.resolve(true);
    if (hydrologyLoadPromise) return hydrologyLoadPromise;
    hydrologyLoadPromise = Promise.all([
      elevationMetadata ? Promise.resolve(elevationMetadata) : fetch(assetUrl('assets/map/elevation.json')).then(function (response) { return response.json(); }),
      loadPixels(assetUrl('assets/map/dtm-elevation.png'))
    ]).then(function (result) {
      elevationMetadata = elevationMetadata || result[0];
      hydrologyMetadata = result[0].dtm;
      hydrologyPixels = result[1];
      hydrologyGrid = null;
      return true;
    }).catch(function () { return false; }).then(function (ready) {
      hydrologyLoadPromise = null;
      return ready;
    });
    return hydrologyLoadPromise;
  }

  function coordinateToElevationPixel(coordinate) {
    if (!hydrologyPixels) return null;
    const x = Math.round((coordinate[0] - surveyExtent[0]) / (surveyExtent[2] - surveyExtent[0]) * (hydrologyPixels.width - 1));
    const y = Math.round((surveyExtent[3] - coordinate[1]) / (surveyExtent[3] - surveyExtent[1]) * (hydrologyPixels.height - 1));
    if (x < 0 || y < 0 || x >= hydrologyPixels.width || y >= hydrologyPixels.height) return null;
    return [x, y];
  }

  function elevationAtPixel(x, y) {
    x = Math.round(x); y = Math.round(y);
    if (!hydrologyPixels || !hydrologyMetadata || x < 0 || y < 0 || x >= hydrologyPixels.width || y >= hydrologyPixels.height) return null;
    const index = (y * hydrologyPixels.width + x) * 4;
    if (!hydrologyPixels.pixels[index + 3]) return null;
    return hydrologyMetadata.offset + (hydrologyPixels.pixels[index] * 256 + hydrologyPixels.pixels[index + 1]) * hydrologyMetadata.scale;
  }

  function elevationAtCoordinate(coordinate) {
    const pixel = coordinateToElevationPixel(coordinate);
    return pixel ? elevationAtPixel(pixel[0], pixel[1]) : null;
  }

  function MinHeap() { this.items = []; }
  MinHeap.prototype.push = function (index, value) {
    const item = { index: index, value: value };
    let position = this.items.length;
    this.items.push(item);
    while (position > 0) {
      const parent = Math.floor((position - 1) / 2);
      if (this.items[parent].value <= value) break;
      this.items[position] = this.items[parent];
      position = parent;
    }
    this.items[position] = item;
  };
  MinHeap.prototype.pop = function () {
    if (!this.items.length) return null;
    const root = this.items[0];
    const tail = this.items.pop();
    if (this.items.length) {
      let position = 0;
      while (true) {
        const left = position * 2 + 1;
        const right = left + 1;
        if (left >= this.items.length) break;
        let child = right < this.items.length && this.items[right].value < this.items[left].value ? right : left;
        if (this.items[child].value >= tail.value) break;
        this.items[position] = this.items[child];
        position = child;
      }
      this.items[position] = tail;
    }
    return root;
  };

  const hydrologyDirections = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

  function buildHydrologyGrid() {
    if (hydrologyGrid) return hydrologyGrid;
    const width = 240;
    const height = Math.max(180, Math.round(width * hydrologyPixels.height / hydrologyPixels.width));
    const size = width * height;
    const elevation = new Float32Array(size);
    const filled = new Float32Array(size);
    const valid = new Uint8Array(size);
    const visited = new Uint8Array(size);
    let validCellCount = 0;
    filled.fill(Infinity);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const sourceX = Math.round((x + .5) / width * (hydrologyPixels.width - 1));
        const sourceY = Math.round((y + .5) / height * (hydrologyPixels.height - 1));
        const value = elevationAtPixel(sourceX, sourceY);
        const index = y * width + x;
        if (value !== null) { valid[index] = 1; elevation[index] = value; validCellCount += 1; }
      }
    }
    const heap = new MinHeap();
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (!valid[index]) continue;
        let boundary = x === 0 || y === 0 || x === width - 1 || y === height - 1;
        if (!boundary) {
          for (let d = 0; d < hydrologyDirections.length; d += 1) {
            const nx = x + hydrologyDirections[d][0]; const ny = y + hydrologyDirections[d][1];
            if (!valid[ny * width + nx]) { boundary = true; break; }
          }
        }
        if (boundary) {
          visited[index] = 1;
          filled[index] = elevation[index];
          heap.push(index, filled[index]);
        }
      }
    }
    let item;
    while ((item = heap.pop())) {
      const index = item.index;
      const x = index % width; const y = Math.floor(index / width);
      for (let d = 0; d < hydrologyDirections.length; d += 1) {
        const nx = x + hydrologyDirections[d][0]; const ny = y + hydrologyDirections[d][1];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbor = ny * width + nx;
        if (!valid[neighbor] || visited[neighbor]) continue;
        visited[neighbor] = 1;
        filled[neighbor] = Math.max(elevation[neighbor], filled[index]);
        heap.push(neighbor, filled[neighbor]);
      }
    }
    const southwest = toUtm([surveyExtent[0], surveyExtent[1]]);
    const northeast = toUtm([surveyExtent[2], surveyExtent[3]]);
    const cellWidth = Math.abs(northeast[0] - southwest[0]) / width;
    const cellHeight = Math.abs(northeast[1] - southwest[1]) / height;
    const cellArea = cellWidth * cellHeight;
    hydrologyGrid = { width: width, height: height, size: size, elevation: elevation, filled: filled, valid: valid, cellWidth: cellWidth, cellHeight: cellHeight, cellArea: cellArea, validArea: validCellCount * cellArea };
    return hydrologyGrid;
  }

  function solveHydrology(options) {
    const grid = buildHydrologyGrid();
    return new Promise(function (resolve, reject) {
      const worker = new Worker(sharedBase + '/hydrology-worker.js?v=20260828-accuracy-2');
      worker.onmessage = function (event) {
        worker.terminate();
        if (event.data.error) { reject(new Error(event.data.error)); return; }
        event.data.snapshots = event.data.snapshots.map(function (buffer) { return new Uint16Array(buffer); });
        event.data.infiltrationSnapshots = event.data.infiltrationSnapshots.map(function (buffer) { return new Uint16Array(buffer); });
        resolve(event.data);
      };
      worker.onerror = function (event) { worker.terminate(); reject(new Error(event.message || 'Hydrology worker failed')); };
      const elevation = grid.elevation.slice();
      const valid = grid.valid.slice();
      const sourceWeights = options.sourceWeights ? options.sourceWeights.slice() : null;
      const payload = {
        width: grid.width,
        height: grid.height,
        elevation: elevation.buffer,
        valid: valid.buffer,
        cellWidth: grid.cellWidth,
        cellHeight: grid.cellHeight,
        cellArea: grid.cellArea,
        mode: options.mode,
        totalMinutes: options.totalMinutes,
        rainIntensity: options.rainIntensity || 0,
        totalFlow: options.totalFlow || 0,
        sourceWeights: sourceWeights && sourceWeights.buffer,
        soil: options.soil,
        manning: options.soil.manning
      };
      const transfers = [payload.elevation, payload.valid];
      if (payload.sourceWeights) transfers.push(payload.sourceWeights);
      worker.postMessage(payload, transfers);
    });
  }

  function irrigationOutlets(entryFeatures) {
    const pipes = waterPipeSource.getFeatures().filter(function (pipe) { return (pipe.get('pipeRole') || 'delivery') === 'delivery'; });
    const outlets = [];
    entryFeatures.forEach(function (entry) {
      const entryNumber = entry.get('entryNumber');
      const connected = pipes.filter(function (pipeFeature) { return pipeFeature.get('entryNumber') === entryNumber; });
      if (!connected.length) {
        outlets.push({ coordinate: entry.getGeometry().getCoordinates(), direction: null, weight: 1 / entryFeatures.length });
        return;
      }
      const terminalPipes = connected.filter(function (pipeFeature) { return !connected.some(function (candidate) { return candidate.get('parentPipe') === pipeFeature.get('pipeId'); }); });
      const terminals = terminalPipes.length ? terminalPipes : connected;
      terminals.forEach(function (pipeFeature) {
        const coordinates = pipeFeature.getGeometry().getCoordinates();
        const end = coordinates[coordinates.length - 1];
        const previous = coordinates[coordinates.length - 2];
        const dx = end[0] - previous[0]; const dy = end[1] - previous[1];
        const length = Math.max(.000001, Math.hypot(dx, dy));
        outlets.push({ coordinate: end, direction: [dx / length, dy / length], weight: 1 / entryFeatures.length / terminals.length, pipe: pipeFeature });
      });
    });
    return outlets;
  }

  function sourceWeightsFromOutlets(grid, outlets, totalFlow, diameterMm) {
    const weights = new Float32Array(grid.size);
    function addCoordinate(coordinate, amount) {
      const x = Math.max(0, Math.min(grid.width - 1, Math.floor((coordinate[0] - surveyExtent[0]) / (surveyExtent[2] - surveyExtent[0]) * grid.width)));
      const y = Math.max(0, Math.min(grid.height - 1, Math.floor((surveyExtent[3] - coordinate[1]) / (surveyExtent[3] - surveyExtent[1]) * grid.height)));
      let nearest = -1;
      let nearestDistance = Infinity;
      for (let radius = 0; radius <= 8 && nearest < 0; radius += 1) {
        for (let dy = -radius; dy <= radius; dy += 1) {
          for (let dx = -radius; dx <= radius; dx += 1) {
            const nx = x + dx; const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
            const index = ny * grid.width + nx;
            const distance = dx * dx + dy * dy;
            if (grid.valid[index] && distance < nearestDistance) { nearest = index; nearestDistance = distance; }
          }
        }
      }
      if (nearest >= 0) { weights[nearest] += amount; return true; }
      return false;
    }
    let unmappedOutlets = 0;
    outlets.forEach(function (outlet) {
      if (!outlet.direction) {
        if (!addCoordinate(outlet.coordinate, outlet.weight)) unmappedOutlets += 1;
        return;
      }
      const outletFlow = totalFlow * outlet.weight;
      const outletDiameter = diameterMm / 1000;
      const outletVelocity = outletDiameter > 0 ? (outletFlow / 60000) / (Math.PI * outletDiameter * outletDiameter / 4) : 0;
      const jetLengthMeters = Math.max(.5, Math.min(8, outletVelocity * .7));
      const latitude = ol.proj.toLonLat(outlet.coordinate)[1] * Math.PI / 180;
      const mapUnitsPerMeter = 1 / Math.max(.2, Math.cos(latitude));
      const samples = Math.max(2, Math.min(8, Math.ceil(jetLengthMeters / Math.max(.5, Math.min(grid.cellWidth, grid.cellHeight)))));
      let mapped = false;
      for (let sample = 0; sample <= samples; sample += 1) {
        const distance = jetLengthMeters * mapUnitsPerMeter * sample / samples;
        mapped = addCoordinate([outlet.coordinate[0] + outlet.direction[0] * distance, outlet.coordinate[1] + outlet.direction[1] * distance], outlet.weight * (.35 + sample / samples)) || mapped;
      }
      if (!mapped) unmappedOutlets += 1;
    });
    if (unmappedOutlets) throw new Error(unmappedOutlets + ' water outlet' + (unmappedOutlets === 1 ? ' is' : 's are') + ' outside the valid terrain footprint. Move the affected entry or pipe endpoint onto the DTM.');
    let total = 0;
    for (let i = 0; i < weights.length; i += 1) total += weights[i];
    if (!total) throw new Error('No water source could be placed on the valid terrain footprint.');
    for (let i = 0; i < weights.length; i += 1) weights[i] /= total;
    return weights;
  }

  function dripPipeDiameter(role) {
    if (role === 'mainline') return numberValue('drip-main-diameter', 40);
    if (role === 'submain') return numberValue('drip-submain-diameter', 32);
    return numberValue('drip-lateral-diameter', 16);
  }

  function pointsAlongPipe(feature, spacing) {
    const coordinates = feature.getGeometry().getCoordinates();
    const segments = [];
    let total = 0;
    for (let i = 1; i < coordinates.length; i += 1) {
      const length = distanceMeters([coordinates[i - 1], coordinates[i]]);
      segments.push({ start: coordinates[i - 1], end: coordinates[i], from: total, length: length });
      total += length;
    }
    if (!total) return [];
    const offsets = [];
    for (let offset = Math.min(spacing / 2, total / 2); offset < total; offset += spacing) offsets.push(offset);
    if (!offsets.length) offsets.push(total / 2);
    return offsets.map(function (offset) {
      const segment = segments.find(function (candidate) { return offset <= candidate.from + candidate.length; }) || segments[segments.length - 1];
      const progress = segment.length ? (offset - segment.from) / segment.length : 0;
      return { coordinate: [segment.start[0] + (segment.end[0] - segment.start[0]) * progress, segment.start[1] + (segment.end[1] - segment.start[1]) * progress], distance: offset };
    });
  }

  function hazenWilliamsLoss(length, flowLitersHour, diameterMm) {
    const flow = Math.max(0, flowLitersHour) / 3600000;
    const diameter = diameterMm / 1000;
    return length && flow && diameter ? 10.67 * length * Math.pow(flow, 1.852) / (Math.pow(140, 1.852) * Math.pow(diameter, 4.87)) : 0;
  }

  function buildDripNetwork(entryFeatures) {
    const allPipes = waterPipeSource.getFeatures();
    const pipes = allPipes.filter(function (pipe) { return ['mainline', 'submain', 'dripline'].indexOf(pipe.get('pipeRole')) !== -1; });
    pipes.forEach(function (pipe) { if (!pipe.get('pipeId')) pipe.set('pipeId', 'pipe-' + waterPipeSequence++); });
    const pipeIds = pipes.map(function (pipe) { return pipe.get('pipeId'); });
    if (new Set(pipeIds).size !== pipeIds.length) throw new Error('The drip network contains duplicate pipe IDs. Erase and redraw the affected pipes.');
    const byId = new Map();
    const children = new Map();
    pipes.forEach(function (pipe) { byId.set(pipe.get('pipeId'), pipe); children.set(pipe.get('pipeId'), []); });
    const allById = new Map();
    allPipes.forEach(function (pipe) { if (pipe.get('pipeId')) allById.set(pipe.get('pipeId'), pipe); });
    const entryByNumber = new Map();
    entryFeatures.forEach(function (entry) { entryByNumber.set(entry.get('entryNumber'), entry); });
    const allowedParents = { mainline: ['mainline'], submain: ['mainline', 'submain'], dripline: ['mainline', 'submain'] };
    pipes.forEach(function (pipe) {
      const pipeId = pipe.get('pipeId');
      const role = pipe.get('pipeRole');
      const parentId = pipe.get('parentPipe');
      const start = pipe.getGeometry().getFirstCoordinate();
      if (!parentId) {
        const entry = entryByNumber.get(pipe.get('entryNumber'));
        if (role !== 'mainline' || !entry || distanceMeters([start, entry.getGeometry().getCoordinates()]) > 2) {
          throw new Error('Pipe ' + pipeId + ' is not connected to a water entry through a mainline. Reconnect or redraw the detached pipe.');
        }
        return;
      }
      const parent = byId.get(parentId);
      if (!parent) {
        const referenced = allById.get(parentId);
        throw new Error(referenced && referenced.get('pipeRole') === 'delivery' ? 'A drip-network pipe is connected through an irrigation delivery pipe. Reconnect its upstream end to a drip mainline, submain or entry.' : 'Pipe ' + pipeId + ' references a missing upstream pipe. Reconnect or redraw the detached pipe.');
      }
      if (parent.get('entryNumber') !== pipe.get('entryNumber')) throw new Error('Pipe ' + pipeId + ' crosses between different water entries. Reconnect it within one entry network.');
      if (allowedParents[role].indexOf(parent.get('pipeRole')) === -1) throw new Error('Pipe ' + pipeId + ' has an invalid ' + parent.get('pipeRole') + ' → ' + role + ' connection. Connect driplines to a mainline or submain.');
      const closest = parent.getGeometry().getClosestPoint(start);
      const actualDistance = distanceAlongCoordinates(parent.getGeometry().getCoordinates(), closest);
      const savedDistance = Number(pipe.get('parentDistance'));
      const parentLength = distanceMeters(parent.getGeometry().getCoordinates());
      if (distanceMeters([start, closest]) > 2 || !Number.isFinite(savedDistance) || savedDistance < 0 || savedDistance > parentLength + 2 || Math.abs(savedDistance - actualDistance) > 2) {
        throw new Error('Pipe ' + pipeId + ' has an invalid upstream connection point. Reconnect or redraw the detached pipe.');
      }
    });
    pipes.forEach(function (pipe) {
      const visited = new Set(); let cursor = pipe;
      while (cursor) {
        const cursorId = cursor.get('pipeId');
        if (visited.has(cursorId)) throw new Error('The drip network contains a pipe cycle. Erase and redraw the affected connection.');
        visited.add(cursorId);
        cursor = byId.get(cursor.get('parentPipe'));
      }
    });
    pipes.forEach(function (pipe) {
      const parentId = pipe.get('parentPipe');
      if (parentId && children.has(parentId)) children.get(parentId).push(pipe);
    });
    const spacing = numberValue('drip-emitter-spacing', 1);
    const nominalFlow = numberValue('drip-emitter-flow', 2);
    const emittersByPipe = new Map();
    pipes.forEach(function (pipe) {
      const points = pipe.get('pipeRole') === 'dripline' ? pointsAlongPipe(pipe, spacing) : [];
      emittersByPipe.set(pipe.get('pipeId'), points);
    });
    const designHead = numberValue('drip-pressure', 1.2) * 10.197;
    const pc = document.getElementById('drip-emitter-type').value === 'pc';
    const emitters = [];
    pipes.forEach(function (lateral) {
      const points = emittersByPipe.get(lateral.get('pipeId')) || [];
      points.forEach(function (point) {
        emitters.push({ coordinate: point.coordinate, distance: point.distance, pipe: lateral, pressureBar: 0, flowLh: nominalFlow, targetFlowLh: nominalFlow, pressureDeficient: false });
      });
    });
    const emittersByPipeId = new Map();
    pipes.forEach(function (pipe) { emittersByPipeId.set(pipe.get('pipeId'), []); });
    emitters.forEach(function (emitter) { emittersByPipeId.get(emitter.pipe.get('pipeId')).push(emitter); });
    function calculatePipeFlows() {
      const flows = new Map();
      function total(pipeId, trail) {
        if (flows.has(pipeId)) return flows.get(pipeId);
        if (trail.has(pipeId)) return 0;
        const nextTrail = new Set(trail); nextTrail.add(pipeId);
        let flow = (emittersByPipeId.get(pipeId) || []).reduce(function (sum, emitter) { return sum + emitter.flowLh; }, 0);
        (children.get(pipeId) || []).forEach(function (child) { flow += total(child.get('pipeId'), nextTrail); });
        flows.set(pipeId, flow);
        return flow;
      }
      pipes.forEach(function (pipe) { total(pipe.get('pipeId'), new Set()); });
      return flows;
    }
    function lossToDistance(pipe, targetDistance, pipeFlows) {
      const pipeId = pipe.get('pipeId');
      const events = (emittersByPipeId.get(pipeId) || []).map(function (emitter) { return { distance: emitter.distance, flow: emitter.flowLh }; });
      (children.get(pipeId) || []).forEach(function (child) {
        events.push({ distance: Math.max(0, Number(child.get('parentDistance')) || 0), flow: pipeFlows.get(child.get('pipeId')) || 0 });
      });
      events.sort(function (a, b) { return a.distance - b.distance; });
      let cursor = 0; let flow = pipeFlows.get(pipeId) || 0; let loss = 0;
      events.forEach(function (event) {
        if (event.distance >= targetDistance) return;
        const end = Math.max(cursor, Math.min(targetDistance, event.distance));
        loss += hazenWilliamsLoss(end - cursor, flow, dripPipeDiameter(pipe.get('pipeRole')));
        cursor = end; flow = Math.max(0, flow - event.flow);
      });
      loss += hazenWilliamsLoss(Math.max(0, targetDistance - cursor), flow, dripPipeDiameter(pipe.get('pipeRole')));
      return loss;
    }
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const pipeFlows = calculatePipeFlows();
      let maximumChange = 0;
      emitters.forEach(function (emitter) {
        const lateral = emitter.pipe;
        const path = [];
        let cursor = lateral; const visited = new Set();
        while (cursor && !visited.has(cursor.get('pipeId'))) {
          visited.add(cursor.get('pipeId')); path.unshift(cursor);
          cursor = byId.get(cursor.get('parentPipe'));
        }
        let friction = 0;
        path.forEach(function (pipe, pathIndex) {
          const child = path[pathIndex + 1];
          const length = pipe === lateral ? emitter.distance : child ? Math.max(0, Number(child.get('parentDistance')) || 0) : distanceMeters(pipe.getGeometry().getCoordinates());
          friction += lossToDistance(pipe, length, pipeFlows);
        });
        const entry = entryByNumber.get(lateral.get('entryNumber'));
        const sourceElevation = entry ? elevationAtCoordinate(entry.getGeometry().getCoordinates()) : null;
        const emitterElevation = elevationAtCoordinate(emitter.coordinate);
        const elevationRise = sourceElevation !== null && emitterElevation !== null ? emitterElevation - sourceElevation : 0;
        const pressureHead = Math.max(0, designHead - friction - elevationRise);
        const pcMinimumHead = 7.14;
        const pressureFactor = pc ? (pressureHead >= pcMinimumHead ? 1 : Math.sqrt(pressureHead / pcMinimumHead)) : Math.sqrt(pressureHead / Math.max(.1, designHead));
        const flow = nominalFlow * Math.max(0, pressureFactor);
        maximumChange = Math.max(maximumChange, Math.abs(flow - emitter.flowLh));
        emitter.pressureBar = pressureHead / 10.197;
        emitter.flowLh = flow;
        emitter.pressureDeficient = pc ? pressureHead < pcMinimumHead : pressureFactor < .95;
      });
      if (maximumChange < .0001) break;
    }
    const predictedFlow = emitters.reduce(function (sum, emitter) { return sum + emitter.flowLh; }, 0);
    const requiredFlow = emitters.length * nominalFlow;
    const capacity = numberValue('drip-capacity', 2000);
    const capacityRatio = requiredFlow ? Math.min(1, capacity / requiredFlow) : 1;
    const capacityLimited = capacityRatio < .999;
    const lateralEmitterCounts = pipes.filter(function (pipe) { return pipe.get('pipeRole') === 'dripline'; }).map(function (pipe) { return (emittersByPipe.get(pipe.get('pipeId')) || []).length; }).filter(function (count) { return count > 0; });
    const minimumLateralFlowLh = lateralEmitterCounts.length ? Math.min.apply(Math, lateralEmitterCounts) * nominalFlow : nominalFlow;
    const severelyCapacityLimited = capacity < minimumLateralFlowLh;
    const deliveryScale = capacityLimited ? Math.min(1, capacity / Math.max(.001, predictedFlow)) : 1;
    emitters.forEach(function (emitter) {
      emitter.flowLh *= deliveryScale;
      emitter.flowDeficient = emitter.flowLh < nominalFlow * .995;
      emitter.targetFlowLh = nominalFlow;
      if (capacityLimited) emitter.pressureDeficient = false;
    });
    const totalFlow = predictedFlow * deliveryScale;
    const pressures = emitters.map(function (emitter) { return emitter.pressureBar; });
    const flows = emitters.map(function (emitter) { return emitter.flowLh; }).sort(function (a, b) { return a - b; });
    const lowCount = Math.max(1, Math.ceil(flows.length / 4));
    const lowAverage = flows.slice(0, lowCount).reduce(function (sum, flow) { return sum + flow; }, 0) / lowCount;
    const average = flows.length ? totalFlow / flows.length : 0;
    return {
      emitters: emitters,
      totalFlowLh: totalFlow,
      requiredFlowLh: requiredFlow,
      availableFlowLh: capacity,
      capacityRatio: capacityRatio,
      capacityLimited: capacityLimited,
      severelyCapacityLimited: severelyCapacityLimited,
      minimumLateralFlowLh: minimumLateralFlowLh,
      maximumSupportedEmitters: Math.floor(capacity / nominalFlow),
      zonesRequired: capacityLimited ? Math.ceil(requiredFlow / capacity) : 1,
      minPressureBar: capacityLimited || !pressures.length ? null : Math.min.apply(Math, pressures),
      maxPressureBar: capacityLimited || !pressures.length ? null : Math.max.apply(Math, pressures),
      lowPressureCount: emitters.filter(function (emitter) { return emitter.pressureDeficient; }).length,
      lowFlowCount: emitters.filter(function (emitter) { return emitter.flowDeficient; }).length,
      averageDeliveredFlowLh: emitters.length ? totalFlow / emitters.length : 0,
      targetEmitterFlowLh: nominalFlow,
      uniformity: capacityLimited ? null : average ? lowAverage / average * 100 : 0,
      pipeCount: pipes.length,
      lateralCount: pipes.filter(function (pipe) { return pipe.get('pipeRole') === 'dripline'; }).length
    };
  }

  function createDripWetting(grid, emitters, durationMinutes, radiusMeters) {
    const wetting = new Float32Array(grid.size);
    const arrivals = new Float32Array(grid.size); arrivals.fill(Infinity);
    let maxDepth = 0;
    let referenceDepth = 0;
    emitters.forEach(function (emitter) {
      const centerX = Math.max(0, Math.min(grid.width - 1, Math.floor((emitter.coordinate[0] - surveyExtent[0]) / (surveyExtent[2] - surveyExtent[0]) * grid.width)));
      const centerY = Math.max(0, Math.min(grid.height - 1, Math.floor((surveyExtent[3] - emitter.coordinate[1]) / (surveyExtent[3] - surveyExtent[1]) * grid.height)));
      const flowRatio = Math.max(.01, Math.min(1, emitter.flowLh / Math.max(.001, emitter.targetFlowLh || emitter.flowLh)));
      const effectiveRadius = radiusMeters * Math.sqrt(flowRatio);
      const rx = Math.max(1, Math.ceil(effectiveRadius / Math.max(.1, grid.cellWidth)));
      const ry = Math.max(1, Math.ceil(effectiveRadius / Math.max(.1, grid.cellHeight)));
      const volumeLiters = emitter.flowLh * durationMinutes / 60;
      const nominalDepth = volumeLiters / Math.max(.1, Math.PI * radiusMeters * radiusMeters);
      const targetVolumeLiters = (emitter.targetFlowLh || emitter.flowLh) * durationMinutes / 60;
      referenceDepth = Math.max(referenceDepth, targetVolumeLiters / Math.max(.1, Math.PI * radiusMeters * radiusMeters));
      for (let dy = -ry; dy <= ry; dy += 1) {
        for (let dx = -rx; dx <= rx; dx += 1) {
          const x = centerX + dx; const y = centerY + dy;
          if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
          const index = y * grid.width + x;
          if (!grid.valid[index]) continue;
          const distance = Math.hypot(dx * grid.cellWidth, dy * grid.cellHeight);
          if (distance > effectiveRadius) continue;
          const falloff = Math.max(.15, 1 - distance / effectiveRadius);
          wetting[index] += nominalDepth * falloff;
          arrivals[index] = Math.min(arrivals[index], .03 + distance / radiusMeters * .35);
          maxDepth = Math.max(maxDepth, wetting[index]);
        }
      }
    });
    return { wetting: wetting, arrivals: arrivals, maxDepthMm: maxDepth, referenceDepthMm: referenceDepth };
  }

  const waterDepthRamp = [
    [0, 127, 205, 250],
    [.05, 109, 185, 245],
    [.15, 85, 160, 233],
    [.4, 56, 128, 214],
    [1, 33, 102, 172],
    [2, 84, 39, 143]
  ];
  const waterDepthRgb = [0, 0, 0];
  function waterDepthColor(depth) {
    let upper = 1;
    while (upper < waterDepthRamp.length - 1 && depth > waterDepthRamp[upper][0]) upper += 1;
    const lower = waterDepthRamp[upper - 1];
    const next = waterDepthRamp[upper];
    const mix = Math.max(0, Math.min(1, (depth - lower[0]) / (next[0] - lower[0])));
    waterDepthRgb[0] = lower[1] + (next[1] - lower[1]) * mix;
    waterDepthRgb[1] = lower[2] + (next[2] - lower[2]) * mix;
    waterDepthRgb[2] = lower[3] + (next[3] - lower[3]) * mix;
  }

  function renderWaterTimeline(progress) {
    if (!waterSimulationState) return;
    const state = waterSimulationState;
    const grid = state.grid;
    waterSurfaceCanvas.width = grid.width;
    waterSurfaceCanvas.height = grid.height;
    const context = waterSurfaceCanvas.getContext('2d');
    const image = context.createImageData(grid.width, grid.height);
    if (state.wetting) {
      for (let i = 0; i < grid.size; i += 1) {
        if (!state.wetting[i]) continue;
        const arrival = state.wettingArrivals[i];
        if (!Number.isFinite(arrival) || progress <= arrival) continue;
        const localProgress = Math.min(1, (progress - arrival) / Math.max(.001, 1 - arrival));
        const depthStrength = Math.min(1, state.wetting[i] / Math.max(.1, state.wettingReferenceDepthMm || state.maxWettingDepthMm));
        const offset = i * 4;
        image.data[offset] = 115 - Math.round(35 * depthStrength);
        image.data[offset + 1] = 190 + Math.round(25 * depthStrength);
        image.data[offset + 2] = 245;
        image.data[offset + 3] = Math.round((100 + 130 * depthStrength) * Math.sqrt(localProgress));
      }
    }
    if (state.infiltrationSnapshots && !state.wetting) {
      const infiltrationSnapshot = state.infiltrationSnapshots[Math.min(state.infiltrationSnapshots.length - 1, Math.round(progress * (state.infiltrationSnapshots.length - 1)))];
      for (let i = 0; i < grid.size; i += 1) {
        if (!grid.valid[i] || !infiltrationSnapshot[i]) continue;
        const depth = infiltrationSnapshot[i] * state.infiltrationSnapshotScale;
        const strength = Math.min(1, Math.sqrt(depth / Math.max(.0005, state.maxInfiltrationDepth)));
        const offset = i * 4;
        image.data[offset] = 32;
        image.data[offset + 1] = 42;
        image.data[offset + 2] = 54;
        image.data[offset + 3] = Math.round(28 + 95 * strength);
      }
    }
    const snapshot = state.snapshots[Math.min(state.snapshots.length - 1, Math.round(progress * (state.snapshots.length - 1)))];
    for (let i = 0; i < grid.size; i += 1) {
      if (!grid.valid[i] || !snapshot[i]) continue;
      const depth = snapshot[i] * state.snapshotScale;
      waterDepthColor(depth);
      const offset = i * 4;
      image.data[offset] = Math.round(waterDepthRgb[0]);
      image.data[offset + 1] = Math.round(waterDepthRgb[1]);
      image.data[offset + 2] = Math.round(waterDepthRgb[2]);
      image.data[offset + 3] = Math.round(70 + 180 * Math.min(1, Math.sqrt(depth / .2)));
    }
    for (let y = 0; y < grid.height; y += 1) {
      for (let x = 0; x < grid.width; x += 1) {
        const index = y * grid.width + x;
        if (grid.valid[index]) continue;
        const offset = index * 4;
        image.data[offset] = 30;
        image.data[offset + 1] = 38;
        image.data[offset + 2] = 46;
        image.data[offset + 3] = (x + y) % 6 < 2 ? 115 : 40;
      }
    }
    context.putImageData(image, 0, 0);
    if (!waterBackgroundLayer) {
      waterBackgroundLayer = elevationLayer.getVisible() ? elevationLayer : layers['plant-health'].getVisible() ? layers['plant-health'] : layers.orthophoto.getVisible() ? layers.orthophoto : null;
      if (waterBackgroundLayer) waterPreviousTerrainOpacity = waterBackgroundLayer.getOpacity();
    }
    if (waterBackgroundLayer) {
      waterBackgroundLayer.setOpacity(waterTerrainOpacity);
      document.getElementById('map-opacity').value = waterTerrainOpacity;
    }
    waterSurfaceLayer.setVisible(true);
    waterSurfaceSource.changed();
    const elapsed = state.totalMinutes * progress;
    document.getElementById('water-time-label').textContent = elapsed >= 60 ? Math.floor(elapsed / 60) + 'h ' + Math.round(elapsed % 60) + 'm' : Math.round(elapsed) + ' min';
  }

  function stopWaterAnimation() {
    if (waterAnimationFrame) cancelAnimationFrame(waterAnimationFrame);
    waterAnimationFrame = null;
    document.getElementById('water-play').textContent = '▶';
    document.getElementById('water-play').setAttribute('aria-label', 'Play water simulation');
  }

  function setWaterTimeline(progress) {
    progress = Math.max(0, Math.min(1, progress));
    document.getElementById('water-time').value = Math.round(progress * 100);
    renderWaterTimeline(progress);
  }

  function playWaterTimeline() {
    if (!waterSimulationState) return;
    if (waterAnimationFrame) { stopWaterAnimation(); return; }
    let startProgress = Number(document.getElementById('water-time').value) / 100;
    if (startProgress >= .995) { startProgress = 0; setWaterTimeline(0); }
    const startTime = performance.now();
    const duration = 9000 * (1 - startProgress);
    let lastRender = 0;
    document.getElementById('water-play').textContent = 'Ⅱ';
    document.getElementById('water-play').setAttribute('aria-label', 'Pause water simulation');
    function frame(now) {
      const progress = Math.min(1, startProgress + (now - startTime) / duration * (1 - startProgress));
      if (now - lastRender > 65 || progress === 1) { setWaterTimeline(progress); lastRender = now; }
      if (progress < 1) waterAnimationFrame = requestAnimationFrame(frame);
      else stopWaterAnimation();
    }
    waterAnimationFrame = requestAnimationFrame(frame);
  }

  function clearWaterSurface() {
    stopWaterAnimation();
    waterSimulationState = null;
    waterSurfaceCanvas.width = 0; waterSurfaceCanvas.height = 0;
    waterSurfaceLayer.setVisible(false);
    document.getElementById('water-low-pressure-key').hidden = true;
    document.getElementById('water-low-flow-key').hidden = true;
    if (waterPreviousTerrainOpacity !== null && waterBackgroundLayer) {
      waterBackgroundLayer.setOpacity(waterPreviousTerrainOpacity);
      document.getElementById('map-opacity').value = waterPreviousTerrainOpacity;
    }
    waterPreviousTerrainOpacity = null;
    waterBackgroundLayer = null;
    waterSurfaceSource.changed();
    document.getElementById('water-timeline').hidden = true;
    document.getElementById('water-legend').hidden = true;
  }

  function totalZoneArea() {
    let area = 0;
    waterZoneSource.getFeatures().forEach(function (feature) { area += areaSquareMeters(feature.getGeometry().getCoordinates()); });
    return area;
  }

  function irrigationNetworkMetrics(entryFeatures, outlets, totalFlow, diameterMm) {
    const pipes = waterPipeSource.getFeatures().filter(function (pipe) { return (pipe.get('pipeRole') || 'delivery') === 'delivery'; });
    const byId = new Map(); const children = new Map(); const flowById = new Map();
    pipes.forEach(function (pipe) { byId.set(pipe.get('pipeId'), pipe); children.set(pipe.get('pipeId'), []); flowById.set(pipe.get('pipeId'), 0); });
    pipes.forEach(function (pipe) {
      const parentId = pipe.get('parentPipe');
      if (parentId && children.has(parentId)) children.get(parentId).push(pipe);
    });
    outlets.forEach(function (outlet) {
      let pipe = outlet.pipe; const visited = new Set(); const outletFlow = totalFlow * outlet.weight;
      while (pipe && !visited.has(pipe.get('pipeId'))) {
        const pipeId = pipe.get('pipeId'); visited.add(pipeId);
        flowById.set(pipeId, (flowById.get(pipeId) || 0) + outletFlow);
        pipe = byId.get(pipe.get('parentPipe'));
      }
    });
    function pipeLossToDistance(pipe, targetDistance) {
      const pipeId = pipe.get('pipeId');
      const events = (children.get(pipeId) || []).map(function (child) {
        return { distance: Math.max(0, Number(child.get('parentDistance')) || 0), flow: flowById.get(child.get('pipeId')) || 0 };
      }).sort(function (a, b) { return a.distance - b.distance; });
      let cursor = 0; let flow = flowById.get(pipeId) || 0; let loss = 0;
      events.forEach(function (event) {
        if (event.distance >= targetDistance) return;
        const end = Math.max(cursor, Math.min(targetDistance, event.distance));
        loss += hazenWilliamsLoss(end - cursor, flow * 60, diameterMm);
        cursor = end; flow = Math.max(0, flow - event.flow);
      });
      loss += hazenWilliamsLoss(Math.max(0, targetDistance - cursor), flow * 60, diameterMm);
      return loss;
    }
    function maximumElevationToDistance(pipe, targetDistance) {
      const coordinates = pipe.getGeometry().getCoordinates();
      let travelled = 0; let maximum = -Infinity;
      for (let i = 0; i < coordinates.length; i += 1) {
        if (i > 0 && travelled >= targetDistance) break;
        const coordinate = coordinates[i];
        const elevation = elevationAtCoordinate(coordinate);
        if (elevation !== null) maximum = Math.max(maximum, elevation);
        if (i + 1 >= coordinates.length) continue;
        const segmentLength = distanceMeters([coordinate, coordinates[i + 1]]);
        if (travelled + segmentLength >= targetDistance && segmentLength > 0) {
          const progress = (targetDistance - travelled) / segmentLength;
          const point = [coordinate[0] + (coordinates[i + 1][0] - coordinate[0]) * progress, coordinate[1] + (coordinates[i + 1][1] - coordinate[1]) * progress];
          const partialElevation = elevationAtCoordinate(point);
          if (partialElevation !== null) maximum = Math.max(maximum, partialElevation);
          break;
        }
        travelled += segmentLength;
      }
      return maximum;
    }
    const entries = new Map();
    entryFeatures.forEach(function (entry) { entries.set(entry.get('entryNumber'), entry); });
    let criticalLoss = 0; let criticalLift = 0; let criticalDynamicHead = 0;
    outlets.forEach(function (outlet) {
      if (!outlet.pipe) return;
      const path = []; let pipe = outlet.pipe; const visited = new Set();
      while (pipe && !visited.has(pipe.get('pipeId'))) { visited.add(pipe.get('pipeId')); path.unshift(pipe); pipe = byId.get(pipe.get('parentPipe')); }
      const entry = entries.get(outlet.pipe.get('entryNumber'));
      const sourceElevation = entry ? elevationAtCoordinate(entry.getGeometry().getCoordinates()) : null;
      let loss = 0; let maximumElevation = sourceElevation === null ? -Infinity : sourceElevation;
      path.forEach(function (pathPipe, index) {
        const child = path[index + 1];
        const targetDistance = child ? Math.max(0, Number(child.get('parentDistance')) || 0) : distanceMeters(pathPipe.getGeometry().getCoordinates());
        loss += pipeLossToDistance(pathPipe, targetDistance);
        maximumElevation = Math.max(maximumElevation, maximumElevationToDistance(pathPipe, targetDistance));
      });
      const lift = sourceElevation === null || !Number.isFinite(maximumElevation) ? 0 : Math.max(0, maximumElevation - sourceElevation);
      if (loss + lift > criticalDynamicHead) { criticalDynamicHead = loss + lift; criticalLoss = loss; criticalLift = lift; }
    });
    let length = 0; let maximumVelocity = 0; let maximumFlow = 0;
    pipes.forEach(function (pipe) {
      const flow = flowById.get(pipe.get('pipeId')) || 0;
      const pipeLength = distanceMeters(pipe.getGeometry().getCoordinates());
      const q = flow / 60000; const diameter = diameterMm / 1000;
      length += pipeLength; maximumFlow = Math.max(maximumFlow, flow);
      if (diameter > 0) maximumVelocity = Math.max(maximumVelocity, q / (Math.PI * diameter * diameter / 4));
    });
    return { length: length, lift: criticalLift, loss: criticalLoss, velocity: maximumVelocity, maximumFlow: maximumFlow || totalFlow };
  }

  function recommendedPipe(flowLitersMinute) {
    const standards = [16, 20, 25, 32, 40, 50, 63, 75, 90, 110, 125, 160];
    const q = flowLitersMinute / 60000;
    const minimum = Math.sqrt(4 * q / (Math.PI * 1.2)) * 1000;
    for (let i = 0; i < standards.length; i += 1) if (standards[i] >= minimum) return standards[i];
    return standards[standards.length - 1];
  }

  function formatVolume(liters) {
    return liters >= 1000 ? (liters / 1000).toFixed(2) + ' m³' : Math.round(liters).toLocaleString() + ' L';
  }

  function formatPower(kilowatts) {
    if (kilowatts <= 0) return '0 W';
    if (kilowatts < .001) return '<1 W';
    if (kilowatts < .01) return (kilowatts * 1000).toFixed(1).replace(/\.0$/, '') + ' W';
    return kilowatts.toFixed(2) + ' kW / ' + (kilowatts * 1.341).toFixed(2) + ' hp';
  }

  function formatSolarPower(kilowattsPeak) {
    if (kilowattsPeak <= 0) return '0 Wp';
    if (kilowattsPeak < .001) return '<1 Wp';
    if (kilowattsPeak < .01) return (kilowattsPeak * 1000).toFixed(1).replace(/\.0$/, '') + ' Wp';
    return kilowattsPeak.toFixed(2) + ' kWp';
  }

  function showSizingResults(zoneArea, designFlow, hydraulicFlow, pipe, demandLitersDay) {
    const recommended = recommendedPipe(pipe.maximumFlow || hydraulicFlow);
    const pressureHead = numberValue('water-pressure', 2.5) * 10.197;
    const totalHead = pressureHead + numberValue('water-source-lift', 0) + pipe.lift + pipe.loss;
    const efficiency = numberValue('pump-efficiency', 65) / 100;
    const pumpKw = hydraulicFlow > 0 ? (1000 * 9.81 * (hydraulicFlow / 60000) * totalHead / efficiency) / 1000 : 0;
    const operatingHours = numberValue('water-hours', 6);
    const solarHours = numberValue('solar-hours', 5);
    const solarKwp = pumpKw * operatingHours / (solarHours * .75);
    const panelCount = Math.ceil(solarKwp / .55);
    document.getElementById('water-demand').textContent = formatVolume(demandLitersDay) + '/day · ' + Math.round(designFlow * 60).toLocaleString() + ' L/h (' + designFlow.toFixed(1) + ' L/min)';
    document.getElementById('water-pipe-result').textContent = pipe.length.toFixed(1) + ' m drawn · test ' + numberValue('water-diameter', 25) + ' mm ID: critical path ' + pipe.loss.toFixed(1) + ' m loss, maximum ' + pipe.velocity.toFixed(1) + ' m/s · suggested ≥ ' + recommended + ' mm';
    document.getElementById('water-pump').textContent = formatPower(pumpKw) + ' · ' + totalHead.toFixed(1) + ' m head';
    document.getElementById('water-solar').textContent = formatSolarPower(solarKwp) + ' · about ' + panelCount + ' × 550 W panel' + (panelCount === 1 ? '' : 's');
    document.getElementById('water-demand-row').hidden = false;
    document.getElementById('water-pump-row').hidden = false;
    document.getElementById('water-solar-row').hidden = false;
    document.getElementById('water-pipe-result-row').hidden = false;
    return zoneArea;
  }

  function runIrrigationSimulation() {
    document.querySelector('#water-demand-row dt').textContent = 'Zone demand';
    ['water-drip-summary-row', 'water-uniformity-row'].forEach(function (id) { document.getElementById(id).hidden = true; });
    const entries = waterEntrySource.getFeatures();
    const totalFlow = totalIrrigationFlow(entries.length);
    const flowPerEntry = entries.length ? totalFlow / entries.length : flowLitersMinuteValue();
    const duration = numberValue('water-duration', 20);
    const applied = totalFlow * duration;
    const soil = greenAmptSoils[document.getElementById('water-soil').value] || greenAmptSoils.loam;
    waterResultSource.clear();
    clearWaterSurface();
    const entryCoordinates = entries.map(function (feature) { return feature.getGeometry().getCoordinates(); });
    const drawnArea = totalZoneArea();
    const grid = buildHydrologyGrid();
    const zoneArea = drawnArea || grid.validArea || surveyAreaSquareMeters;
    const dailyDemand = zoneArea * numberValue('water-depth', 5);
    const designFlow = dailyDemand / (numberValue('water-hours', 6) * 60);
    const hydraulicFlow = Math.max(designFlow, totalFlow);
    const outlets = irrigationOutlets(entries);
    const pipe = irrigationNetworkMetrics(entries, outlets, hydraulicFlow, numberValue('water-diameter', 25));
    showSizingResults(zoneArea, designFlow, hydraulicFlow, pipe, dailyDemand);
    if (!entryCoordinates.length) {
      document.getElementById('water-applied').textContent = '0 L per run';
      document.getElementById('water-infiltration').textContent = '—';
      document.getElementById('water-runoff').textContent = '—';
      document.getElementById('water-path').textContent = 'Add entry points for terrain flow';
      document.getElementById('water-results').hidden = false;
      document.getElementById('water-legend').hidden = true;
      document.getElementById('water-status').textContent = 'Sizing calculated. Add at least one water entry to run the hydraulic simulation.';
      return Promise.resolve();
    }
    const connectedPipes = waterPipeSource.getFeatures().filter(function (feature) { return (feature.get('pipeRole') || 'delivery') === 'delivery'; });
    if (connectedPipes.length) {
      const runHydraulics = irrigationNetworkMetrics(entries, outlets, totalFlow, numberValue('water-diameter', 25));
      if (runHydraulics.velocity > 3) {
        document.getElementById('water-applied').textContent = formatVolume(applied) + ' per run';
        document.getElementById('water-infiltration').textContent = '—';
        document.getElementById('water-runoff').textContent = '—';
        document.getElementById('water-path').textContent = 'Pipe discharge exceeds safe test range';
        document.getElementById('water-results').hidden = false;
        document.getElementById('water-status').textContent = 'Maximum pipe velocity is ' + runHydraulics.velocity.toFixed(1) + ' m/s. Reduce flow or increase the highest-flow pipe to at least ' + recommendedPipe(runHydraulics.maximumFlow) + ' mm before simulating.';
        return Promise.resolve();
      }
    }
    document.getElementById('water-status').textContent = 'Running Green–Ampt infiltration and 2D diffusion-wave routing…';
    return solveHydrology({ mode: 'irrigation', totalMinutes: duration, totalFlow: totalFlow, sourceWeights: sourceWeightsFromOutlets(grid, outlets, totalFlow, numberValue('water-diameter', 25)), soil: soil }).then(function (solved) {
      const infiltrated = solved.infiltratedLiters;
      const runoff = Math.max(0, solved.appliedLiters - infiltrated);
      waterSimulationState = { mode: 'irrigation', totalMinutes: duration, grid: grid, snapshots: solved.snapshots, snapshotScale: solved.snapshotScale, maxPoolDepth: solved.maxDepth, infiltrationSnapshots: solved.infiltrationSnapshots, infiltrationSnapshotScale: solved.infiltrationSnapshotScale, maxInfiltrationDepth: solved.maxInfiltrationDepth };
      document.getElementById('water-timeline').hidden = false;
      setWaterTimeline(0); playWaterTimeline();
      document.getElementById('water-applied').textContent = formatVolume(solved.appliedLiters) + ' per run';
      document.getElementById('water-infiltration').textContent = formatVolume(infiltrated) + ' (' + Math.round(infiltrated / Math.max(1, solved.appliedLiters) * 100) + '%)';
      document.getElementById('water-runoff').textContent = formatVolume(runoff) + ' (' + Math.round(runoff / Math.max(1, solved.appliedLiters) * 100) + '%)';
      document.getElementById('water-path').textContent = '2D diffusion wave · grid-estimated maximum depth ' + (solved.maxDepth * 100).toFixed(1) + ' cm · ' + formatVolume(solved.outflowLiters) + ' approximate outflow';
      document.getElementById('water-results').hidden = false;
      document.getElementById('water-legend').hidden = false;
      const allocation = document.getElementById('water-flow-basis').value === 'total' ? formatVolume(totalFlow) + '/min shared across ' + entries.length + ' entries and ' + outlets.length + ' terminal outlets' : formatVolume(flowPerEntry) + '/min per entry across ' + outlets.length + ' terminal outlets';
      document.getElementById('water-status').textContent = allocation + ' · ' + (connectedPipes.length ? 'pipe endpoints discharge in the final segment direction; gravity and the DTM control subsequent flow.' : 'unpiped entries release locally; gravity and the DTM control flow in every direction.');
    });
  }

  function runDripSimulation() {
    document.querySelector('#water-demand-row dt').textContent = 'Required / available';
    const entries = waterEntrySource.getFeatures();
    const duration = numberValue('drip-duration', 120);
    const soil = greenAmptSoils[document.getElementById('water-soil').value] || greenAmptSoils.loam;
    waterResultSource.clear();
    clearWaterSurface();
    ['water-pipe-result-row', 'water-demand-row', 'water-pump-row', 'water-solar-row', 'water-drip-summary-row', 'water-uniformity-row'].forEach(function (id) { document.getElementById(id).hidden = false; });
    const invalidInput = document.querySelector('#water-drip-fields input:invalid');
    if (invalidInput) {
      invalidInput.reportValidity();
      document.getElementById('water-results').hidden = true;
      document.getElementById('water-status').textContent = invalidInput.id === 'drip-emitter-flow' ? 'Emitter flow is per outlet. Use 0.1–20 L/h; common drip emitters are about 1–4 L/h.' : 'Correct the highlighted drip-design value before simulating.';
      return Promise.resolve();
    }
    if (!entries.length) {
      document.getElementById('water-results').hidden = false;
      document.getElementById('water-applied').textContent = '0 L per run';
      document.getElementById('water-status').textContent = 'Add an entry, then connect mainline, submain and dripline pipes.';
      return Promise.resolve();
    }
    const network = buildDripNetwork(entries);
    document.getElementById('water-low-pressure-key').hidden = !network.lowPressureCount;
    document.getElementById('water-low-flow-key').hidden = !network.lowFlowCount;
    if (!network.emitters.length) {
      document.getElementById('water-results').hidden = false;
      document.getElementById('water-applied').textContent = '0 L per run';
      document.getElementById('water-status').textContent = 'No emitters found. Draw at least one pipe with Drawing pipe type set to Dripline / lateral.';
      return Promise.resolve();
    }
    const roleLengths = { mainline: 0, submain: 0, dripline: 0 };
    waterPipeSource.getFeatures().forEach(function (pipe) { const role = pipe.get('pipeRole'); if (roleLengths[role] !== undefined) roleLengths[role] += distanceMeters(pipe.getGeometry().getCoordinates()); });
    const head = numberValue('drip-pressure', 1.2) * 10.197 + numberValue('drip-source-lift', 0);
    const efficiency = numberValue('drip-pump-efficiency', 65) / 100;
    const pumpKw = 1000 * 9.81 * (network.requiredFlowLh / 3600000) * head / Math.max(.2, efficiency) / 1000;
    const runEnergy = pumpKw * duration / 60;
    const solarKwp = runEnergy / (numberValue('drip-solar-hours', 5) * .75);
    document.getElementById('water-pipe-result').textContent = roleLengths.mainline.toFixed(0) + ' m main · ' + roleLengths.submain.toFixed(0) + ' m submain · ' + roleLengths.dripline.toFixed(0) + ' m dripline';
    document.getElementById('water-demand').textContent = network.requiredFlowLh.toFixed(0) + ' L/h required · ' + network.availableFlowLh.toFixed(0) + ' L/h available' + (network.capacityLimited ? ' (' + (network.capacityRatio * 100).toFixed(1) + '%)' : '');
    document.getElementById('water-pump').textContent = formatPower(pumpKw) + ' hydraulic minimum · ' + network.requiredFlowLh.toFixed(0) + ' L/h at ' + head.toFixed(1) + ' m source head';
    document.getElementById('water-solar').textContent = formatSolarPower(solarKwp) + ' minimum run energy · size from the selected pump and controller';
    if (network.severelyCapacityLimited) {
      const supported = Math.min(network.emitters.length, network.maximumSupportedEmitters);
      document.getElementById('water-low-pressure-key').hidden = true;
      document.getElementById('water-low-flow-key').hidden = true;
      document.getElementById('water-applied').textContent = 'Not simulated — hydraulically infeasible';
      document.getElementById('water-infiltration').textContent = 'Not available';
      document.getElementById('water-runoff').textContent = 'Not available';
      document.getElementById('water-path').textContent = 'Pressure and emitter flow cannot be maintained';
      document.getElementById('water-drip-summary').textContent = network.emitters.length + ' emitters on ' + network.lateralCount + ' laterals · capacity supports about ' + supported + ' emitter' + (supported === 1 ? '' : 's') + ' at once · at least ' + network.zonesRequired + ' zones';
      document.getElementById('water-uniformity').textContent = 'Not valid — source capacity is below design demand';
      document.getElementById('water-results').hidden = false;
      document.getElementById('water-legend').hidden = true;
      document.getElementById('water-status').textContent = 'Severe source shortage: ' + network.availableFlowLh.toFixed(0) + ' L/h available, but the smallest complete lateral needs about ' + network.minimumLateralFlowLh.toFixed(0) + ' L/h. Increase source capacity or redesign the lateral zones.';
      return Promise.resolve();
    }
    network.emitters.forEach(function (emitter) {
      const feature = new ol.Feature(new ol.geom.Point(emitter.coordinate));
      feature.set('waterType', emitter.pressureDeficient ? 'emitter-low' : emitter.flowDeficient ? 'emitter-underflow' : 'emitter');
      feature.set('pressureBar', emitter.pressureBar);
      feature.set('flowLh', emitter.flowLh);
      feature.set('targetFlowLh', emitter.targetFlowLh);
      if (emitter.pressureDeficient) feature.setStyle([
        new ol.style.Style({ zIndex: 100, image: new ol.style.Circle({ radius: 8, fill: new ol.style.Fill({ color: '#fff' }) }) }),
        new ol.style.Style({ zIndex: 101, image: new ol.style.Circle({ radius: 6, fill: new ol.style.Fill({ color: '#ff3b30' }) }), text: new ol.style.Text({ text: '!', font: 'bold 9px Arial', fill: new ol.style.Fill({ color: '#fff' }) }) })
      ]);
      waterResultSource.addFeature(feature);
    });
    waterResultLayer.setVisible(true);
    const grid = buildHydrologyGrid();
    const sourceOutlets = network.emitters.map(function (emitter) { return { coordinate: emitter.coordinate, direction: null, weight: emitter.flowLh / Math.max(.0001, network.totalFlowLh) }; });
    const wetting = createDripWetting(grid, network.emitters, duration, numberValue('drip-wetting-radius', .7));
    document.getElementById('water-status').textContent = 'Calculating emitter pressure, wetting and terrain runoff…';
    return solveHydrology({ mode: 'irrigation', totalMinutes: duration, totalFlow: network.totalFlowLh / 60, sourceWeights: sourceWeightsFromOutlets(grid, sourceOutlets, network.totalFlowLh / 60, numberValue('drip-lateral-diameter', 16)), soil: soil }).then(function (solved) {
      const infiltrated = solved.infiltratedLiters;
      const runoff = Math.max(0, solved.appliedLiters - infiltrated);
      waterSimulationState = { mode: 'drip', totalMinutes: duration, grid: grid, snapshots: solved.snapshots, snapshotScale: solved.snapshotScale, maxPoolDepth: solved.maxDepth, infiltrationSnapshots: solved.infiltrationSnapshots, infiltrationSnapshotScale: solved.infiltrationSnapshotScale, maxInfiltrationDepth: solved.maxInfiltrationDepth, wetting: wetting.wetting, wettingArrivals: wetting.arrivals, maxWettingDepthMm: wetting.maxDepthMm, wettingReferenceDepthMm: wetting.referenceDepthMm };
      document.getElementById('water-timeline').hidden = false;
      setWaterTimeline(0); playWaterTimeline();
      document.getElementById('water-applied').textContent = formatVolume(solved.appliedLiters) + ' per run';
      document.getElementById('water-infiltration').textContent = formatVolume(infiltrated) + ' (' + Math.round(infiltrated / Math.max(1, solved.appliedLiters) * 100) + '%)';
      document.getElementById('water-runoff').textContent = formatVolume(runoff) + ' (' + Math.round(runoff / Math.max(1, solved.appliedLiters) * 100) + '%)';
      document.getElementById('water-path').textContent = network.capacityLimited ? 'Capacity-limited approximation · verify operating pressure with the pump and emitter curves' : network.minPressureBar.toFixed(2) + '–' + network.maxPressureBar.toFixed(2) + ' bar at emitters · grid-estimated maximum depth ' + (solved.maxDepth * 100).toFixed(1) + ' cm';
      document.getElementById('water-drip-summary').textContent = network.emitters.length + ' emitters on ' + network.lateralCount + ' lateral' + (network.lateralCount === 1 ? '' : 's') + ' · ' + network.totalFlowLh.toFixed(0) + ' L/h delivered' + (network.lowFlowCount ? ' · ' + network.lowFlowCount + ' below target (' + network.averageDeliveredFlowLh.toFixed(2) + ' / ' + network.targetEmitterFlowLh.toFixed(2) + ' L/h avg)' : '') + (network.lowPressureCount ? ' · ' + network.lowPressureCount + ' low pressure' : '');
      document.getElementById('water-uniformity').textContent = network.capacityLimited ? 'Not validated — capped flow is distributed evenly for this planning preview' : network.uniformity.toFixed(1) + '% modeled low-quarter DU · ideal ' + (document.getElementById('drip-emitter-type').value === 'pc' ? 'pressure-compensating' : 'non-compensating') + ' emitters; field DU will be lower';
      document.getElementById('water-results').hidden = false;
      document.getElementById('water-legend').hidden = false;
      const warnings = [];
      if (network.capacityLimited) warnings.push('source capacity is ' + (network.capacityRatio * 100).toFixed(1) + '% of demand; wetting uses an evenly capped-flow approximation and pressure is not validated');
      if (!network.capacityLimited && network.uniformity < 90) warnings.push('low-quarter distribution uniformity is below 90%');
      if (!network.capacityLimited && network.lowPressureCount) warnings.push(network.lowPressureCount + ' emitter' + (network.lowPressureCount === 1 ? ' is' : 's are') + ' below required pressure (marked red)');
      document.getElementById('water-status').textContent = warnings.length ? 'Drip design warning: ' + warnings.join('; ') + '.' : 'Drip network simulated: pressure, emitter discharge, infiltration and localized wetting are within the configured limits.';
    });
  }

  function runRainSimulation() {
    const intensity = numberValue('rain-intensity', 25);
    const duration = numberValue('rain-duration', 60);
    const soil = greenAmptSoils[document.getElementById('water-soil').value] || greenAmptSoils.loam;
    const rainDepth = intensity * duration / 60;
    waterResultSource.clear();
    clearWaterSurface();
    ['water-pipe-result-row', 'water-demand-row', 'water-pump-row', 'water-solar-row', 'water-drip-summary-row', 'water-uniformity-row'].forEach(function (id) { document.getElementById(id).hidden = true; });
    document.getElementById('water-status').textContent = 'Running Green–Ampt infiltration and 2D diffusion-wave routing…';
    return solveHydrology({ mode: 'rain', totalMinutes: duration, rainIntensity: intensity, soil: soil }).then(function (solved) {
      const infiltrated = solved.infiltratedLiters;
      const runoff = Math.max(0, solved.appliedLiters - infiltrated);
      waterSimulationState = { mode: 'rain', totalMinutes: duration, grid: buildHydrologyGrid(), snapshots: solved.snapshots, snapshotScale: solved.snapshotScale, maxPoolDepth: solved.maxDepth, infiltrationSnapshots: solved.infiltrationSnapshots, infiltrationSnapshotScale: solved.infiltrationSnapshotScale, maxInfiltrationDepth: solved.maxInfiltrationDepth };
      document.getElementById('water-timeline').hidden = false;
      setWaterTimeline(0); playWaterTimeline();
      document.getElementById('water-applied').textContent = formatVolume(solved.appliedLiters) + ' over survey (' + rainDepth.toFixed(1) + ' mm)';
      document.getElementById('water-infiltration').textContent = formatVolume(infiltrated) + ' (' + Math.round(infiltrated / Math.max(1, solved.appliedLiters) * 100) + '%)';
      document.getElementById('water-runoff').textContent = formatVolume(runoff) + ' (' + Math.round(runoff / Math.max(1, solved.appliedLiters) * 100) + '%)';
      document.getElementById('water-path').textContent = '2D diffusion wave · grid-estimated maximum depth ' + (solved.maxDepth * 100).toFixed(1) + ' cm · ' + formatVolume(solved.outflowLiters) + ' approximate outflow';
      document.getElementById('water-results').hidden = false;
      document.getElementById('water-legend').hidden = false;
      document.getElementById('water-status').textContent = 'Green–Ampt infiltration + mass-conserving 2D diffusion wave · ' + intensity + ' mm/h for ' + duration + ' min · ' + formatVolume(solved.surfaceLiters) + ' stored on surface at event end.';
    });
  }

  function simulateWater() {
    stopDrawing(); stopWaterTools();
    const status = document.getElementById('water-status');
    status.textContent = 'Loading terrain and calculating…';
    const runButton = document.getElementById('water-run');
    runButton.disabled = true;
    ensureDtm().then(function (ready) {
      if (!ready) throw new Error('Terrain data could not be loaded.');
      const mode = document.getElementById('water-mode').value;
      return mode === 'rain' ? runRainSimulation() : mode === 'drip' ? runDripSimulation() : runIrrigationSimulation();
    }).catch(function (error) {
      status.textContent = 'Simulation failed: ' + error.message;
    }).then(function () { runButton.disabled = false; });
  }

  function startWaterDraw(kind) {
    stopDrawing(); stopWaterTools();
    const isPipe = kind === 'pipe';
    if (isPipe && !waterEntrySource.getFeatures().length) {
      document.getElementById('water-status').textContent = 'Add a water entry first, then draw a pipe with either endpoint touching its yellow marker.';
      return;
    }
    const button = document.getElementById(isPipe ? 'water-pipe' : 'water-zone');
    button.classList.add('active');
    waterTool = kind;
    waterDraw = new ol.interaction.Draw({ source: isPipe ? waterPipeSource : waterZoneSource, type: isPipe ? 'LineString' : 'Polygon' });
    map.addInteraction(waterDraw);
    if (isPipe) {
      waterSnapFeatures = new ol.Collection(waterEntrySource.getFeatures().concat(waterPipeSource.getFeatures()));
      waterSnap = new ol.interaction.Snap({ features: waterSnapFeatures, pixelTolerance: 24 });
      map.addInteraction(waterSnap);
    }
    document.getElementById('water-status').textContent = isPipe ? 'Draw from or toward a yellow ENTRY marker or existing pipe, then double-click. Either direction connects.' : 'Draw the watering zone; click the first point to close.';
    waterDraw.on('drawend', function (event) {
      event.feature.set('waterType', kind);
      if (isPipe) {
        event.feature.set('pipeRole', document.getElementById('water-mode').value === 'drip' ? document.getElementById('drip-pipe-role').value : 'delivery');
        event.feature.set('pipeId', 'pipe-' + waterPipeSequence++);
        const geometry = event.feature.getGeometry();
        let coordinates = geometry.getCoordinates();
        let nearestEntry = null; let nearestPipe = null; let nearestCoordinate = null; let nearestDistance = Infinity;
        let reversePipe = false;
        [0, coordinates.length - 1].forEach(function (endpointIndex) {
          const endpoint = coordinates[endpointIndex];
          waterEntrySource.getFeatures().forEach(function (entry) {
            const distance = distanceMeters([entry.getGeometry().getCoordinates(), endpoint]);
            if (distance < nearestDistance) { nearestEntry = entry; nearestPipe = null; nearestCoordinate = entry.getGeometry().getCoordinates(); nearestDistance = distance; reversePipe = endpointIndex !== 0; }
          });
          waterPipeSource.getFeatures().forEach(function (pipeFeature) {
            if (pipeFeature === event.feature) return;
            const closest = pipeFeature.getGeometry().getClosestPoint(endpoint);
            const distance = distanceMeters([closest, endpoint]);
            if (distance < nearestDistance) { nearestEntry = null; nearestPipe = pipeFeature; nearestCoordinate = closest; nearestDistance = distance; reversePipe = endpointIndex !== 0; }
          });
        });
        if ((!nearestEntry && !nearestPipe) || nearestDistance > 8) {
          waterPipeSource.removeFeature(event.feature);
          document.getElementById('water-status').textContent = 'Pipe not added: one endpoint must touch an ENTRY marker or existing pipe. Continuous drawing is still active—try again.';
          return;
        }
        if (reversePipe) coordinates = coordinates.slice().reverse();
        coordinates[0] = nearestCoordinate.slice();
        geometry.setCoordinates(coordinates);
        event.feature.set('entryNumber', nearestEntry ? nearestEntry.get('entryNumber') : nearestPipe.get('entryNumber'));
        if (nearestPipe) {
          event.feature.set('parentPipe', nearestPipe.get('pipeId'));
          event.feature.set('parentDistance', distanceAlongCoordinates(nearestPipe.getGeometry().getCoordinates(), nearestCoordinate));
        }
        if (waterSnapFeatures) waterSnapFeatures.push(event.feature);
      }
      if (!isPipe) window.setTimeout(stopWaterTools, 0);
      document.getElementById('water-status').textContent = isPipe ? (document.getElementById('water-mode').value === 'drip' ? 'Pipe connected. Draw pipe remains active; keep drawing or change the pipe type.' : 'Pipe connected. Draw pipe remains active for more branches.') : 'Watering zone added. Simulate to size the system.';
      window.setTimeout(autoSaveWaterPlan, 0);
    });
  }

  const waterPlanStorageKey = surveyConfig.waterPlanStorageKey || 'halil-cevizlik-water-plan-v1';
  const waterPlanSettingIds = [
    'water-mode', 'water-soil', 'water-flow', 'water-flow-unit', 'water-flow-basis', 'water-duration', 'water-diameter', 'water-pressure', 'water-source-lift', 'water-depth', 'water-hours', 'pump-efficiency', 'solar-hours',
    'rain-intensity', 'rain-duration', 'drip-pipe-role', 'drip-main-diameter', 'drip-submain-diameter', 'drip-lateral-diameter', 'drip-emitter-spacing', 'drip-emitter-flow', 'drip-emitter-type', 'drip-pressure', 'drip-capacity', 'drip-source-lift', 'drip-pump-efficiency', 'drip-solar-hours', 'drip-duration', 'drip-wetting-radius', 'water-opacity'
  ];
  const waterPlanGeoJson = new ol.format.GeoJSON();
  let restoringWaterPlan = false;

  function waterSourceGeoJson(source) {
    return waterPlanGeoJson.writeFeaturesObject(source.getFeatures(), { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' });
  }

  function captureWaterPlan() {
    const settings = {};
    waterPlanSettingIds.forEach(function (id) {
      const element = document.getElementById(id);
      if (element) settings[id] = element.value;
    });
    return {
      format: 'agonyam-water-plan',
      version: 1,
      savedAt: new Date().toISOString(),
      settings: settings,
      entries: waterSourceGeoJson(waterEntrySource),
      pipes: waterSourceGeoJson(waterPipeSource),
      zones: waterSourceGeoJson(waterZoneSource)
    };
  }

  function autoSaveWaterPlan() {
    if (restoringWaterPlan) return;
    try { localStorage.setItem(waterPlanStorageKey, JSON.stringify(captureWaterPlan())); } catch (error) {}
  }

  function applyWaterPlan(plan, message) {
    if (!plan || plan.format !== 'agonyam-water-plan' || plan.version !== 1) throw new Error('Unsupported plan file.');
    restoringWaterPlan = true;
    stopWaterTools();
    waterEntrySource.clear(); waterPipeSource.clear(); waterZoneSource.clear(); waterResultSource.clear();
    clearWaterEntryOverlays(); clearWaterSurface();
    Object.keys(plan.settings || {}).forEach(function (id) {
      const element = document.getElementById(id);
      if (element) element.value = plan.settings[id];
    });
    updateWaterMode();
    const readOptions = { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' };
    waterEntrySource.addFeatures(waterPlanGeoJson.readFeatures(plan.entries || { type: 'FeatureCollection', features: [] }, readOptions));
    waterPipeSource.addFeatures(waterPlanGeoJson.readFeatures(plan.pipes || { type: 'FeatureCollection', features: [] }, readOptions));
    waterZoneSource.addFeatures(waterPlanGeoJson.readFeatures(plan.zones || { type: 'FeatureCollection', features: [] }, readOptions));
    waterEntrySource.getFeatures().forEach(addWaterEntryOverlay);
    waterPipeSequence = 1;
    waterPipeSource.getFeatures().forEach(function (pipe) {
      const match = String(pipe.get('pipeId') || '').match(/(\d+)$/);
      if (match) waterPipeSequence = Math.max(waterPipeSequence, Number(match[1]) + 1);
    });
    const waterOpacity = Number(document.getElementById('water-opacity').value);
    waterSurfaceLayer.setOpacity(waterOpacity);
    document.getElementById('water-opacity-value').textContent = Math.round(waterOpacity * 100) + '%';
    restoringWaterPlan = false;
    autoSaveWaterPlan();
    const extent = ol.extent.createEmpty();
    [waterEntrySource, waterPipeSource, waterZoneSource].forEach(function (source) {
      if (source.getFeatures().length) ol.extent.extend(extent, source.getExtent());
    });
    if (!ol.extent.isEmpty(extent)) map.getView().fit(extent, map.getSize(), { padding: [70, 350, 70, 70], maxZoom: 21 });
    document.getElementById('water-status').textContent = message || 'Plan loaded. Run Simulate to recalculate results.';
  }

  function restoreAutoSavedWaterPlan() {
    try {
      const saved = localStorage.getItem(waterPlanStorageKey);
      if (!saved) return false;
      applyWaterPlan(JSON.parse(saved), 'Autosaved plan restored. Run Simulate to recalculate results.');
      return true;
    } catch (error) {
      localStorage.removeItem(waterPlanStorageKey);
      return false;
    }
  }

  function downloadWaterPlan() {
    const plan = captureWaterPlan();
    autoSaveWaterPlan();
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = surveySlug + '-irrigation-plan-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    document.getElementById('water-status').textContent = 'Plan saved to a JSON file and autosaved in this browser.';
  }

  function updateWaterMode() {
    stopWaterTools();
    const mode = document.getElementById('water-mode').value;
    const rain = mode === 'rain';
    const drip = mode === 'drip';
    waterResultSource.clear();
    clearWaterSurface();
    document.getElementById('water-results').hidden = true;
    document.getElementById('water-legend').hidden = true;
    document.getElementById('water-irrigation-fields').hidden = rain || drip;
    document.getElementById('water-rain-fields').hidden = !rain;
    document.getElementById('water-drip-fields').hidden = !drip;
    ['water-place', 'water-pipe', 'water-erase', 'water-zone'].forEach(function (id) { document.getElementById(id).hidden = rain; });
    ['water-drip-summary-row', 'water-uniformity-row'].forEach(function (id) { document.getElementById(id).hidden = true; });
    document.getElementById('water-wetting-key').hidden = !drip;
    document.getElementById('water-infiltration-key').hidden = drip;
    document.getElementById('water-status').textContent = rain ? 'Set the rain event and simulate terrain runoff.' : drip ? 'Add an entry, then draw mainline, submain and dripline pipes.' : 'Add entry points and pipe routes, or draw a watering zone.';
  }

  document.getElementById('water-mode').addEventListener('change', updateWaterMode);
  waterPlanSettingIds.forEach(function (id) {
    const element = document.getElementById(id);
    if (element) {
      element.addEventListener('input', autoSaveWaterPlan);
      element.addEventListener('change', autoSaveWaterPlan);
    }
  });
  document.getElementById('water-save').addEventListener('click', downloadWaterPlan);
  document.getElementById('water-load').addEventListener('click', function () { document.getElementById('water-plan-file').click(); });
  document.getElementById('water-plan-file').addEventListener('change', function (event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      try { applyWaterPlan(JSON.parse(reader.result), 'Plan loaded and autosaved. Run Simulate to recalculate results.'); }
      catch (error) { document.getElementById('water-status').textContent = 'Plan could not be loaded: ' + error.message; }
      event.target.value = '';
    };
    reader.readAsText(file);
  });
  document.getElementById('water-place').addEventListener('click', function () {
    if (waterTool === 'entry') {
      stopWaterTools();
      document.getElementById('water-status').textContent = waterEntrySource.getFeatures().length + ' water entr' + (waterEntrySource.getFeatures().length === 1 ? 'y' : 'ies') + ' ready.';
      return;
    }
    stopDrawing(); stopWaterTools();
    const button = document.getElementById('water-place');
    button.classList.add('active');
    waterTool = 'entry';
    map.getTargetElement().style.cursor = 'crosshair';
    document.getElementById('water-status').textContent = 'Click the map to add water entry points; click the button again to finish.';
  });
  document.getElementById('water-pipe').addEventListener('click', function () {
    if (waterTool === 'pipe') {
      stopWaterTools();
      document.getElementById('water-status').textContent = 'Pipe drawing finished. Simulate now or select Draw pipe to add more.';
      return;
    }
    startWaterDraw('pipe');
  });
  document.getElementById('water-erase').addEventListener('click', function () {
    if (waterTool === 'erase') { stopWaterTools(); document.getElementById('water-status').textContent = 'Pipe eraser closed.'; return; }
    stopDrawing(); stopWaterTools();
    waterTool = 'erase';
    document.getElementById('water-erase').classList.add('active');
    map.getTargetElement().style.cursor = 'crosshair';
    document.getElementById('water-status').textContent = 'Click a pipe to remove it and any downstream branches.';
  });
  document.getElementById('water-zone').addEventListener('click', function () { startWaterDraw('zone'); });
  document.getElementById('water-run').addEventListener('click', simulateWater);
  document.getElementById('water-opacity').addEventListener('input', function (event) {
    const opacity = Number(event.target.value);
    waterSurfaceLayer.setOpacity(opacity);
    document.getElementById('water-opacity-value').textContent = Math.round(opacity * 100) + '%';
  });
  document.getElementById('water-play').addEventListener('click', playWaterTimeline);
  document.getElementById('water-time').addEventListener('input', function (event) {
    stopWaterAnimation();
    renderWaterTimeline(Number(event.target.value) / 100);
  });
  document.getElementById('water-clear').addEventListener('click', function () {
    stopWaterTools();
    waterEntrySource.clear(); waterPipeSource.clear(); waterZoneSource.clear(); waterResultSource.clear();
    clearWaterEntryOverlays();
    clearWaterSurface();
    document.getElementById('water-legend').hidden = true;
    document.getElementById('water-results').hidden = true;
    localStorage.removeItem(waterPlanStorageKey);
    document.getElementById('water-status').textContent = 'Plan cleared. Add entry points and pipe routes, or choose rainfall.';
  });
  map.on('singleclick', function (event) {
    if (waterTool === 'erase') {
      const pipe = map.forEachFeatureAtPixel(event.pixel, function (feature, layer) { return layer === waterPipeLayer ? feature : null; }, { hitTolerance: 8 });
      if (!pipe) { document.getElementById('water-status').textContent = 'No pipe selected. Click directly on a pipe segment.'; return; }
      const removeIds = new Set([pipe.get('pipeId')]);
      let changed = true;
      while (changed) {
        changed = false;
        waterPipeSource.getFeatures().forEach(function (candidate) {
          if (removeIds.has(candidate.get('parentPipe')) && !removeIds.has(candidate.get('pipeId'))) { removeIds.add(candidate.get('pipeId')); changed = true; }
        });
      }
      const removed = waterPipeSource.getFeatures().filter(function (candidate) { return removeIds.has(candidate.get('pipeId')); });
      removed.forEach(function (candidate) { waterPipeSource.removeFeature(candidate); });
      clearWaterSurface();
      document.getElementById('water-results').hidden = true;
      document.getElementById('water-legend').hidden = true;
      autoSaveWaterPlan();
      document.getElementById('water-status').textContent = removed.length + ' pipe segment' + (removed.length === 1 ? '' : 's') + ' removed.';
      return;
    }
    if (waterTool !== 'entry') return;
    const feature = new ol.Feature(new ol.geom.Point(event.coordinate));
    feature.set('entryNumber', waterEntrySource.getFeatures().length + 1);
    waterEntrySource.addFeature(feature);
    addWaterEntryOverlay(feature);
    autoSaveWaterPlan();
    document.getElementById('water-status').textContent = waterEntrySource.getFeatures().length + ' water entr' + (waterEntrySource.getFeatures().length === 1 ? 'y' : 'ies') + ' added.';
  });
  waterSurfaceLayer.setOpacity(Number(document.getElementById('water-opacity').value));
  if (!restoreAutoSavedWaterPlan()) updateWaterMode();

  function refreshQuickButtons() {
    document.querySelectorAll('[data-map-quick]').forEach(function (button) {
      const name = button.dataset.mapQuick;
      const visible = name === 'dtm' || name === 'dsm' ? elevationLayer.getVisible() && elevationActive === name : layers[name].getVisible();
      button.classList.toggle('active', visible);
    });
  }
  document.querySelectorAll('[data-map-layer]').forEach(function (checkbox) {
    checkbox.addEventListener('change', function () {
      const name = checkbox.dataset.mapLayer;
      if (name === 'dtm' || name === 'dsm') {
        document.querySelector('[data-map-layer="' + (name === 'dtm' ? 'dsm' : 'dtm') + '"]').checked = false;
        if (checkbox.checked) loadElevation(name);
        else {
          elevationLayer.setVisible(false);
          elevationControls.hidden = true;
        }
      } else layers[name].setVisible(checkbox.checked);
      refreshQuickButtons();
    });
  });
  const contoursCheckbox = document.querySelector('[data-map-layer="contours"]');
  if (contoursCheckbox && contoursCheckbox.parentElement && contoursCheckbox.parentElement.after) {
    if (contoursCheckbox.nextSibling && contoursCheckbox.nextSibling.nodeType === 3) contoursCheckbox.nextSibling.textContent = ' Contours';
    const intervalLabel = document.createElement('label');
    intervalLabel.className = 'contour-interval';
    intervalLabel.textContent = 'Interval ';
    const intervalInput = document.createElement('input');
    intervalInput.id = 'contour-interval';
    intervalInput.type = 'number';
    intervalInput.min = '0.1';
    intervalInput.max = '10';
    intervalInput.step = '0.1';
    intervalInput.value = '1';
    intervalInput.setAttribute('aria-label', 'Contour interval in meters');
    intervalLabel.appendChild(intervalInput);
    contoursCheckbox.parentElement.after(intervalLabel);
    const contourStatusLine = document.createElement('div');
    contourStatusLine.id = 'contour-status';
    contourStatusLine.className = 'elevation-status';
    intervalLabel.after(contourStatusLine);
    let contourDebounce = null;
    intervalInput.addEventListener('change', function () {
      let value = Number(intervalInput.value);
      if (!Number.isFinite(value)) value = 1;
      value = Math.max(0.1, Math.min(10, value));
      intervalInput.value = value;
      contourInterval = value;
      window.clearTimeout(contourDebounce);
      contourDebounce = window.setTimeout(requestContours, 400);
    });
    contoursCheckbox.addEventListener('change', function () {
      layers.contourLabels.setVisible(contoursCheckbox.checked);
      if (contoursCheckbox.checked) requestContours();
    });
  }
  document.querySelectorAll('[data-map-quick]').forEach(function (button) {
    button.addEventListener('click', function () {
      ['orthophoto', 'plant-health', 'dsm', 'dtm'].forEach(function (name) {
        const visible = name === button.dataset.mapQuick;
        if (name !== 'dtm' && name !== 'dsm') layers[name].setVisible(visible);
        const checkbox = document.querySelector('[data-map-layer="' + name + '"]');
        if (checkbox) checkbox.checked = visible;
      });
      if (button.dataset.mapQuick === 'dtm' || button.dataset.mapQuick === 'dsm') loadElevation(button.dataset.mapQuick);
      else {
        elevationLayer.setVisible(false);
        elevationControls.hidden = true;
      }
      refreshQuickButtons();
    });
  });
  refreshQuickButtons();
  document.querySelectorAll('[data-map-tool]').forEach(function (button) {
    button.addEventListener('click', function () { startDrawing(button.dataset.mapTool, button); });
  });
  document.getElementById('map-opacity').addEventListener('input', function (event) {
    const opacity = Number(event.target.value);
    ['orthophoto', 'plant-health'].forEach(function (name) { layers[name].setOpacity(opacity); });
    elevationLayer.setOpacity(opacity);
    if (waterSimulationState) waterTerrainOpacity = opacity;
  });

  ['min', 'max'].forEach(function (key) {
    document.getElementById('elevation-' + key).addEventListener('change', function (event) {
      if (!elevationActive || !elevationMetadata) return;
      const meta = elevationMetadata[elevationActive];
      const other = key === 'min' ? 'max' : 'min';
      let value = Number(event.target.value);
      value = Math.max(meta.min, Math.min(meta.max, value));
      if (key === 'min') value = Math.min(value, elevationRanges[elevationActive][other] - .001);
      else value = Math.max(value, elevationRanges[elevationActive][other] + .001);
      elevationRanges[elevationActive][key] = value;
      updateRangeUi();
      renderElevation();
    });
  });
  document.getElementById('elevation-color').addEventListener('change', function (event) {
    elevationStyle.color = event.target.value;
    drawHistogram();
    renderElevation();
  });
  document.getElementById('elevation-shading').addEventListener('change', function (event) {
    elevationStyle.shading = event.target.value;
    reloadHillshade();
  });
  let histogramHandle = null;
  function histogramValue(event) {
    const meta = elevationMetadata[elevationActive];
    const bounds = histogramCanvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left));
    return meta.min + x / bounds.width * (meta.max - meta.min);
  }
  histogramCanvas.addEventListener('pointerdown', function (event) {
    if (!elevationActive || !elevationMetadata) return;
    const value = histogramValue(event);
    const range = elevationRanges[elevationActive];
    histogramHandle = Math.abs(value - range.min) <= Math.abs(value - range.max) ? 'min' : 'max';
    histogramCanvas.setPointerCapture(event.pointerId);
    if (histogramHandle === 'min') range.min = Math.min(value, range.max - .001);
    else range.max = Math.max(value, range.min + .001);
    updateRangeUi();
  });
  histogramCanvas.addEventListener('pointermove', function (event) {
    if (!histogramHandle || !elevationActive) return;
    const range = elevationRanges[elevationActive];
    let value = histogramValue(event);
    if (histogramHandle === 'min') value = Math.min(value, range.max - .001);
    else value = Math.max(value, range.min + .001);
    range[histogramHandle] = value;
    updateRangeUi();
  });
  function finishHistogramDrag() {
    if (!histogramHandle) return;
    histogramHandle = null;
    renderElevation();
  }
  histogramCanvas.addEventListener('pointerup', finishHistogramDrag);
  histogramCanvas.addEventListener('pointercancel', finishHistogramDrag);
  document.getElementById('map-fit').addEventListener('click', function () {
    map.getView().fit(surveyExtent, map.getSize(), { padding: mapFitPadding(), maxZoom: 21 });
  });
  document.getElementById('map-fullscreen').addEventListener('click', function () {
    if (!document.fullscreenElement) mapViewElement.requestFullscreen();
    else document.exitFullscreen();
  });
  document.getElementById('map-location').addEventListener('click', function () {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(function (position) {
      const coordinate = ol.proj.fromLonLat([position.coords.longitude, position.coords.latitude]);
      locationSource.clear();
      locationSource.addFeature(new ol.Feature(new ol.geom.Point(coordinate)));
      map.getView().setCenter(coordinate);
      map.getView().setZoom(20);
    });
  });
  map.on('pointermove', function (event) {
    const lonLat = ol.proj.toLonLat(event.coordinate);
    const utm = toUtm(event.coordinate);
    coordinateReadout.textContent = lonLat[1].toFixed(6) + ', ' + lonLat[0].toFixed(6) + ' · E ' + utm[0].toFixed(1) + ' N ' + utm[1].toFixed(1);
  });
  document.getElementById('map-geojson').addEventListener('change', function (event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      try {
        importedSource.clear();
        importedSource.addFeatures(new ol.format.GeoJSON().readFeatures(JSON.parse(reader.result), { featureProjection: 'EPSG:3857' }));
        map.getView().fit(importedSource.getExtent(), map.getSize(), { padding: mapFitPadding() });
      } catch (error) {
        window.alert('This GeoJSON file could not be read.');
      }
    };
    reader.readAsText(file);
  });
  document.getElementById('map-share').addEventListener('click', function () {
    const url = location.origin + location.pathname + '?view=2d';
    if (navigator.share) navigator.share({ title: document.title, url: url }).catch(function () {});
    else navigator.clipboard.writeText(url);
  });

  function showMap() {
    if (window.setSurvey3dActive) window.setSurvey3dActive(false);
    if (window.innerWidth <= 600) setMapToolsOpen(false);
    document.body.classList.remove('mobile-3d-sidebar-open');
    document.querySelector('.model-view').classList.add('map-active');
    mapViewElement.hidden = false;
    history.replaceState(null, '', location.pathname + '?view=2d');
    setTimeout(function () {
      map.updateSize();
  map.getView().fit(surveyExtent, map.getSize(), { padding: mapFitPadding(), maxZoom: 21 });
    }, 0);
  }
  function show3d() {
    stopDrawing();
    stopWaterAnimation();
    mapViewElement.hidden = true;
    document.querySelector('.model-view').classList.remove('map-active');
    setMapToolsOpen(false);
    if (window.innerWidth <= 600) document.body.classList.remove('mobile-3d-sidebar-open');
    if (window.setSurvey3dActive) window.setSurvey3dActive(true);
    history.replaceState(null, '', location.pathname);
  }

  document.getElementById('mode-2d').addEventListener('click', showMap);
  document.getElementById('mode-3d').addEventListener('click', show3d);
  if (new URLSearchParams(location.search).get('view') === '2d') showMap();
})();
