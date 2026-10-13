// Built-in beaches and the nearest working NOAA tide station / NDBC buoy.
// Loaded before app.js. `var` and `function` are shared with the other scripts.

var DEFAULT_SPOTS = [
  {
    id: 'carmel', name: 'Carmel Beach', lat: 36.5535, lng: -121.9255, beachFacing: 280, isUS: true,
    buoyId: '46236', buoyName: 'Monterey Canyon',
    tideStation: '9413375', tideStationName: 'Carmel Cove',
    marineZone: 'PZZ535', cwfOffice: 'MTR',
    forecastUrl: 'https://api.weather.gov/gridpoints/MTR/91,48/forecast',
  },
  {
    id: 'asilomar', name: 'Asilomar', lat: 36.6213, lng: -121.9427, beachFacing: 285, isUS: true,
    buoyId: '46236', buoyName: 'Monterey Canyon',
    tideStation: '9413450', tideStationName: 'Monterey Harbor',
    marineZone: 'PZZ535', cwfOffice: 'MTR',
    forecastUrl: 'https://api.weather.gov/gridpoints/MTR/91,51/forecast',
  },
  {
    id: 'bigsur', name: 'Big Sur', lat: 36.2344, lng: -121.8173, beachFacing: 270, isUS: true,
    buoyId: '46239', buoyName: 'Point Sur',
    tideStation: '9413375', tideStationName: 'Carmel Cove',
    marineZone: 'PZZ565', cwfOffice: 'MTR',
    forecastUrl: 'https://api.weather.gov/gridpoints/MTR/92,33/forecast',
  },
  {
    id: 'steamer', name: 'Steamer Lane', lat: 36.9516, lng: -122.0255, beachFacing: 210, isUS: true,
    buoyId: '46253', buoyName: 'Santa Cruz',
    tideStation: '9413745', tideStationName: 'Santa Cruz',
    marineZone: 'PZZ535', cwfOffice: 'MTR',
    forecastUrl: 'https://api.weather.gov/gridpoints/MTR/91,66/forecast',
  },
  {
    id: 'mosslanding', name: 'Moss Landing', lat: 36.8035, lng: -121.7909, beachFacing: 265, isUS: true,
    buoyId: '46236', buoyName: 'Monterey Canyon',
    tideStation: '9413616', tideStationName: 'Moss Landing',
    marineZone: 'PZZ535', cwfOffice: 'MTR',
    forecastUrl: 'https://api.weather.gov/gridpoints/MTR/98,58/forecast',
  },
];

// Refresh station info on built-in spots the phone already saved.
// Does not add a spot back after it was deleted.
function applyBuiltinStations(spots) {
  if (!Array.isArray(spots)) return [];
  return spots.map(s => {
    const def = DEFAULT_SPOTS.find(d => d.id === s.id);
    if (!def) return s;
    return {
      ...s,
      buoyId: def.buoyId,
      buoyName: def.buoyName,
      tideStation: def.tideStation,
      tideStationName: def.tideStationName,
      beachFacing: typeof s.beachFacing === 'number' ? s.beachFacing : def.beachFacing,
    };
  });
}
