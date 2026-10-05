/* On-the-fly contour generation for the Agonyam 2D map.
 *
 * Marching squares over a downsampled DTM grid. Emits one segment soup per
 * elevation level in EPSG:3857 map coordinates; the main thread wraps each
 * level in a MultiLineString feature. Runs off the main thread, mirroring
 * hydrology-worker.js so the map stays responsive during generation.
 */
(function () {
  'use strict';

  self.onmessage = function (event) {
    const input = event.data;
    try {
      const levels = generateContours(input);
      const transfers = levels.map(function (level) { return level.coords.buffer; });
      self.postMessage({ levels: levels }, transfers);
    } catch (error) {
      self.postMessage({ error: String((error && error.message) || error) });
    }
  };

  function generateContours(input) {
    const width = input.width;
    const height = input.height;
    const elev = new Float32Array(input.elev);
    const valid = new Uint8Array(input.valid);
    const interval = input.interval;
    const extent = input.extent;
    const cellW = (extent[2] - extent[0]) / width;
    const cellH = (extent[3] - extent[1]) / height;
    const byLevel = new Map();

    function mapX(gx) { return extent[0] + gx * cellW; }
    function mapY(gy) { return extent[3] - gy * cellH; }

    function levelEntry(k) {
      let entry = byLevel.get(k);
      if (!entry) {
        entry = { e: Number((k * interval).toFixed(3)), parts: [] };
        byLevel.set(k, entry);
      }
      return entry;
    }

    function traceCell(i, j, a, b, c, d, level, parts) {
      const index = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
      if (index === 0 || index === 15) return;
      const tT = { x: i + (level - a) / (b - a), y: j };
      const tR = { x: i + 1, y: j + (level - b) / (c - b) };
      const tB = { x: i + (level - d) / (c - d), y: j + 1 };
      const tL = { x: i, y: j + (level - a) / (d - a) };
      function seg(p, q) {
        parts.push(mapX(p.x), mapY(p.y), mapX(q.x), mapY(q.y));
      }
      switch (index) {
        case 1: case 14: seg(tL, tB); break;
        case 2: case 13: seg(tB, tR); break;
        case 3: case 12: seg(tL, tR); break;
        case 4: case 11: seg(tT, tR); break;
        case 6: case 9: seg(tT, tB); break;
        case 7: case 8: seg(tT, tL); break;
        case 5: {
          const center = (a + b + c + d) / 4;
          if (center > level) { seg(tT, tL); seg(tR, tB); }
          else { seg(tT, tR); seg(tL, tB); }
          break;
        }
        case 10: {
          const center = (a + b + c + d) / 4;
          if (center > level) { seg(tT, tR); seg(tL, tB); }
          else { seg(tT, tL); seg(tR, tB); }
          break;
        }
      }
    }

    for (let j = 0; j < height - 1; j += 1) {
      for (let i = 0; i < width - 1; i += 1) {
        const a = elev[j * width + i];
        const b = elev[j * width + i + 1];
        const c = elev[(j + 1) * width + i + 1];
        const d = elev[(j + 1) * width + i];
        if (a !== a || b !== b || c !== c || d !== d) continue;
        if (!valid[j * width + i] || !valid[j * width + i + 1] ||
            !valid[(j + 1) * width + i + 1] || !valid[(j + 1) * width + i]) continue;
        const lo = Math.min(a, b, c, d);
        const hi = Math.max(a, b, c, d);
        if (!(hi > lo)) continue;
        const kStart = Math.ceil(lo / interval - 1e-9);
        const kEnd = Math.floor(hi / interval + 1e-9);
        for (let k = kStart; k <= kEnd; k += 1) {
          traceCell(i, j, a, b, c, d, k * interval, levelEntry(k).parts);
        }
      }
    }

    const levels = [];
    byLevel.forEach(function (entry) {
      if (entry.parts.length) levels.push({ e: entry.e, coords: new Float32Array(entry.parts) });
    });
    levels.sort(function (p, q) { return p.e - q.e; });
    return levels;
  }
})();
