# OilWatch: oil shipping & market structure

A self-hosted dashboard with two views:

- **Live fleet:** tanker positions from AIS (AISStream.io), chokepoints, shipping lanes, oil & shipping news, and security alerts derived from that news.
- **Market structure:** Brent, WTI, Henry Hub, the Brent–WTI spread, the 3:2:1 crack spread and the WTI M1–M2 calendar spread. Each is ranked against its own last 5 years (percentile and z-score), with 10 years of monthly charts.

Everything shown is real data or clearly labelled as an estimate. When a source is unavailable the value shows as `--` rather than a placeholder.

## Quick start (Windows)

1. Double-click **`start.bat`**. On first run it creates `.env` from `.env.template` and opens it.
2. Add the keys you want. All are free and optional:

   | Key | Enables | Where |
   |---|---|---|
   | `AISSTREAM_API_KEY` | Live tanker positions | https://aisstream.io |
   | `GEMINI_API_KEY` | AI news briefs and market commentary | https://aistudio.google.com/apikey |
   | `EIA_API_KEY` | EIA daily spot prices (`/api/oil-prices`) | https://www.eia.gov/opendata/ |

3. Run `start.bat` again and open **http://localhost:8000**.

Other platforms: `pip install -r requirements.txt` then `python main.py`.

## How it works

```
main.py (FastAPI)
 ├── AIS stream (AISStream.io WebSocket) → tankers only (AIS types 80–89, ≥115 m)
 │     buffered in memory, flushed to SQLite + browsers once per second
 ├── Scheduler: news + derived alerts every 30 min, EIA prices every 6 h
 ├── analysis_engine.py: futures quotes (5 min cache), 10y daily history (6 h cache)
 └── public/  → the dashboard (Leaflet + Chart.js)
```

### Market data notes

- Prices are **front-month futures** from Yahoo Finance (ICE Brent, NYMEX WTI/RBOB/ULSD/Henry Hub), not physical spot assessments.
- **Calendar spread** compares the two nearest WTI contracts. They are chosen from the CME expiry rule (last trade 3 business days before the 25th of the prior month), never hard-coded. Positive means backwardation.
- **3:2:1 crack** = (2 × RBOB + 1 × ULSD, $/gal × 42 − 3 × WTI) / 3, in $ per barrel of crude.
- Historical charts are continuous front-month series, so roll dates can create small jumps.
- **Reference levels** (Middle East cost, US shale breakeven, Saudi fiscal breakeven) are approximate public estimates for context. They are not a fair-value model.

### Vessel notes

- The free AIS feed relies on land-based receivers, so open-ocean coverage is patchy. Vessels not heard from in 48 h are hidden (`VESSEL_MAX_AGE_HOURS`).
- Size class comes from AIS length. Laden/ballast is **estimated** from draught, which the crew enters by hand and often doesn't update.

### Security alerts

UKMTO's incident page loads its data with JavaScript and has no public feed, so it isn't scraped. Alerts come from news articles that describe a security event in a named sea area. They are plotted at that area's reference point (not the exact position) and link to the source article. For official advisories, see https://www.ukmto.org/recent-incidents.

## Deployment

- **Persistent host** (Render, Railway, Fly, a VM): `Procfile` runs uvicorn. Everything works, including live AIS.
- **Vercel**: serves `public/` statically and the API from `api/index.py`. Serverless functions can't hold the AIS WebSocket or run the scheduler, so there are no live vessels. Market data works, and news refreshes on request at most every 30 min (without AI briefs).

Not investment advice.
