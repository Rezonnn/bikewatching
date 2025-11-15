// Insert your Mapbox token
const MAPBOX_TOKEN = 'pk.eyJ1IjoicmV6b25uIiwiYSI6ImNtaHppNXVvMzBtdXgya29wY2dkOWZidm0ifQ.CD-ZSXbAXtIUz2bbRqeAiA';

// Data URLs from Lab 7
const BOSTON_BIKE_LANES =
  'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson';
const CAMBRIDGE_BIKE_LANES =
  'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson';
const BLUEBIKES_STATIONS =
  'https://dsc106.com/labs/lab07/data/bluebikes-stations.json';
const BLUEBIKES_TRIPS_MAR2024 =
  'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv';

import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

// Map init
mapboxgl.accessToken = MAPBOX_TOKEN;
const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/light-v11',
  center: [-71.0596, 42.3606],
  zoom: 11,
  attributionControl: true
});
map.addControl(new mapboxgl.NavigationControl(), 'top-left');

const minutesSinceMidnight = (date) =>
  date.getHours() * 60 + date.getMinutes();

// Net flow coloring scales
const flowQuantize = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);
const flowColor = d3
  .scaleOrdinal()
  .domain([0, 0.5, 1])
  .range(['#e64b3c', '#6b7280', '#1f9d55']); // red, gray, green

// Legend setup
function renderLegend() {
  const legend = document.getElementById('legend');
  legend.innerHTML = '';
  const entries = [
    { label: 'More departures', value: 0 },
    { label: 'Balanced', value: 0.5 },
    { label: 'More arrivals', value: 1 }
  ];
  for (const e of entries) {
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = flowColor(e.value);
    const lab = document.createElement('span');
    lab.textContent = e.label;
    legend.appendChild(sw);
    legend.appendChild(lab);
  }
}
renderLegend();

// Slider
const timeSlider = document.getElementById('time-slider');
const timeLabel = document.getElementById('time-label');
const anyTimeEl = document.getElementById('anytime');

function formatMinutes(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
function updateTimeDisplay() {
  const val = Number(timeSlider.value);
  if (val < 0) {
    anyTimeEl.hidden = false;
    timeLabel.textContent = '';
  } else {
    anyTimeEl.hidden = true;
    timeLabel.textContent = formatMinutes(val);
  }
}
timeSlider.addEventListener('input', updateTimeDisplay);
updateTimeDisplay();

map.on('load', async () => {
  // 1) Bike lanes: Boston + Cambridge
  map.addSource('boston_route', { type: 'geojson', data: BOSTON_BIKE_LANES });
  map.addLayer({
    id: 'bike-lanes-boston',
    type: 'line',
    source: 'boston_route',
    paint: { 'line-color': '#00c853', 'line-width': 3, 'line-opacity': 0.4 }
  });

  map.addSource('cambridge_route', {
    type: 'geojson',
    data: CAMBRIDGE_BIKE_LANES
  });
  map.addLayer({
    id: 'bike-lanes-cambridge',
    type: 'line',
    source: 'cambridge_route',
    paint: { 'line-color': '#00c853', 'line-width': 3, 'line-opacity': 0.35 }
  });

  // 2) D3 overlay SVG for stations
  const container = map.getCanvasContainer();
  const svg = d3.select(container).append('svg').attr('class', 'overlay');
  const g = svg.append('g');

  svg
    .style('position', 'absolute')
    .style('inset', 0)
    .style('pointer-events', 'none');

  // 3) Stations JSON
  let stations = (await d3.json(BLUEBIKES_STATIONS)).data.stations.map((s) => ({
    ...s,
    id: s.short_name,
    lat: +s.lat,
    lon: +s.lon
  }));

  // 4) Trips CSV with time parsing
  let trips = await d3.csv(BLUEBIKES_TRIPS_MAR2024, (row) => {
    const started_at = new Date(row.started_at);
    const ended_at = new Date(row.ended_at);
    return {
      ...row,
      started_at,
      ended_at,
      start_min: minutesSinceMidnight(started_at),
      end_min: minutesSinceMidnight(ended_at)
    };
  });

  // Pre-bucket trips by minute for performance
  const departuresByMinute = Array.from({ length: 1440 }, () => []);
  const arrivalsByMinute = Array.from({ length: 1440 }, () => []);
  for (const t of trips) {
    departuresByMinute[t.start_min].push(t);
    arrivalsByMinute[t.end_min].push(t);
  }

  function computeStationTraffic(stationsArr, tripsSubset) {
    const departures = d3.rollup(
      tripsSubset,
      (v) => v.length,
      (d) => d.start_station_id
    );
    const arrivals = d3.rollup(
      tripsSubset,
      (v) => v.length,
      (d) => d.end_station_id
    );
    return stationsArr.map((s) => {
      const arr = arrivals.get(s.id) ?? 0;
      const dep = departures.get(s.id) ?? 0;
      return {
        ...s,
        arrivals: arr,
        departures: dep,
        totalTraffic: arr + dep,
        flowRatio: arr + dep > 0 ? arr / (arr + dep) : 0.5
      };
    });
  }

  // Initial totals across all trips
  stations = computeStationTraffic(stations, trips);
  let radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(stations, (d) => d.totalTraffic)])
    .range([0, 25]);

  function project([lon, lat]) {
    return map.project(new mapboxgl.LngLat(lon, lat));
  }

  function updatePositions(circlesSel, data) {
    circlesSel
      .attr('cx', (d) => project([d.lon, d.lat]).x)
      .attr('cy', (d) => project([d.lon, d.lat]).y)
      .attr('r', (d) => radiusScale(d.totalTraffic))
      .attr('fill', (d) => flowColor(flowQuantize(d.flowRatio)));
  }

  let circles = g
    .selectAll('circle')
    .data(stations, (d) => d.id)
    .join('circle')
    .attr('data-id', (d) => d.id)
    .each(function (d) {
      d3.select(this)
        .append('title')
        .text(
          `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`
        );
    });

  function renderAll() {
    radiusScale.domain([0, d3.max(stations, (d) => d.totalTraffic)]);
    updatePositions(circles, stations);
  }

  renderAll();

  const reposition = () => updatePositions(circles, stations);
  map.on('move', reposition);
  map.on('zoom', reposition);
  map.on('resize', reposition);
  map.on('moveend', reposition);

  // Slider filter: ±60 minutes window
  function currentFilteredTrips() {
    const val = Number(timeSlider.value);
    if (val < 0) return trips; // any time
    const window = 60;
    const mins = [];
    for (
      let m = Math.max(0, val - window);
      m <= Math.min(1439, val + window);
      m++
    ) {
      mins.push(m);
    }
    const dep = mins.flatMap((m) => departuresByMinute[m]);
    const arr = mins.flatMap((m) => arrivalsByMinute[m]);
    return dep.concat(arr);
  }

  function applyFilter() {
    const filteredTrips = currentFilteredTrips();
    const stationShell = stations.map((s) => ({
      id: s.id,
      lat: s.lat,
      lon: s.lon
    }));
    stations = computeStationTraffic(stationShell, filteredTrips);

    circles = g
      .selectAll('circle')
      .data(stations, (d) => d.id)
      .join('circle')
      .attr('data-id', (d) => d.id)
      .each(function (d) {
        d3.select(this).select('title').remove();
        d3.select(this)
          .append('title')
          .text(
            `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`
          );
      });

    renderAll();
  }

  timeSlider.addEventListener('input', () => {
    updateTimeDisplay();
    applyFilter();
  });
});
