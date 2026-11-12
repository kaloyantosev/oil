"""
One tanker snapshot: listen to the AISStream.io feed (free key) for a few minutes, keep the latest
position of every tanker (AIS types 80-89, >= 115 m) and write public/static/data/vessels.json.
A GitHub Action runs it once a day; to run it by hand:

    set AISSTREAM_API_KEY=...        (free at https://aisstream.io, sign in with GitHub)
    python scripts/snapshot_tankers.py [minutes]

Ships send their name and type only every ~6 minutes, and a position is kept only once the type
is known, so longer runs catch more tankers. The feed comes from land-based receivers: busy coasts
and straits are covered, open ocean mostly is not.
"""
import asyncio
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from collectors import ais_collector as ais  # noqa: E402
from config import settings  # noqa: E402

OUT = ROOT / "public" / "static" / "data" / "vessels.json"
MIN_TANKERS = 50  # fewer means the feed failed: keep the previous snapshot


async def listen(minutes: float):
    subscribe = json.dumps({
        "APIKey": settings.AISSTREAM_API_KEY,
        "BoundingBoxes": ais.BOUNDING_BOXES,
        "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
    })
    seen: dict[str, dict] = {}
    end = time.monotonic() + minutes * 60
    while time.monotonic() < end:
        try:
            async with websockets.connect("wss://stream.aisstream.io/v0/stream", ping_interval=20, close_timeout=5) as ws:
                await ws.send(subscribe)
                while time.monotonic() < end:
                    raw = await asyncio.wait_for(ws.recv(), timeout=max(1.0, end - time.monotonic()))
                    msg = json.loads(raw)
                    if "error" in msg:
                        sys.exit(f"AISStream: {msg['error']}")
                    meta = msg.get("MetaData", {})
                    mmsi = str(meta.get("MMSI", "")).strip()
                    if not mmsi:
                        continue
                    if msg.get("MessageType") == "ShipStaticData":
                        ais._handle_static(mmsi, meta, msg.get("Message", {}))
                    elif msg.get("MessageType") == "PositionReport":
                        ais._handle_position(mmsi, meta, msg.get("Message", {}))
                        if mmsi in ais._pending:
                            seen[mmsi] = ais._pending.pop(mmsi)
        except asyncio.TimeoutError:
            break
        except websockets.ConnectionClosed:
            await asyncio.sleep(3)  # reconnect and keep listening
    return seen


def main():
    if not settings.AISSTREAM_API_KEY:
        sys.exit("AISSTREAM_API_KEY is not set.")
    minutes = float(sys.argv[1]) if len(sys.argv) > 1 else 20
    seen = asyncio.run(listen(minutes))
    if len(seen) < MIN_TANKERS:
        sys.exit(f"Only {len(seen)} tankers heard; keeping the previous snapshot.")
    vessels = [{**v, **ais.classify_vessel(v.get("length"), v.get("draught"), v.get("sog"))} for v in seen.values()]
    OUT.write_text(json.dumps({
        "vessels": vessels, "count": len(vessels),
        "latest_updated_at": max(v["updated_at"] for v in vessels),
        "listened_minutes": minutes,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="minutes"),
    }, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(vessels)} tankers after {minutes:g} minutes.")


if __name__ == "__main__":
    main()
