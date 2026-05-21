# Recycling-Website

Simple map that finds recycling locations near you using OpenStreetMap/Overpass. Includes a small Express proxy with an in-memory LRU cache to avoid rate-limits.

- Run locally:

```bash
npm install
npm start
# then open http://localhost:3000
```

Notes:
- Default radius is 12.5 miles (~20 km); adjust in the UI.
- The proxy queries Overpass and filters by material using returned tags.
# Recycling-Website
A website which shows where you can recycle materials if they are in a rural place
