#!/usr/bin/env python3
"""
Surf Alert Script — checks conditions at Carmel Beach and Asilomar,
sends a push notification via the Cloudflare Worker when thresholds are met.

Run by launchd every 30 minutes via com.danielbales.surfalert.plist
"""

import json
import os
import time
import requests
from datetime import datetime, date

# ─── Config ────────────────────────────────────────────────────────────────────
WORKER_URL   = 'https://surf-alerts.dbales1210.workers.dev'
NOTIFY_SECRET = 'a9d4c5d77abf4bef03a86dac7298372983dee339ce48a9496a6f034dc6f4f72b'
COOLDOWN_SEC = 4 * 60 * 60   # 4 hours between repeat alerts per spot
STATE_FILE   = os.path.expanduser('~/.surf_alert_state.json')

# ─── Spot definitions ──────────────────────────────────────────────────────────
SPOTS = {
    'carmel': {
        'name': 'Carmel Beach',
        'lat': 36.5535,
        'lng': -121.9255,
        'noaa_station': '9413450',
    },
    'asilomar': {
        'name': 'Asilomar',
        'lat': 36.6213,
        'lng': -121.9427,
        'noaa_station': None,
    },
}

# ─── State helpers ─────────────────────────────────────────────────────────────
def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}

def save_state(state):
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2)

def is_on_cooldown(state, key):
    last = state.get(key, 0)
    return (time.time() - last) < COOLDOWN_SEC

def mark_notified(state, key):
    state[key] = time.time()

# ─── Data fetchers ─────────────────────────────────────────────────────────────
def fetch_marine(lat, lng):
    """Wave height (m) and period (s) from Open-Meteo marine API."""
    url = (
        f'https://marine-api.open-meteo.com/v1/marine'
        f'?latitude={lat}&longitude={lng}'
        f'&current=wave_height,wave_period,swell_wave_height,swell_wave_period'
        f'&timezone=America/Los_Angeles'
    )
    r = requests.get(url, timeout=10)
    r.raise_for_status()
    c = r.json()['current']
    wave_m      = c.get('wave_height', 0) or 0
    wave_period = c.get('wave_period', 0) or 0
    swell_m     = c.get('swell_wave_height', wave_m) or wave_m
    swell_period= c.get('swell_wave_period', wave_period) or wave_period
    wave_ft     = wave_m * 3.28084
    swell_ft    = swell_m * 3.28084
    return {
        'wave_ft':      round(wave_ft, 1),
        'swell_ft':     round(swell_ft, 1),
        'wave_period':  round(wave_period, 1),
        'swell_period': round(swell_period, 1),
    }

def fetch_wind(lat, lng):
    """Wind speed (mph) and direction (degrees) from Open-Meteo."""
    url = (
        f'https://api.open-meteo.com/v1/forecast'
        f'?latitude={lat}&longitude={lng}'
        f'&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m'
        f'&wind_speed_unit=mph'
        f'&timezone=America/Los_Angeles'
    )
    r = requests.get(url, timeout=10)
    r.raise_for_status()
    c = r.json()['current']
    return {
        'wind_speed':     round(c.get('wind_speed_10m', 0) or 0, 1),
        'wind_direction': round(c.get('wind_direction_10m', 0) or 0, 1),
        'wind_gusts':     round(c.get('wind_gusts_10m', 0) or 0, 1),
    }

def fetch_tide(station_id):
    """Current water level (feet, MLLW) from NOAA CO-OPS."""
    today = date.today().strftime('%Y%m%d')
    url = (
        f'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter'
        f'?station={station_id}&product=water_level&datum=MLLW'
        f'&time_zone=lst_ldt&units=english&format=json'
        f'&begin_date={today}&end_date={today}'
    )
    r = requests.get(url, timeout=10)
    r.raise_for_status()
    data = r.json()
    predictions = data.get('data', [])
    if not predictions:
        return None
    latest = predictions[-1]
    return round(float(latest['v']), 2)

# ─── Direction helpers ─────────────────────────────────────────────────────────
def wind_dir_label(deg):
    dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']
    idx = round(deg / 22.5) % 16
    return dirs[idx]

def is_carmel_wind(deg):
    """East (67.5–112.5°) or NE (22.5–67.5°) → combined 22.5–112.5°"""
    return 22.5 <= deg <= 112.5

