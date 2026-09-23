# OilWatch — Global Oil Shipping Intelligence

A locally-hosted real-time oil shipping dashboard running entirely on your laptop.

## What it does
- **Live tanker positions** on a global map via AISStream.io (free WebSocket API)
- **Oil prices** — Brent Crude & WTI from the EIA free API, updated every 6 hours
- **Maritime news** from 6 RSS feeds (gCaptain, Splash247, Reuters, etc.), filtered for oil/shipping relevance, with AI-written "what to expect" briefs via Gemini
- **UKMTO incident advisories** scraped every hour and geo-plotted on the map
- **Global shipping lanes** overlay (CC-licensed GeoJSON from GitHub)
- **7 major chokepoints** (Hormuz, Bab el-Mandeb, Suez, Malacca, Bosphorus, Panama, Cape of Good Hope) with risk levels and volume data

## Quick Start

### 1. Get your 3 free API keys (5 minutes total)

| Key | Where | Time |
|---|---|---|
| AISStream.io | https://aisstream.io — sign in with GitHub | 1 min |
| EIA Open Data | https://www.eia.gov/opendata/ — register | 2 min |
| Google Gemini | https://aistudio.google.com/apikey | 1 min |

### 2. Add keys to `.env`
Open the `.env` file in the project folder and fill in your 3 keys.

### 3. Launch
Double-click **`start.bat`**

### 4. Open browser
Go to **http://localhost:8000**

---

## Architecture

```
start.bat
  └── Python FastAPI (port 8000)
        ├── WebSocket → AISStream.io    [live tanker positions]
        ├── APScheduler
        │     ├── every 30 min → RSS news + Gemini AI briefs
        │     ├── every 6 hrs  → EIA oil prices
        │     └── every 1 hr   → UKMTO incidents
        ├── SQLite (oilwatch.db)        [local data cache]
        └── Leaflet.js frontend         [http://localhost:8000]
```

## Limitations (inherent to free data)
- **AIS coverage gaps in open ocean**: Free AIS uses land-based receivers. Tankers in the middle of the Atlantic/Indian Ocean won't appear. Last-known position is shown with a timestamp.
- **AIS destination is self-reported**: Captains type it manually — it can be blank, wrong, or "FOR ORDERS".
- **Cargo not visible**: AIS doesn't tell you whether a tanker is laden or in ballast (empty).
- **UKMTO scraping**: If UKMTO changes their website structure, the scraper may stop finding incidents until updated.

## Stopping the server
Press `Ctrl+C` in the terminal window, or just close it.
