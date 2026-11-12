"""
Builds public/static/data/*.json, the snapshot the dashboard reads when no API server is running
(Vercel, GitHub Pages). A GitHub Action runs it every hour; to run it by hand:

    pip install -r requirements.txt
    python scripts/build_static.py

Writes news.json, incidents.json, analysis.json, historical-data.json, vessels.json and health.json,
in the same shape as the matching /api/* endpoints.
"""
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
# Fresh database per run: the snapshot holds what the feeds carry now, nothing stale.
os.environ["OILWATCH_DB"] = os.path.join(tempfile.mkdtemp(), "oilwatch.db")

from analysis_engine import get_analysis, get_historical_data  # noqa: E402
from collectors.news_collector import fetch_news  # noqa: E402
from database import get_incidents, get_news, init_db  # noqa: E402

OUT = ROOT / "public" / "static" / "data"


def write(name: str, payload: dict):
    (OUT / f"{name}.json").write_text(json.dumps(payload, separators=(",", ":"), default=str), encoding="utf-8")


def main():
    init_db()
    fetch_news(with_ai=False)
    news = get_news(100)
    if not news:
        sys.exit("No news from any feed; keeping the previous snapshot.")

    write("news", {"news": news, "count": len(news)})
    write("incidents", {"incidents": get_incidents()})
    if not (OUT / "vessels.json").exists():  # the daily tanker snapshot owns this file
        write("vessels", {"vessels": [], "count": 0, "latest_updated_at": ""})
    analysis = get_analysis(news[:10])
    if analysis.get("available"):
        write("analysis", analysis)
    history = get_historical_data()
    if history.get("available"):
        write("historical-data", history)
    write("health", {
        "status": "ok", "mode": "static", "ais_enabled": False,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="minutes"),
    })
    print(f"Snapshot: {len(news)} articles, analysis {'ok' if analysis.get('available') else 'unavailable'}, "
          f"history {'ok' if history.get('available') else 'unavailable'}")


if __name__ == "__main__":
    main()
