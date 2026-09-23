"""
EIA Oil Price Collector
Fetches Brent and WTI crude spot prices from the US EIA free API.
"""
import logging
import sqlite3
from datetime import datetime, timezone

import requests

from config import settings
from database import DB_PATH

logger = logging.getLogger(__name__)

EIA_BASE = "https://api.eia.gov/v2"

PRICE_QUERIES = [
    {
        "product": "Brent Crude",
        "series":  "RBRTE",   # Europe Brent Spot Price FOB (Dollars per Barrel)
    },
    {
        "product": "WTI Crude",
        "series":  "RWTC",    # Cushing, OK WTI Spot Price FOB (Dollars per Barrel)
    },
]


def fetch_oil_prices():
    """Fetch Brent and WTI spot prices from the EIA v2 API."""
    if not settings.EIA_API_KEY or settings.EIA_API_KEY == "your_eia_key_here":
        logger.warning("⚠  EIA API key not configured — oil prices disabled.")
        return

    logger.info("Fetching oil prices from EIA...")

    for q in PRICE_QUERIES:
        try:
            params = {
                "api_key":              settings.EIA_API_KEY,
                "frequency":            "daily",
                "data[0]":              "value",
                "facets[series][]":     q["series"],
                "sort[0][column]":      "period",
                "sort[0][direction]":   "desc",
                "length":               "5",
            }
            r = requests.get(
                f"{EIA_BASE}/petroleum/pri/spt/data/",
                params=params,
                timeout=15,
            )
            r.raise_for_status()
            data = r.json()
            items = data.get("response", {}).get("data", [])

            if not items:
                logger.warning(f"EIA returned no data for {q['product']}")
                continue

            with sqlite3.connect(DB_PATH, check_same_thread=False) as conn:
                for item in items[:3]:
                    period = item.get("period", "")
                    value  = item.get("value")
                    if value is None:
                        continue
                    conn.execute("""
                        INSERT OR REPLACE INTO oil_prices (product, price, period, updated_at)
                        VALUES (?, ?, ?, ?)
                    """, (
                        q["product"],
                        float(value),
                        period,
                        datetime.now(timezone.utc).isoformat(),
                    ))
                conn.commit()

            latest = items[0]
            logger.info(
                f"  {q['product']}: ${latest.get('value', '?'):.2f}/bbl "
                f"({latest.get('period', '')})"
            )

        except requests.HTTPError as e:
            logger.error(f"EIA HTTP error for {q['product']}: {e.response.status_code} — {e.response.text[:200]}")
        except Exception as e:
            logger.error(f"EIA fetch error for {q['product']}: {e}")
