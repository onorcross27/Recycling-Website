// This file sets up an Express server that serves a static frontend and provides an API endpoint for searching nearby recycling locations using the Overpass API. It includes a simple in-memory cache and a local fallback dataset for resilience.

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Simple in-memory cache with TTL and max-size eviction (FIFO)
class SimpleCache {
  constructor(max = 500) {
    this.max = max;
    this.map = new Map();
  }
  has(key) {
    const entry = this.map.get(key);
    if (!entry) return false;
    if (Date.now() > entry.exp) {
      this.map.delete(key);
      return false;
    }
    return true;
  }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.exp) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }
  set(key, value, ttl = 1000 * 60 * 60) {
    while (this.map.size >= this.max) {
      const first = this.map.keys().next().value;
      this.map.delete(first);
    }
    this.map.set(key, { value, exp: Date.now() + ttl });
  }
}

const cache = new SimpleCache(500);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Preload fallback dataset
let FALLBACK = [];
try {
  const raw = fs.readFileSync(path.join(__dirname, 'fallback.json'), 'utf8');
  const parsed = JSON.parse(raw);
  FALLBACK = parsed.map(elementToFeature).filter(Boolean);
} catch (e) { FALLBACK = []; }

function buildFullOverpassQuery(lat, lon, radius) {
  return `[out:json][timeout:25];\n(\n    node["amenity"="recycling"](around:${radius},${lat},${lon});\n    way["amenity"="recycling"](around:${radius},${lat},${lon});\n    relation["amenity"="recycling"](around:${radius},${lat},${lon});\n    node[~"^recycling"~"."](around:${radius},${lat},${lon});\n    way[~"^recycling"~"."](around:${radius},${lat},${lon});\n    relation[~"^recycling"~"."](around:${radius},${lat},${lon});\n  );\n  out center;`;
}

function buildLightOverpassQuery(lat, lon, radius) {
  // Lightweight: only nearby nodes with amenity=recycling, smaller timeout
  return `[out:json][timeout:10];\n(\n    node["amenity"="recycling"](around:${radius},${lat},${lon});\n    node[~"^recycling"~"."](around:${radius},${lat},${lon});\n  );\n  out;`;
}

function elementToFeature(el) {
  const lat = el.lat || (el.center && el.center.lat);
  const lon = el.lon || (el.center && el.center.lon);
  return {
    id: `${el.type}/${el.id}`,
    type: el.type,
    lat,
    lon,
    tags: el.tags || {},
  };
}

app.get('/api/search', async (req, res) => {
  const { lat, lon, radius = 20000, material } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

  const key = JSON.stringify({ lat, lon, radius, material });
  if (cache.has(key)) return res.json({ cached: true, results: cache.get(key) });
  // Quick local fallback: if our tiny dataset has nearby results, return immediately
  try {
    const latNum = Number(lat);
    const lonNum = Number(lon);
    const rad = Number(radius);
    function haversine(aLat, aLon, bLat, bLon) {
      const R = 6371000;
      const toRad = x => x * Math.PI / 180;
      const dLat = toRad(bLat - aLat);
      const dLon = toRad(bLon - aLon);
      const al = toRad(aLat);
      const bl = toRad(bLat);
      const h = Math.sin(dLat/2)**2 + Math.cos(al)*Math.cos(bl)*Math.sin(dLon/2)**2;
      return 2 * R * Math.asin(Math.sqrt(h));
    }
    const nearby = (FALLBACK || []).filter(f => f.lat && f.lon && haversine(latNum, lonNum, f.lat, f.lon) <= rad);
    const filteredNearby = material
      ? nearby.filter(e => {
          const m = String(material).toLowerCase();
          const tags = e.tags || {};
          return Object.entries(tags).some(([k, v]) => (k + ':' + v).toLowerCase().includes(m) || k.toLowerCase().includes(m) || String(v).toLowerCase().includes(m));
        })
      : nearby;
    if (filteredNearby && filteredNearby.length) {
      cache.set(key, filteredNearby);
      return res.json({ cached: false, results: filteredNearby, source: 'fallback' });
    }
  } catch (e) { console.warn('fallback check failed', e.message || e); }

  // First try a lightweight query (nodes-only, short timeout) to return quick results
  try {
    const endpoints = [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.openstreetmap.fr/api/interpreter',
      'https://lz4.overpass-api.de/api/interpreter'
    ];

    const lightQ = buildLightOverpassQuery(lat, lon, radius);
    let data = null;
    for (const ep of endpoints) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 7000);
        const response = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(lightQ)}`,
          signal: controller.signal
        });
        clearTimeout(timeout);
        if (!response.ok) {
          const txt = await response.text();
          console.warn(`ep ${ep} returned ${response.status}`);
          continue;
        }
        data = await response.json();
        break;
      } catch (e) {
        console.warn('endpoint failed:', ep, e.message || e);
        continue;
      }
    }
    let elems = (data && data.elements ? data.elements : []).map(elementToFeature);

    // If lightweight returned few results, run the full query (broader but slower)
    if (elems.length < 3) {
      // try full query across endpoints with longer timeout
      const fullQ = buildFullOverpassQuery(lat, lon, radius);
      for (const ep of endpoints) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);
          const response = await fetch(ep, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `data=${encodeURIComponent(fullQ)}`,
            signal: controller.signal
          });
          clearTimeout(timeout);
          if (!response.ok) { continue; }
          const d = await response.json();
          elems = (d.elements || []).map(elementToFeature);
          break;
        } catch (e) {
          console.warn('full query endpoint failed:', ep, e.message || e);
          continue;
        }
      }
    }

    const filtered = material 
      ? elems.filter(e => {
          const m = String(material).toLowerCase();
          const tags = e.tags || {};
          return Object.entries(tags).some(([k, v]) => (k + ':' + v).toLowerCase().includes(m) || k.toLowerCase().includes(m) || String(v).toLowerCase().includes(m));
        })
      : elems;

    // If no results from Overpass, use preloaded tiny local fallback dataset
    let results = (filtered && filtered.length) ? filtered : [];
    if (results.length === 0) {
      results = FALLBACK.slice();
    }

    cache.set(key, results);
    res.json({ cached: false, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'upstream error' });
  }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
