//this file manages the interface for the website by creating the map, getting the users location, and locating recycling locations

(function ensureCorrectCodespaceHost() {
  try {
    const loc = window.location;
    const match = loc.hostname.match(/^(.*)-(\d+)\.app\.github\.dev$/);
    if (match && match[2] !== '3000') {
      const targetHost = `${match[1]}-3000.app.github.dev`;
      if (loc.hostname !== targetHost) {
        window.location.replace(`${loc.protocol}//${targetHost}/`);
      }
    }
  } catch (e) {
    // ignore redirect failures
  }
})();

let map = L.map('map', { zoomControl: false }).setView([52, 0], 6);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const materialEl = document.getElementById('material');
const radiusEl = document.getElementById('radius');
const findBtn = document.getElementById('find');
const radiusHelp = document.getElementById('radius-help');
const statusEl = document.getElementById('status');
const errorDumpEl = document.getElementById('errorDump');

let markers = L.layerGroup().addTo(map);
let youMarker = null;
const loadingEl = document.getElementById('loading');

function setStatus(message) {
  statusEl.textContent = message;
}

function setLoading(v) {
  loadingEl.style.display = v ? 'block' : 'none';
}

async function searchOverpassDirect(lat, lon, radius, material) {
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.openstreetmap.fr/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter'
  ];
  const query = buildOverpassQuery(lat, lon, radius);
  const encoded = encodeURIComponent(query);

  for (const endpoint of endpoints) {
    try {
      let response = await fetch(`${endpoint}?data=${encoded}`, { method: 'GET' });
      if (!response.ok) {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encoded}`
        });
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Overpass ${endpoint} returned ${response.status} ${body}`);
      }
      const data = await response.json();
      const results = (data.elements || []).map(elementToFeature);
      return filterByMaterial(results, material);
    } catch (err) {
      console.warn('Overpass endpoint failed:', endpoint, err.message || err);
      continue;
    }
  }
  throw new Error('Direct Overpass lookup failed on all endpoints');
}

function showResults(items) {
  markers.clearLayers();
  if (!items || items.length === 0) {
    setStatus('No recycling locations found near your current location. Try increasing the radius or changing material.');
  } else {
    setStatus(`Found ${items.length} recycling location${items.length === 1 ? '' : 's'} near you.`);
  }
  items.forEach(it => {
    if (it.lat && it.lon) {
      const marker = L.marker([it.lat, it.lon]);
      const name = it.tags.name || it.tags['operator'] || it.id;
      const popup = `<strong>${name}</strong><pre>${Object.entries(it.tags).map(([k,v])=>`${k}: ${v}`).join('\n')}</pre><a href="https://www.openstreetmap.org/${it.type}/${it.id.split('/')[1]}" target="_blank">Open in OSM</a>`;
      marker.bindPopup(popup);
      markers.addLayer(marker);
    }
  });
}

function getBackendUrl(path) {
  try {
    const loc = window.location;
    if (loc.protocol === 'file:') {
      return `http://localhost:3000${path}`;
    }
    if (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1') {
      return `${loc.protocol}//${loc.hostname}:3000${path}`;
    }
    const previewMatch = loc.hostname.match(/^(.*)-(\d+)\.app\.github\.dev$/);
    if (previewMatch) {
      const backendHost = `${previewMatch[1]}-3000.app.github.dev`;
      return `${loc.protocol}//${backendHost}${path}`;
    }
    if (loc.hostname.endsWith('.app.github.dev')) {
      return `https://humble-winner-vpvgj9pwgwvrc6j6-3000.app.github.dev${path}`;
    }
    return `${loc.protocol}//${loc.host}${path}`;
  } catch (e) {
    return `http://localhost:3000${path}`;
  }
}


