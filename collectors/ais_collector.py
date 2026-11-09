"""
AIS vessel tracking via AISStream.io.

Only tankers (AIS ship types 80-89, length >= 115 m) are kept. Position reports are
coalesced in memory and flushed to SQLite and to browsers once per second, so a busy
stream costs one DB transaction and one WebSocket message per second instead of one
per report.
"""
import asyncio
import json
import logging
from datetime import datetime, timezone

import websockets

from config import settings
from database import get_known_tankers, save_vessels

logger = logging.getLogger(__name__)

TANKER_TYPES = set(range(80, 90))
MIN_LENGTH_M = 115
FLUSH_SECONDS = 1.0
BOUNDING_BOXES = [[[-90.0, -180.0], [90.0, 180.0]]]  # whole world

_static: dict[str, dict] = {}   # mmsi -> static data (type, name, dimensions, draught)
_pending: dict[str, dict] = {}  # mmsi -> latest position report not yet flushed


def classify_vessel(length: int, draught: float = 0, sog: float = 0) -> dict:
    """Size class from length; loading state estimated from draught (AIS draught is crew-entered)."""
    length, draught, sog = length or 0, draught or 0, sog or 0

    if length >= 300:
        v_class, v_desc, color = "VLCC", "VLCC (~2M bbl)", "#f59e0b"
    elif length >= 240:
        v_class, v_desc, color = "Suezmax", "Suezmax (~1M bbl)", "#00d4ff"
    elif length >= 200:
        v_class, v_desc, color = "Aframax", "Aframax / LR2 (~700k bbl)", "#10b981"
    else:
        v_class, v_desc, color = "Product", "MR / product tanker", "#a855f7"

    # Laden/ballast thresholds by class (metres). Draught is self-reported and often stale.
    laden_at, ballast_at = {"VLCC": (16.5, 12.0), "Suezmax": (13.0, 9.5), "Aframax": (11.0, 8.5)}.get(
        v_class, (10.5, 8.0)
    )
    if draught <= 0:
        cargo = "Unknown load"
    elif draught >= laden_at:
        cargo = "Laden (est.)"
    elif draught <= ballast_at:
        cargo = "Ballast (est.)"
    else:
        cargo = "Part laden (est.)"
    motion = "Stationary" if sog < 0.8 else "Underway"

    return {"vessel_class": v_class, "vessel_desc": v_desc, "color": color, "cargo_status": cargo, "motion": motion}


def _handle_static(mmsi: str, meta: dict, message: dict):
    st = message.get("ShipStaticData", {})
    if st.get("Type") not in TANKER_TYPES:
        _static.pop(mmsi, None)  # keep memory bounded to tankers only
        return
    dim = st.get("Dimension") or {}
    try:
        raw_d = float(st.get("MaximumStaticDraught") or 0)
        draught = round(raw_d / 10.0, 1) if raw_d > 25.0 else round(raw_d, 1)  # some feeds send decimetres
    except (TypeError, ValueError):
        draught = 0
    prev = _static.get(mmsi, {})
    _static[mmsi] = {
        "mmsi": mmsi,
        "ship_type": st.get("Type"),
        "name": (st.get("Name") or "").strip() or prev.get("name") or (meta.get("ShipName") or "").strip(),
        "destination": (st.get("Destination") or "").strip(),
        "callsign": (st.get("CallSign") or "").strip(),
        "length": int((dim.get("A") or 0) + (dim.get("B") or 0)),
        "draught": draught,
    }


def _handle_position(mmsi: str, meta: dict, message: dict):
    st = _static.get(mmsi)
    if not st or st.get("ship_type") not in TANKER_TYPES:
        return  # wait for static data so non-tankers are never stored
    if st.get("length") and st["length"] < MIN_LENGTH_M:
        return
    lat, lon = meta.get("latitude"), meta.get("longitude")
    if lat is None or lon is None or (lat == 0 and lon == 0) or abs(lat) > 90 or abs(lon) > 180:
        return
    pos = message.get("PositionReport", {})
    sog = pos.get("Sog") or 0
    if sog >= 102.3:  # AIS "not available"
        sog = 0
    cog = pos.get("Cog") or 0
    heading = pos.get("TrueHeading")
    if heading is None or heading == 511:
        heading = cog
    _pending[mmsi] = {
        **st,
        "lat": lat, "lon": lon,
        "sog": round(sog, 1), "cog": round(cog, 1), "heading": round(heading, 1),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


async def _flush_loop(broadcast):
    while True:
        await asyncio.sleep(FLUSH_SECONDS)
        if not _pending:
            continue
        batch = list(_pending.values())
        _pending.clear()
        try:
            await asyncio.to_thread(save_vessels, batch)
        except Exception as e:
            logger.warning(f"Vessel batch save failed: {e}")
        enriched = [{**v, **classify_vessel(v.get("length"), v.get("draught"), v.get("sog"))} for v in batch]
        await broadcast({"type": "vessel_batch", "data": enriched})


async def run_ais_stream(broadcast):
    """Keep a WebSocket to AISStream.io open, reconnecting with backoff."""
    if not settings.AISSTREAM_API_KEY:
        logger.warning("AISSTREAM_API_KEY not set: live vessel tracking disabled.")
        return

    for row in await asyncio.to_thread(get_known_tankers):
        _static[str(row["mmsi"])] = {**row, "mmsi": str(row["mmsi"])}
    logger.info(f"Loaded static data for {len(_static)} known tankers.")

    flusher = asyncio.create_task(_flush_loop(broadcast))
    subscribe = json.dumps({
        "APIKey": settings.AISSTREAM_API_KEY,
        "BoundingBoxes": BOUNDING_BOXES,
        "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
    })
    backoff = 5
    try:
        while True:
            try:
                async with websockets.connect(
                    "wss://stream.aisstream.io/v0/stream", ping_interval=20, ping_timeout=15, close_timeout=10
                ) as ws:
                    await ws.send(subscribe)
                    logger.info("AISStream connected.")
                    backoff = 5
                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                            meta = msg.get("MetaData", {})
                            mmsi = str(meta.get("MMSI", "")).strip()
                            if not mmsi:
                                continue
                            if msg.get("MessageType") == "ShipStaticData":
                                _handle_static(mmsi, meta, msg.get("Message", {}))
                            elif msg.get("MessageType") == "PositionReport":
                                _handle_position(mmsi, meta, msg.get("Message", {}))
                        except Exception as e:
                            logger.debug(f"AIS parse error: {e}")
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"AISStream disconnected: {e}. Reconnecting in {backoff}s.")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 300)
    finally:
        flusher.cancel()
