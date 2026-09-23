"""
AIS Vessel Tracking Collector
Connects to AISStream.io via WebSocket and streams real tanker positions.
"""
import asyncio
import json
import logging
import sqlite3
from datetime import datetime, timezone

import websockets

from config import settings

logger = logging.getLogger(__name__)

# AIS ship type codes: 80-89 = Tankers
TANKER_TYPES = set(range(80, 90))

# Global ocean coverage: entire world oceans [SW, NE] as [lat, lon]
BOUNDING_BOXES = [
    [[-90.0, -180.0], [90.0, 180.0]],
]

# In-memory cache: mmsi -> partial vessel data (filled from ShipStaticData)
_vessel_cache: dict = {}


def classify_vessel(length: int, draught: float = 0, sog: float = 0) -> dict:
    """Classify tanker size class and cargo laden/ballast state."""
    length = length or 0
    draught = draught or 0
    sog = sog or 0

    if length >= 300:
        v_class = "VLCC"
        v_desc = "VLCC (~2M bbls Crude)"
        color = "#f59e0b"  # Amber
    elif length >= 240:
        v_class = "Suezmax"
        v_desc = "Suezmax (~1M bbls Crude)"
        color = "#00d4ff"  # Cyan
    elif length >= 200:
        v_class = "Aframax"
        v_desc = "Aframax / LR2 (~700k bbls)"
        color = "#10b981"  # Emerald
    else:
        v_class = "Product"
        v_desc = "MR / Clean Product Tanker"
        color = "#a855f7"  # Purple

    # Cargo state detection
    if sog < 0.8:
        cargo = "Storage / Drifting"
        cargo_color = "#f97316"
    elif draught > 0:
        if (length >= 300 and draught >= 16.5) or \
           (length >= 240 and draught >= 13.0) or \
           (length >= 200 and draught >= 11.0) or \
           (draught >= 10.5):
            cargo = "Laden (Full Cargo)"
            cargo_color = "#10b981"
        elif (length >= 300 and draught <= 12.0) or \
             (length >= 240 and draught <= 9.5) or \
             (length >= 200 and draught <= 8.5) or \
             (draught <= 8.0):
            cargo = "Ballast (Empty)"
            cargo_color = "#94a3b8"
        else:
            cargo = "Partially Laden"
            cargo_color = "#38bdf8"
    else:
        cargo = "Underway"
        cargo_color = "#64748b"

    return {
        "vessel_class": v_class,
        "vessel_desc": v_desc,
        "color": color,
        "cargo_status": cargo,
        "cargo_color": cargo_color,
    }


def _save_vessel_sync(vessel: dict):
    """Write vessel to SQLite (blocking — call via asyncio.to_thread)."""
    from database import DB_PATH
    with sqlite3.connect(DB_PATH, check_same_thread=False) as conn:
        conn.execute("""
            INSERT INTO vessels
                (mmsi, name, lat, lon, sog, cog, heading, ship_type,
                 destination, callsign, length, draught, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(mmsi) DO UPDATE SET
                lat         = excluded.lat,
                lon         = excluded.lon,
                sog         = excluded.sog,
                cog         = excluded.cog,
                heading     = excluded.heading,
                ship_type   = COALESCE(excluded.ship_type,   vessels.ship_type),
                destination = COALESCE(NULLIF(excluded.destination,''), vessels.destination),
                callsign    = COALESCE(NULLIF(excluded.callsign,''),    vessels.callsign),
                length      = CASE WHEN excluded.length > 0 THEN excluded.length ELSE vessels.length END,
                draught     = CASE WHEN excluded.draught > 0 THEN excluded.draught ELSE vessels.draught END,
                name        = COALESCE(NULLIF(excluded.name,''),        vessels.name),
                updated_at  = excluded.updated_at
        """, (
            vessel.get("mmsi"),
            vessel.get("name", ""),
            vessel.get("lat"),
            vessel.get("lon"),
            vessel.get("sog", 0),
            vessel.get("cog", 0),
            vessel.get("heading", 0),
            vessel.get("ship_type"),
            vessel.get("destination", ""),
            vessel.get("callsign", ""),
            vessel.get("length", 0),
            vessel.get("draught", 0),
            vessel.get("updated_at", ""),
        ))
        conn.commit()


