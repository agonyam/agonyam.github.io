"""Generate web-optimized map assets for one survey location.

Usage: python3 gen.py <slug> <in_dir> <out_dir>
  - in_dir holds dtm.tif, dsm.tif, odm_orthophoto.tif (EPSG:32635),
    plus optionally the task's odm_georeferencing/coords.txt
 - out_dir receives:
   dtm/dsm-elevation.png (packed R*256+G encoding, <=3000px)
   dtm/dsm-hillshade-{normal,extruded}.png (grayscale)
   orthophoto/{z}/{x}/{y}.png + plant-health/{z}/{x}/{y}.png (XYZ, z15..22)
   contours-wgs84.geojson (1 m, CRS84)
   elevation.json, meta.json (extent/area/gsd for SURVEY_CONFIG)
"""
import json
import math
import os
import sys

import numpy as np
from osgeo import gdal, osr
from PIL import Image

gdal.UseExceptions()

slug, in_dir, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out_dir, exist_ok=True)
MAXEDGE = int(os.environ.get("MAXEDGE", "3000"))
ZMIN, ZMAX = 15, 22

meta = {}


def save_png(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)


def src_srs(ds):
    s = osr.SpatialReference(wkt=ds.GetProjection())
    return s


def to_srs(s_from, s_to, xs, ys):
    t = osr.CoordinateTransformation(s_from, s_to)
    return t.TransformPoints(list(zip(xs, ys)))


def process_dem(name):
    small = os.path.join(out_dir, name + '_small.tif')
    ds = gdal.Open(os.path.join(in_dir, name + '.tif'))
    w, h = ds.RasterXSize, ds.RasterYSize
    nd = ds.GetRasterBand(1).GetNoDataValue()
    scale_f = min(1.0, MAXEDGE / max(w, h))
    nw, nh = max(1, round(w * scale_f)), max(1, round(h * scale_f))
    gdal.Warp(small, ds, width=nw, height=nh, resampleAlg='bilinear',
              srcNodata=nd if nd is not None else None, dstNodata=-9999.0)
    ds = gdal.Open(small)
    arr = ds.GetRasterBand(1).ReadAsArray().astype(np.float32)
    mask = np.isfinite(arr) & (arr > -9998.0)
    valid = arr[mask]
    mn, mx = float(valid.min()), float(valid.max())
    offset = math.floor(mn)
    quant = 0.01
    packed = np.clip(np.round((arr - offset) / quant), 0, 65535).astype(np.uint32)
    rgba = np.zeros((nh, nw, 4), np.uint8)
    rgba[..., 0] = ((packed >> 8) & 255).astype(np.uint8)
    rgba[..., 1] = (packed & 255).astype(np.uint8)
    rgba[..., 3] = np.where(mask, 255, 0).astype(np.uint8)
    Image.fromarray(rgba, 'RGBA').save(os.path.join(out_dir, name + '-elevation.png'), optimize=True)
    for tag, z in (('normal', 1.0), ('extruded', 2.0)):
        gdal.DEMProcessing(os.path.join(out_dir, '%s-hillshade-%s.png' % (name, tag)),
                           small, 'hillshade', format='PNG', zFactor=z, azimuth=315, altitude=45)
    edges = np.linspace(mn, mx, 257)
    hist, _ = np.histogram(valid, bins=edges)
    cellw = abs(ds.GetGeoTransform()[1])
    cellh = abs(ds.GetGeoTransform()[5])
    meta[name] = {
        'width': nw, 'height': nh, 'offset': offset, 'scale': quant,
        'min': mn, 'max': mx,
        'percentiles': {str(p): float(np.percentile(valid, p)) for p in (2, 5, 95, 98)},
        'histogramEdges': edges.tolist(),
        'histogram': [int(x) for x in hist],
    }
    src = src_srs(ds)
    gt2 = ds.GetGeoTransform()
    xs = [gt2[0] + px * gt2[1] + py * gt2[2] for px, py in ((0, 0), (nw, 0), (nw, nh), (0, nh))]
    ys = [gt2[3] + px * gt2[4] + py * gt2[5] for px, py in ((0, 0), (nw, 0), (nw, nh), (0, nh))]
    t4326 = osr.SpatialReference(); t4326.ImportFromEPSG(4326); t4326.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    s4326 = src.CloneGeogCS(); s4326.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    lons = [p[0] for p in to_srs(src, t4326, xs, ys)]
    lats = [p[1] for p in to_srs(src, t4326, xs, ys)]
    ext = [min(lons), min(lats), max(lons), max(lats)]
    gsd = math.sqrt(cellw * cellh)
    area = float(mask.sum()) * cellw * cellh
    return ext, gsd, area


def merc_y(lat_deg, n):
    lat = math.radians(max(min(lat_deg, 85.05112878), -85.05112878))
    return (0.5 - math.log(math.tan(math.pi / 4 + lat / 2)) / (2 * math.pi)) * n


