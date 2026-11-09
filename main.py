"""
OilWatch: FastAPI app serving the dashboard, the REST API and the live vessel WebSocket.

Persistent host (local, Render, Railway, Fly): AIS stream + scheduled collectors run in-process.
Serverless (Vercel): no background work; news is refreshed lazily on request and vessels are
only available if a persistent instance shares the database.
"""
import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from collectors.ais_collector import classify_vessel, run_ais_stream
from config import settings
from database import (
    get_current_vessels, get_incidents, get_news, get_oil_prices, init_db, is_serverless,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s", datefmt="%H:%M:%S")
logger = logging.getLogger("oilwatch")

PUBLIC_DIR = Path(__file__).resolve().parent / "public"
SERVERLESS = is_serverless()


class ConnectionManager:
    def __init__(self):
        self._connections: set[WebSocket] = set()

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self._connections.add(ws)

    def disconnect(self, ws: WebSocket):
        self._connections.discard(ws)

    async def broadcast(self, payload: dict):
        targets = list(self._connections)
        if not targets:
            return
        results = await asyncio.gather(*(ws.send_json(payload) for ws in targets), return_exceptions=True)
        for ws, res in zip(targets, results):
            if isinstance(res, Exception):
                self._connections.discard(ws)

    @property
    def count(self):
        return len(self._connections)


manager = ConnectionManager()


def _vessels_payload() -> dict:
    vessels = get_current_vessels(max_age_hours=settings.VESSEL_MAX_AGE_HOURS)
    enriched = [{**v, **classify_vessel(v.get("length"), v.get("draught"), v.get("sog"))} for v in vessels]
    latest = max((v.get("updated_at") or "" for v in vessels), default="")
    return {"vessels": enriched, "count": len(enriched), "latest_updated_at": latest}


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    ais_task = None
    if not SERVERLESS:
        from scheduler import start_scheduler, stop_scheduler
        start_scheduler()
        ais_task = asyncio.create_task(run_ais_stream(manager.broadcast))
        logger.info("OilWatch running: AIS stream and scheduled collectors active.")
    else:
        logger.info("OilWatch running in serverless mode: data refreshes lazily on request.")
    yield
    if ais_task:
        ais_task.cancel()
    if not SERVERLESS:
        stop_scheduler()


app = FastAPI(title="OilWatch", version="1.1.0", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.mount("/static", StaticFiles(directory=str(PUBLIC_DIR / "static")), name="static")


@app.middleware("http")
async def restore_vercel_path(request, call_next):
    """vercel.json rewrites /api/* to /api/index.py?__path__=*; restore the original path."""
    qp = request.query_params.get("__path__")
    if qp is not None:
        clean = qp.lstrip("/")
        request.scope["path"] = f"/{clean}" if clean.startswith("api/") or clean == "health" else f"/api/{clean}"
    return await call_next(request)


# Lazy refresh for serverless, where no scheduler runs.
_last_refresh: dict[str, float] = {}


async def _ensure_fresh_news():
    if not SERVERLESS:
        return
    if time.time() - _last_refresh.get("news", 0) < settings.SERVERLESS_REFRESH_MINUTES * 60:
        return
    _last_refresh["news"] = time.time()
    from collectors.news_collector import fetch_news
    try:
        await asyncio.to_thread(fetch_news, False)  # no AI briefs: keep requests fast
    except Exception as e:
        logger.warning(f"Lazy news refresh failed: {e}")


@app.get("/", include_in_schema=False)
async def root():
    return FileResponse(PUBLIC_DIR / "index.html")


@app.get("/health")
@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "version": app.version,
        "mode": "serverless" if SERVERLESS else "persistent",
        "ws_clients": manager.count,
        "ais_enabled": bool(settings.AISSTREAM_API_KEY) and not SERVERLESS,
        "eia_enabled": bool(settings.EIA_API_KEY),
        "ai_enabled": bool(settings.GEMINI_API_KEY),
    }


@app.get("/api/vessels")
async def api_vessels():
    return await asyncio.to_thread(_vessels_payload)


@app.get("/api/news")
async def api_news(limit: int = 25):
    await _ensure_fresh_news()
    news = await asyncio.to_thread(get_news, min(max(limit, 1), 100))
    return {"news": news, "count": len(news)}


@app.get("/api/incidents")
async def api_incidents():
    await _ensure_fresh_news()
    return {"incidents": await asyncio.to_thread(get_incidents)}


@app.get("/api/oil-prices")
async def api_oil_prices():
    return {"prices": await asyncio.to_thread(get_oil_prices)}


@app.get("/api/analysis")
async def api_analysis():
    from analysis_engine import get_analysis
    news = await asyncio.to_thread(get_news, 10)
    return await asyncio.to_thread(get_analysis, news)


@app.get("/api/historical-data")
async def api_historical_data():
    from analysis_engine import get_historical_data
    return await asyncio.to_thread(get_historical_data)


@app.websocket("/ws/vessels")
async def ws_vessels(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        payload = await asyncio.to_thread(_vessels_payload)
        await websocket.send_json({"type": "initial_load", "data": payload["vessels"],
                                   "latest_updated_at": payload["latest_updated_at"]})
        while True:
            await websocket.receive_text()  # client pings keep the connection open
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket)


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    logger.info(f"Open http://localhost:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info", access_log=False)