async def _process_message(msg: dict, broadcast):
    msg_type = msg.get("MessageType", "")
    meta     = msg.get("MetaData", {})
    message  = msg.get("Message", {})

    mmsi = str(meta.get("MMSI", "")).strip()
    if not mmsi:
        return

    if mmsi not in _vessel_cache:
        _vessel_cache[mmsi] = {
            "mmsi": mmsi,
            "name": meta.get("ShipName", "").strip(),
            "ship_type": None,
            "length": 0,
            "draught": 0,
        }

    # ── Position Report ──────────────────────────────────────────────────────
    if msg_type == "PositionReport":
        pos = message.get("PositionReport", {})
        lat = meta.get("latitude")
        lon = meta.get("longitude")

        if lat is None or lon is None:
            return
        if lat == 0.0 and lon == 0.0:
            return  # invalid AIS position

        # Only process known tanker/commodity vessel types (80-89)
        ship_type = _vessel_cache[mmsi].get("ship_type")
        if ship_type is None or ship_type not in TANKER_TYPES:
            return

        # Filter out river/canal barges or harbor tugs if length is known (< 115m)
        length = _vessel_cache[mmsi].get("length", 0)
        if length and length < 115:
            return

        sog     = pos.get("Sog", 0) or 0
        cog     = pos.get("Cog", 0) or 0
        heading = pos.get("TrueHeading", 511) or 511
        if heading == 511:
            heading = cog  # fall back to COG when true heading unavailable

        draught = _vessel_cache[mmsi].get("draught", 0)
        enrichment = classify_vessel(length, draught, sog)

        _vessel_cache[mmsi].update({
            "lat": lat, "lon": lon,
            "sog": round(sog, 1),
            "cog": round(cog, 1),
            "heading": round(heading, 1),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            **enrichment
        })

        vessel = _vessel_cache[mmsi].copy()
        await asyncio.to_thread(_save_vessel_sync, vessel)
        await broadcast({"type": "vessel_update", "data": vessel})

    # ── Ship Static Data ─────────────────────────────────────────────────────
    elif msg_type == "ShipStaticData":
        static = message.get("ShipStaticData", {})
        ship_type   = static.get("Type")
        name        = (static.get("Name", "") or "").strip() or _vessel_cache[mmsi].get("name", "")
        destination = (static.get("Destination", "") or "").strip()
        callsign    = (static.get("CallSign", "") or "").strip()

        dim    = static.get("Dimension") or {}
        length = (dim.get("A") or 0) + (dim.get("B") or 0)

        raw_draught = static.get("MaximumStaticDraught") or static.get("Draught") or 0
        try:
            raw_d = float(raw_draught)
            draught = round(raw_d / 10.0, 1) if raw_d > 25.0 else round(raw_d, 1)
        except Exception:
            draught = 0

        _vessel_cache[mmsi].update({
            "ship_type":   ship_type,
            "name":        name,
            "destination": destination,
            "callsign":    callsign,
            "length":      int(length),
            "draught":     draught,
        })


def _init_cache_from_db():
    try:
        from database import DB_PATH
        with sqlite3.connect(DB_PATH, check_same_thread=False) as conn:
            rows = conn.execute(
                "SELECT mmsi, name, ship_type, length, destination, callsign, draught FROM vessels WHERE ship_type BETWEEN 80 AND 89"
            ).fetchall()
            for r in rows:
                _vessel_cache[str(r[0])] = {
                    "mmsi": str(r[0]),
                    "name": r[1] or "",
                    "ship_type": r[2],
                    "length": r[3] or 0,
                    "destination": r[4] or "",
                    "callsign": r[5] or "",
                    "draught": r[6] or 0,
                }
        logger.info(f"Loaded {len(_vessel_cache)} known tankers into AIS cache from DB.")
    except Exception as e:
        logger.warning(f"Error preloading vessel cache: {e}")


async def run_ais_stream(broadcast):
    """
    Maintain a persistent WebSocket connection to AISStream.io.
    Automatically reconnects on failure.
    """
    if not settings.AISSTREAM_API_KEY or settings.AISSTREAM_API_KEY == "your_aisstream_key_here":
        logger.warning("⚠  AISStream API key not configured — vessel tracking disabled.")
        logger.warning("   Add your key to .env: AISSTREAM_API_KEY=...")
        return

    _init_cache_from_db()

    subscribe_msg = json.dumps({
        "APIKey":       settings.AISSTREAM_API_KEY,
        "BoundingBoxes": BOUNDING_BOXES,
        "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
    })

    while True:
        try:
            logger.info("Connecting to AISStream.io...")
            async with websockets.connect(
                "wss://stream.aisstream.io/v0/stream",
                ping_interval=20,
                ping_timeout=15,
                close_timeout=10,
            ) as ws:
                await ws.send(subscribe_msg)
                logger.info("✓ AISStream connected — tanker data flowing.")

                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                        await _process_message(msg, broadcast)
                    except Exception as e:
                        logger.debug(f"AIS parse error: {e}")

        except Exception as e:
            logger.warning(f"AISStream disconnected: {e}. Reconnecting in 30 s...")
            await asyncio.sleep(30)
