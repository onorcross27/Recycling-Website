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

let markers = L.layerGroup().addTo(map);
let youMarker = null;
const loadingEl = document.getElementById('loading');

function setLoading(v) {
  loadingEl.style.display = v ? 'block' : 'none';
}

function showResults(items) {
  markers.clearLayers();
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

async function doSearch(lat, lon) {
  setLoading(true);
  try {
    // Input is in miles; convert to meters for Overpass
    const radiusMiles = Number(radiusEl.value) || 12.5;
    const radius = Math.round(radiusMiles * 1609.34);
    const material = materialEl.value || '';
    const url = `/api/search?lat=${lat}&lon=${lon}&radius=${radius}&material=${encodeURIComponent(material)}`;
    const res = await fetch(url);
    const json = await res.json();
    showResults(json.results || []);
  } catch (e) {
    console.warn('search failed', e);
    alert('Search failed — please try again or check console for details');
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
  alert(msg);
}

findBtn.addEventListener('click', () => {
  if (!navigator.geolocation) return alert('Geolocation not supported');
  findBtn.disabled = true;
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude, longitude } = pos.coords;
    map.setView([latitude, longitude], 12);
    if (youMarker) youMarker.remove();
    youMarker = L.circleMarker([latitude, longitude], { radius:6, color:'#007bff' }).addTo(map).bindPopup('You are here');
    try {
      await doSearch(latitude, longitude);
    } finally {
      findBtn.disabled = false;
    }
  }, err => { findBtn.disabled = false; handleGeoError(err); });
});

// Try to locate on load
if (navigator.geolocation) {
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude, longitude } = pos.coords;
    map.setView([latitude, longitude], 12);
    if (youMarker) youMarker.remove();
    youMarker = L.circleMarker([latitude, longitude], { radius:6, color:'#007bff' }).addTo(map).bindPopup('You are here');
    // Auto-run search on load
    try { await doSearch(latitude, longitude); } catch (e) { /* ignore */ }
  }, () => { /* ignore */ });
}

function updateRadiusHelp() {
  const miles = Number(radiusEl.value) || 0;
  const km = (miles * 1.60934);
  radiusHelp.textContent = `~${km.toFixed(1)} km`;
}

radiusEl.addEventListener('input', updateRadiusHelp);
updateRadiusHelp();
