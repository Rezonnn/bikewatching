// map.js
// Mapbox + D3 implementation for Lab 7 (Bikewatching)

import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

// --------------- Mapbox setup ---------------

mapboxgl.accessToken = 'pk.eyJ1IjoicmV6b25uIiwiYSI6ImNtaHppNXVvMzBtdXgya29wY2dkOWZidm0ifQ.CD-ZSXbAXtIUz2bbRqeAiA';

// Create the map
const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/light-v11', // you can swap to your custom style
  center: [-71.09415, 42.36027], // Cambridge / Boston
  zoom: 12,
  minZoom: 8,
  maxZoom: 18,
});

map.addControl(new mapboxgl.NavigationControl(), 'top-left');

// --------------- Helpers ---------------

// minutes since midnight for a given Date
function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// HH:MM AM/PM string from minutes
function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString('en-US', { timeStyle: 'short' });
}

// Project station lon/lat → screen coords
function getCoords(station) {
  const lng = +station.lon;
  const lat = +station.lat;
  const point = new mapboxgl.LngLat(lng, lat);
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}

// Compute arrivals / departures / totalTraffic for each station
function computeStationTraffic(stations, trips) {
  const departures = d3.rollup(
    trips,
    (v) => v.length,
    (d) => d.start_station_id
  );
  const arrivals = d3.rollup(
    trips,
    (v) => v.length,
    (d) => d.end_station_id
  );

  return stations.map((station) => {
    const id = station.short_name; // station id in traffic data
    const dep = departures.get(id) ?? 0;
    const arr = arrivals.get(id) ?? 0;
    station.departures = dep;
    station.arrivals = arr;
    station.totalTraffic = dep + arr;
    return station;
  });
}

// Filter trips by time (±60 min around slider value)
function filterTripsByTime(trips, timeFilter) {
  if (timeFilter === -1) return trips;

  return trips.filter((trip) => {
    const started = minutesSinceMidnight(trip.started_at);
    const ended = minutesSinceMidnight(trip.ended_at);
    return (
      Math.abs(started - timeFilter) <= 60 ||
      Math.abs(ended - timeFilter) <= 60
    );
  });
}

// --------------- Main map logic ---------------

map.on('load', async () => {
  // --- Step 2: bike lanes ---

  // Boston lanes
  map.addSource('boston_route', {
    type: 'geojson',
    data: 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson',
  });

  // Cambridge lanes
  map.addSource('cambridge_route', {
    type: 'geojson',
    data: 'https://dsc106.com/labs/lab07/data/cambridge-bike-lanes.geojson',
  });

  const bikeLanePaint = {
    'line-color': '#35e37a',
    'line-width': 2.5,
    'line-opacity': 0.55,
  };

  map.addLayer({
    id: 'bike-lanes-boston',
    type: 'line',
    source: 'boston_route',
    paint: bikeLanePaint,
  });

  map.addLayer({
    id: 'bike-lanes-cambridge',
    type: 'line',
    source: 'cambridge_route',
    paint: bikeLanePaint,
  });

  // --- Step 3: stations & SVG overlay ---

  const svg = d3.select('#map').select('svg');

  // Load station metadata
  const stationsJson = await d3.json(
    'https://dsc106.com/labs/lab07/data/bluebikes-stations.json'
  );
  let stations = stationsJson.data.stations;

  // Load trips; convert timestamps to Date
  let trips = await d3.csv(
    'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv',
    (trip) => {
      trip.started_at = new Date(trip.started_at);
      trip.ended_at = new Date(trip.ended_at);
      return trip;
    }
  );

  // Compute base traffic stats
  stations = computeStationTraffic(stations, trips);

  // radius scale (square root so area ~ traffic)
  const radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(stations, (d) => d.totalTraffic) || 1])
    .range([0, 25]);

  // traffic flow → discrete ratio (0 arrivals, 0.5 balanced, 1 departures)
  const stationFlow = d3
    .scaleQuantize()
    .domain([0, 1])
    .range([0, 0.5, 1]);

  // Create circles
  const circles = svg
    .selectAll('circle')
    .data(stations, (d) => d.short_name)
    .join('circle')
    .attr('r', (d) => radiusScale(d.totalTraffic))
    .attr('cx', 0)
    .attr('cy', 0)
    .style('fill-opacity', 0.6)
    .style('--departure-ratio', (d) =>
      d.totalTraffic ? stationFlow(d.departures / d.totalTraffic) : 0.5
    )
    .each(function (d) {
      // browser title tooltip
      d3.select(this)
        .append('title')
        .text(
          `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`
        );
    });

  // Position circles according to map view
  function updatePositions() {
    circles
      .attr('cx', (d) => getCoords(d).cx)
      .attr('cy', (d) => getCoords(d).cy);
  }

  updatePositions();
  map.on('move', updatePositions);
  map.on('zoom', updatePositions);
  map.on('resize', updatePositions);
  map.on('moveend', updatePositions);

  // --------------- Step 5: time slider filtering ---------------

  const timeSlider = document.getElementById('time-slider');
  const selectedTime = document.getElementById('selected-time');
  const anyTimeLabel = document.getElementById('any-time');

  function updateScatter(timeFilter) {
    const filteredTrips = filterTripsByTime(trips, timeFilter);
    computeStationTraffic(stations, filteredTrips);

    // When filtered, make circles slightly bigger for visibility
    if (timeFilter === -1) {
      radiusScale.range([0, 25]);
    } else {
      radiusScale.range([3, 50]);
    }

    circles
      .attr('r', (d) => radiusScale(d.totalTraffic))
      .style('--departure-ratio', (d) =>
        d.totalTraffic ? stationFlow(d.departures / d.totalTraffic) : 0.5
      );
  }

  function updateTimeDisplay() {
    const timeFilter = Number(timeSlider.value);

    if (timeFilter === -1) {
      selectedTime.textContent = '';
      anyTimeLabel.style.display = 'block';
    } else {
      selectedTime.textContent = formatTime(timeFilter);
      anyTimeLabel.style.display = 'none';
    }

    updateScatter(timeFilter);
  }

  timeSlider.addEventListener('input', updateTimeDisplay);
  updateTimeDisplay(); // initial state
});
