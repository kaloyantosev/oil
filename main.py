"""
OilWatch — Main FastAPI Application
Serves the frontend, REST API, WebSocket stream, and coordinates all collectors.
"""
import asyncio
import logging
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from pathlib import Path

import aiofiles
import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from config import settings
from database import init_db, is_serverless, get_current_vessels, get_news, get_oil_prices, get_incidents
from collectors.ais_collector import run_ais_stream
from scheduler import start_scheduler, stop_scheduler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


# ─── WebSocket Connection Manager ────────────────────────────────────────────
class ConnectionManager:
    def __init__(self):
        self._connections: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self._connections.append(ws)
        logger.info(f"Frontend connected ({len(self._connections)} clients)")

    def disconnect(self, ws: WebSocket):
        self._connections.remove(ws)
        logger.info(f"Frontend disconnected ({len(self._connections)} clients)")

    async def broadcast(self, payload: dict):
        dead = []
        for ws in self._connections:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._connections.remove(ws)

    @property
    def count(self):
        return len(self._connections)


manager = ConnectionManager()


BASE_DIR   = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"


# ─── Startup / Shutdown ───────────────────────────────────────────────────────
async def _download_shipping_lanes():
    """Download the shipping lanes GeoJSON from GitHub if not cached locally."""
    path = STATIC_DIR / "data" / "shipping_lanes.geojson"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.stat().st_size > 10_000:
            logger.info("Shipping lanes already cached.")
            return

        url = (
            "https://raw.githubusercontent.com/newzealandpaul/"
            "Shipping-Lanes/main/data/Shipping_Lanes_v1.geojson"
        )
        logger.info("Downloading shipping lanes GeoJSON...")
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            r = await client.get(url)
            if r.status_code == 200:
                async with aiofiles.open(path, "wb") as f:
                    await f.write(r.content)
                logger.info(f"✓ Shipping lanes downloaded ({len(r.content) / 1024:.0f} KB)")
            else:
                _write_empty_geojson(path)
    except Exception as e:
        logger.warning(f"Shipping lanes download skipped or filesystem read-only: {e}")


def _write_empty_geojson(path: Path):
    try:
        path.write_text('{"type":"FeatureCollection","features":[]}', encoding="utf-8")
    except Exception:
        pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ──────────────────────────────────────────────────────────────
    logger.info("=" * 50)
    logger.info(" OilWatch — Global Oil Shipping Intelligence")
    logger.info("=" * 50)

    init_db()

    serverless = is_serverless()
    ais_task = None
    hormuz_task = None

    try:
        from collectors.hormuz_fleet import init_hormuz_fleet, run_hormuz_fleet_loop
        init_hormuz_fleet()
    except Exception as e:
        logger.warning(f"init_hormuz_fleet skipped: {e}")

    if not serverless:
        await _download_shipping_lanes()
        try:
            start_scheduler()
            ais_task = asyncio.create_task(run_ais_stream(manager.broadcast))
            hormuz_task = asyncio.create_task(run_hormuz_fleet_loop(manager.broadcast))
            logger.info("✓ OilWatch background daemons and schedulers active.")
        except Exception as e:
            logger.warning(f"Could not start background daemons: {e}")
    else:
        logger.info("✓ OilWatch running in serverless mode (Vercel/Lambda).")

    logger.info("✓ OilWatch server initialized successfully.")
    logger.info("-" * 50)

    yield  # Server is running

    # ── Shutdown ─────────────────────────────────────────────────────────────
    if ais_task:
        ais_task.cancel()
    if hormuz_task:
        hormuz_task.cancel()
    if not serverless:
        try:
            stop_scheduler()
        except Exception:
            pass
    logger.info("OilWatch stopped.")


# ─── App ──────────────────────────────────────────────────────────────────────
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="OilWatch", version="1.0.0", lifespan=lifespan)

