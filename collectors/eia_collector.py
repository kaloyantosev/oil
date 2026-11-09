"""EIA daily spot prices (Brent, WTI). Optional: needs EIA_API_KEY."""
import logging
from datetime import datetime, timezone

import requests

from config import settings
from database import get_conn

logger = logging.getLogger(__name__)

SERIES = {"Brent Crude": "RBRTE", "WTI Crude": "RWTC"}


def fetch_oil_prices():
    if not settings.EIA_API_KEY:
        logger.info("EIA_API_KEY not set: skipping EIA spot prices (market data still comes from futures).")
        return
    now = datetime.now(timezone.utc).isoformat()
    for product, series in SERIES.items():
        try:
            r = requests.get(
                "https://api.eia.gov/v2/petroleum/pri/spt/data/",
                params={
                    "api_key": settings.EIA_API_KEY, "frequency": "daily", "data[0]": "value",
                    "facets[series][]": series, "sort[0][column]": "period", "sort[0][direction]": "desc",
                    "length": "5",
                },
                timeout=15,
            )
            r.raise_for_status()
            items = [i for i in r.json().get("response", {}).get("data", []) if i.get("value") is not None]
            if not items:
                logger.warning(f"EIA returned no data for {product}")
                continue
            with get_conn() as conn:
                conn.executemany(
                    "INSERT OR REPLACE INTO oil_prices (product, price, period, updated_at) VALUES (?,?,?,?)",
                    [(product, float(i["value"]), i["period"], now) for i in items],
                )
            logger.info(f"EIA {product}: ${float(items[0]['value']):.2f}/bbl ({items[0]['period']})")
        except Exception as e:
            logger.error(f"EIA {product}: {e}")