def is_asilomar_wind(deg):
    """East (67.5–112.5°), SE (112.5–157.5°), or South (157.5–202.5°) → combined 67.5–202.5°"""
    return 67.5 <= deg <= 202.5

# ─── Condition checkers ────────────────────────────────────────────────────────
def check_carmel(marine, wind, tide):
    """
    Triggers if ALL:
      - Swell ≥ 6ft
      - Swell period 5–12s
      - Tide ≥ 3ft
      - Wind from E or NE
    """
    reasons = []
    ok = True

    if marine['swell_ft'] < 6.0:
        ok = False
        reasons.append(f"swell {marine['swell_ft']}ft < 6ft")
    if not (5 <= marine['swell_period'] <= 12):
        ok = False
        reasons.append(f"period {marine['swell_period']}s not 5–12s")
    if tide is not None and tide < 3.0:
        ok = False
        reasons.append(f"tide {tide}ft < 3ft")
    if not is_carmel_wind(wind['wind_direction']):
        ok = False
        reasons.append(f"wind {wind_dir_label(wind['wind_direction'])} not E/NE")

    if ok:
        msg = (
            f"{marine['swell_ft']}ft @ {marine['swell_period']}s • "
            f"Tide {tide}ft • "
            f"Wind {wind_dir_label(wind['wind_direction'])} {wind['wind_speed']}mph"
        )
    else:
        msg = None

    return ok, msg

def check_asilomar(marine, wind):
    """
    Triggers if ALL:
      - Swell ≥ 4ft
      - Wind from S, SE, or E
    """
    reasons = []
    ok = True

    if marine['swell_ft'] < 4.0:
        ok = False
        reasons.append(f"swell {marine['swell_ft']}ft < 4ft")
    if not is_asilomar_wind(wind['wind_direction']):
        ok = False
        reasons.append(f"wind {wind_dir_label(wind['wind_direction'])} not S/SE/E")

    if ok:
        msg = (
            f"{marine['swell_ft']}ft @ {marine['swell_period']}s • "
            f"Wind {wind_dir_label(wind['wind_direction'])} {wind['wind_speed']}mph"
        )
    else:
        msg = None

    return ok, msg

# ─── Notification sender ───────────────────────────────────────────────────────
def send_notification(title, body):
    r = requests.post(
        f'{WORKER_URL}/notify',
        json={'title': title, 'body': body},
        headers={
            'Content-Type': 'application/json',
            'X-Notify-Secret': NOTIFY_SECRET,
        },
        timeout=15,
    )
    r.raise_for_status()
    print(f'  Notification sent: {title} — {body}')
    return r.json()

# ─── Main ──────────────────────────────────────────────────────────────────────
def main():
    now = datetime.now().strftime('%Y-%m-%d %H:%M')
    print(f'\n[{now}] Checking surf conditions…')

    state = load_state()

    for key, spot in SPOTS.items():
        print(f'\n  {spot["name"]}')
        try:
            marine = fetch_marine(spot['lat'], spot['lng'])
            wind   = fetch_wind(spot['lat'], spot['lng'])
            print(f'    Swell: {marine["swell_ft"]}ft @ {marine["swell_period"]}s | '
                  f'Wind: {wind_dir_label(wind["wind_direction"])} {wind["wind_speed"]}mph')

            if key == 'carmel':
                tide = fetch_tide(spot['noaa_station'])
                print(f'    Tide:  {tide}ft')
                triggered, msg = check_carmel(marine, wind, tide)
            else:
                triggered, msg = check_asilomar(marine, wind)

            if triggered:
                if is_on_cooldown(state, key):
                    remaining = int((COOLDOWN_SEC - (time.time() - state[key])) / 60)
                    print(f'    ✓ CONDITIONS MET — cooldown active ({remaining}min remaining)')
                else:
                    print(f'    ✓ CONDITIONS MET — sending notification')
                    send_notification(f'🌊 {spot["name"]} is firing!', msg)
                    mark_notified(state, key)
                    save_state(state)
            else:
                print(f'    ✗ Conditions not met')

        except Exception as e:
            print(f'    ERROR: {e}')

    print()

if __name__ == '__main__':
    main()