async function doSearch(lat, lon) {
  setLoading(true);
  setStatus('Searching for recycling places near your location…');
  const radiusMiles = Number(radiusEl.value) || 12.5;
  const radius = Math.round(radiusMiles * 1609.34);
  const material = materialEl.value || '';
  const url = getBackendUrl(`/api/search?lat=${lat}&lon=${lon}&radius=${radius}&material=${encodeURIComponent(material)}`);

  try {
    console.log('Searching backend URL:', url);
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Backend ${res.status}${body ? `: ${body}` : ''}`);
    }
    const json = await res.json();
    const results = json.results || [];
    showResults(results);
    if (errorDumpEl) { errorDumpEl.style.display = 'none'; errorDumpEl.textContent = ''; }
    return;
  } catch (e) {
    console.warn('Local backend search failed:', e);
    const manualHint = window.location.protocol === 'file:'
      ? 'Start the server with npm start and open http://localhost:3000 in your browser.'
      : 'Make sure the Node server is running at this origin and reload the page.';
    setStatus(`Search failed on local backend. ${manualHint}`);
    // Show a copyable dump of the full error so the user can paste it elsewhere
    if (errorDumpEl) {
      try {
        errorDumpEl.textContent = (e && e.stack) ? e.stack : (typeof e === 'string' ? e : JSON.stringify(e, Object.getOwnPropertyNames(e), 2));
      } catch (ex) {
        errorDumpEl.textContent = String(e);
      }
      errorDumpEl.style.display = 'block';
    }
    alert(`Search failed — please try again or check console for details.\n${e.message || e}\n${manualHint}`);
  } finally {
    setLoading(false);
  }
}

function handleGeoError(err) {
  // err.code values: 1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT
  let msg = err && err.message ? err.message : 'Unable to determine location';
  if (err && err.code === 1) {
    msg = 'Location access was denied. Allow location for this site in your browser settings and try again.';
    // Add an extra hint about insecure origins
    msg += '\nIf you opened the page via an insecure origin (http or file://), geolocation may be blocked. Run the site on http://localhost or over HTTPS.';
  } else if (err && err.code === 2) {
    msg = 'Position unavailable. Try again or check your device/location settings.';
  } else if (err && err.code === 3) {
    msg = 'Location request timed out. Try again.';
  }
  setStatus(msg);
  alert(msg);
}

findBtn.addEventListener('click', () => {
  if (!navigator.geolocation) {
    setStatus('Geolocation not supported by your browser.');
    return alert('Geolocation not supported');
  }
  setStatus('Locating your position…');
  findBtn.disabled = true;
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude, longitude } = pos.coords;
    map.setView([latitude, longitude], 12);
    if (youMarker) youMarker.remove();
    youMarker = L.circleMarker([latitude, longitude], { radius:6, color:'#007bff' }).addTo(map).bindPopup('You are here');
    setStatus('Centered around your location. Finding nearby recycling places…');
    try {
      await doSearch(latitude, longitude);
    } finally {
      findBtn.disabled = false;
    }
  }, err => { findBtn.disabled = false; handleGeoError(err); });
});

// Try to locate on load
if (navigator.geolocation) {
  setStatus('Looking up your current location…');
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude, longitude } = pos.coords;
    map.setView([latitude, longitude], 12);
    if (youMarker) youMarker.remove();
    youMarker = L.circleMarker([latitude, longitude], { radius:6, color:'#007bff' }).addTo(map).bindPopup('You are here');
    setStatus('Centered around your current location. Fetching nearby recycling spots…');
    // Auto-run search on load
    try { await doSearch(latitude, longitude); } catch (e) { /* ignore */ }
  }, err => {
    handleGeoError(err);
    if (!statusEl.textContent) setStatus('Unable to determine your location. Use the button to search manually.');
  });
} else {
  setStatus('Geolocation is not available. Use the button to search once location access is enabled.');
}

function updateRadiusHelp() {
  const miles = Number(radiusEl.value) || 0;
  const km = (miles * 1.60934);
  radiusHelp.textContent = `~${km.toFixed(1)} km`;
}

radiusEl.addEventListener('input', updateRadiusHelp);
updateRadiusHelp();