# Enable CORS for online cloud hosting and reverse proxies
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ─── Routes ───────────────────────────────────────────────────────────────────
@app.get("/", include_in_schema=False)
async def root():
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "version": "1.0.0",
        "ws_clients": manager.count,
        "ais_key_set": bool(settings.AISSTREAM_API_KEY and settings.AISSTREAM_API_KEY != "your_aisstream_key_here"),
        "eia_key_set": bool(settings.EIA_API_KEY and settings.EIA_API_KEY != "your_eia_key_here"),
        "gemini_key_set": bool(settings.GEMINI_API_KEY and settings.GEMINI_API_KEY != "your_gemini_key_here"),
    }


@app.get("/api/vessels")
async def api_vessels():
    from collectors.ais_collector import classify_vessel
    from database import get_latest_vessel_timestamp
    vessels = await asyncio.to_thread(get_current_vessels)
    latest_ts = await asyncio.to_thread(get_latest_vessel_timestamp)
    enriched = []
    for v in vessels:
        c = classify_vessel(v.get("length", 0), v.get("draught", 0), v.get("sog", 0))
        enriched.append({**v, **c})
    return {"vessels": enriched, "count": len(enriched), "latest_updated_at": latest_ts}


@app.get("/api/news")
async def api_news(limit: int = 25):
    news = await asyncio.to_thread(get_news, limit)
    return {"news": news, "count": len(news)}


@app.get("/api/oil-prices")
async def api_oil_prices():
    prices = await asyncio.to_thread(get_oil_prices)
    return {"prices": prices}


@app.get("/api/incidents")
async def api_incidents():
    incidents = await asyncio.to_thread(get_incidents)
    return {"incidents": incidents}


@app.get("/api/analysis")
async def api_analysis():
    from analysis_engine import fetch_live_commodities, calculate_fair_value_model, get_ai_macro_analysis, GLOBAL_COST_TRUCTURE
    # 1. Fetch live commodity market quotes (Brent, WTI, NatGas, Crack Spread, Term Structure)
    quotes = await asyncio.to_thread(fetch_live_commodities)
    brent = quotes.get("brent") or 82.50
    wti = quotes.get("wti") or 78.20
    natgas = quotes.get("natgas")

    # 2. Compute theoretical fair value & cost curve mechanics
    fair_value = calculate_fair_value_model(brent, wti)

    # 3. Pull recent intelligence
    news = await asyncio.to_thread(get_news, 10)

    # 4. Generate AI Macro memo (with crack spread and curve context)
    ai_memo = await asyncio.to_thread(get_ai_macro_analysis, fair_value, news, quotes)

    return {
        "quotes": quotes,
        "fair_value": fair_value,
        "cost_curve": GLOBAL_COST_TRUCTURE,
        "ai_memo": ai_memo,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/historical-data")
async def api_historical_data():
    from analysis_engine import get_10y_historical_data
    data = await asyncio.to_thread(get_10y_historical_data)
    return data


# ─── WebSocket ────────────────────────────────────────────────────────────────
@app.websocket("/ws/vessels")
async def ws_vessels(websocket: WebSocket):
    from collectors.ais_collector import classify_vessel
    await manager.connect(websocket)

    # Send all current vessels immediately on connect with full classification
    from database import get_latest_vessel_timestamp
    vessels = await asyncio.to_thread(get_current_vessels)
    enriched = []
    for v in vessels:
        c = classify_vessel(v.get("length", 0), v.get("draught", 0), v.get("sog", 0))
        enriched.append({**v, **c})
    latest_ts = await asyncio.to_thread(get_latest_vessel_timestamp)
    await websocket.send_json({"type": "initial_load", "data": enriched, "latest_updated_at": latest_ts})

    try:
        while True:
            # Keep connection alive; frontend can send ping messages
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)


# ─── Entry Point ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import os
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    logger.info(f"Starting OilWatch on port {port}...")
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=port,
        log_level="info",
        access_log=False,
    )