def process_ortho():
    path = os.path.join(in_dir, 'odm_orthophoto.tif')
    ds = gdal.Open(path)
    src = src_srs(ds)
    t3857 = osr.SpatialReference(); t3857.ImportFromEPSG(3857); t3857.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    t4326 = osr.SpatialReference(); t4326.ImportFromEPSG(4326); t4326.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    w, h = ds.RasterXSize, ds.RasterYSize
    gt = ds.GetGeoTransform()
    gsd = gt[1]
    corners_x = [gt[0], gt[0] + w * gt[1], gt[0] + w * gt[1] + h * gt[2], gt[0] + h * gt[2]]
    corners_y = [gt[3], gt[3] + w * gt[4], gt[3] + w * gt[4] + h * gt[5], gt[3] + h * gt[5]]
    p4326 = to_srs(src, t4326, corners_x, corners_y)
    lons = [p[0] for p in p4326]
    lats = [p[1] for p in p4326]
    minlon, maxlon = min(lons), max(lons)
    minlat, maxlat = min(lats), max(lats)
    lat_mid = (minlat + maxlat) / 2
    bands = ds.RasterCount
    n_tiles = 0
    for z in range(ZMIN, ZMAX + 1):
        span = 40075016.686 / (2 ** z)
        n = 2 ** z
        tx0 = int(math.floor((minlon + 180) / 360 * n))
        tx1 = int(math.floor((maxlon + 180) / 360 * n))
        ty0 = int(math.floor(merc_y(maxlat, n)))
        ty1 = int(math.floor(merc_y(minlat, n)))
        for tx in range(tx0, tx1 + 1):
            for ty in range(ty0, ty1 + 1):
                x0m = tx * span - 20037508.343
                x1m = (tx + 1) * span - 20037508.343
                y0m = 20037508.343 - (ty + 1) * span
                y1m = 20037508.343 - ty * span
                mem = gdal.Warp('', ds, format='MEM', dstSRS='EPSG:3857',
                                outputBounds=(x0m, y0m, x1m, y1m), width=256, height=256,
                                resampleAlg=gdal.GRA_Bilinear)
                arr = mem.ReadAsArray()
                if arr.ndim == 2:
                    arr = arr[None, ...]
                if arr.shape[0] >= 4:
                    alpha = arr[3]
                else:
                    alpha = np.full((256, 256), 255, np.uint8)
                if not (alpha > 0).any():
                    continue
                out = np.dstack([arr[0], arr[1], arr[2], alpha]) if bands >= 3 else None
                if out is None:
                    continue
                save_png(Image.fromarray(out, 'RGBA'), os.path.join(out_dir, 'orthophoto', str(z), str(tx), str(ty) + '.png'))
                # plant health VARI
                r = arr[0].astype(np.float32); g = arr[1].astype(np.float32); b = arr[2].astype(np.float32)
                valid = alpha > 0
                vari = (g - r) / (g + r - b + 1e-3)
                vari = np.clip(vari, -1, 1)
                tpos = (vari + 1) / 2
                ph = np.zeros((256, 256, 4), np.uint8)
                ph[..., 0] = (220 - 180 * tpos).astype(np.uint8)
                ph[..., 1] = (60 + 110 * tpos).astype(np.uint8)
                ph[..., 2] = (40 + 30 * tpos).astype(np.uint8)
                ph[..., 3] = np.where(valid, 215, 0).astype(np.uint8)
                save_png(Image.fromarray(ph, 'RGBA'), os.path.join(out_dir, 'plant-health', str(z), str(tx), str(ty) + '.png'))
                n_tiles += 1
    print('ortho tiles written:', n_tiles)


def process_contours():
    small = os.path.join(out_dir, 'dtm_small.tif')
    raw = os.path.join(out_dir, 'contours_32635.geojson')
    os.system('gdal_contour -a elevation -i 1.0 "%s" "%s" -f GeoJSON' % (small, raw))
    ds = gdal.Open(small)
    src = src_srs(ds)
    t4326 = osr.SpatialReference(); t4326.ImportFromEPSG(4326); t4326.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    gj = json.load(open(raw))
    feats = []
    for i, f in enumerate(gj['features']):
        coords = to_srs(src, t4326, [c[0] for c in f['geometry']['coordinates']], [c[1] for c in f['geometry']['coordinates']])
        feats.append({
            'type': 'Feature',
            'properties': {'ID': i, 'elevation': float(f['properties']['elevation'])},
            'geometry': {'type': 'LineString', 'coordinates': [[round(p[0], 7), round(p[1], 7)] for p in coords]},
        })
    out = {'type': 'FeatureCollection', 'name': 'contour',
           'crs': {'type': 'name', 'properties': {'name': 'urn:ogc:def:crs:OGC:1.3:CRS84'}},
           'features': feats}
    json.dump(out, open(os.path.join(out_dir, 'contours-wgs84.geojson'), 'w'))
    os.remove(raw)
    print('contour features:', len(feats))


ext, gsd, area = process_dem('dtm')
process_dem('dsm')
ogs = gdal.Open(os.path.join(in_dir, 'odm_orthophoto.tif')).GetGeoTransform()[1]
json.dump(meta, open(os.path.join(out_dir, 'elevation.json'), 'w'))

for d in ('orthophoto', 'plant-health'):
    base = os.path.join(out_dir, d)
    for z in range(ZMIN, ZMAX + 1):
        os.makedirs(os.path.join(base, str(z)), exist_ok=True)

process_ortho()
process_contours()

def read_model_offset():
    # Exact ODM georeferencing offset for the textured model (odm/location.py:
    # floor of the mean photo GPS). Second line of coords.txt: "easting northing".
    for name in ('coords.txt', 'odm_georeferencing/coords.txt'):
        path = os.path.join(in_dir, name)
        if os.path.isfile(path):
            try:
                with open(path) as f:
                    lines = [line.strip() for line in f if line.strip()]
                x, y = map(float, lines[1].split()[:2])
                return [int(x) if x.is_integer() else x, int(y) if y.is_integer() else y]
            except (IndexError, ValueError):
                return None
    return None

meta_json = {'extent4326': ext, 'gsdMeters': ogs, 'areaSquareMeters': area}
model_offset = read_model_offset()
if model_offset is not None:
    meta_json['modelOffset'] = model_offset
json.dump(meta_json, open(os.path.join(out_dir, 'meta.json'), 'w'))
print('DONE', slug, '| extent', [round(v, 6) for v in ext], '| gsd', round(gsd, 4), '| area', round(area, 1),
      '| modelOffset', model_offset)
