# Surf Conditions PWA

Real-time surf conditions for Monterey Bay — Progressive Web App edition.

## Data Sources

| Card | Source | API |
|------|--------|-----|
| Nearest NDBC buoy | NDBC via the Cloudflare relay | Carmel / Asilomar / Moss Landing: 46236 Monterey Canyon. Big Sur: 46239 Point Sur. Steamer Lane: 46253 Santa Cruz |
| Swell Forecast | Open-Meteo Marine | `marine-api.open-meteo.com` |
| Wind | The buoy, when it reports wind. Otherwise Open-Meteo at the beach | `api.open-meteo.com` |
| UV Index | Open-Meteo Weather | `api.open-meteo.com` |
| Tides | NOAA Tides & Currents | Carmel and Big Sur: 9413375 Carmel Cove. Asilomar: 9413450 Monterey Harbor. Steamer Lane: 9413745 Santa Cruz. Moss Landing: 9413616 Moss Landing |
| Sunrise / Sunset | Sunrise-Sunset.org | `api.sunrise-sunset.org` |
| Moon Phase | Local calculation | Lunar cycle algorithm (no API) |
| Marine Forecast | NWS | Zone PZZ535 (Monterey Bay) |
| Rip Current Risk | NWS | Gridpoint forecast MTR |

All sources are free with no API keys required.

## Installing on Android (Pixel 9 / Chrome)

1. Open **Chrome** on your Pixel 9
2. Navigate to the hosted URL (e.g. `https://yourname.github.io/SurfConditions/web/`)
3. Tap the **three-dot menu** (⋮) in the top-right corner
4. Tap **"Add to Home screen"**
5. Confirm the name ("Surf Conditions") and tap **Add**
6. The app icon appears on your home screen — tap it to launch in standalone mode

The app works offline after the first load (app shell is cached by the service worker). Live data requires a network connection and auto-refreshes every 10 minutes.

## Hosting on GitHub Pages

```bash
# From the repo root
git add web/
git commit -m "Add Surf Conditions PWA"
git push

# In GitHub repo Settings → Pages → Source: Deploy from branch
# Branch: main  /  Folder: /web
# Your URL: https://<username>.github.io/<repo>/
```

## Hosting on Netlify

Drag and drop the `web/` folder onto [app.netlify.com/drop](https://app.netlify.com/drop) — done.

## Local development

```bash
cd web/
npx serve .
# Open http://localhost:3000
```

## Files

```
web/
├── index.html      # Single-page app shell
├── style.css       # Dark ocean theme
├── spot-stations.js # Built-in beaches and their buoy / tide stations
├── app.js          # All data fetching & rendering
├── manifest.json   # PWA manifest
├── sw.js           # Service worker (offline cache)
├── icons/
│   ├── icon-192.svg
│   └── icon-512.svg
└── README.md
```
