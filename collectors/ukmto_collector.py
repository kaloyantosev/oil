"""
UKMTO & Maritime Incident Collector
Scrapes UKMTO and related maritime security sites for disruption advisories.
Geo-codes incidents to known chokepoint coordinates for map display.
"""
import logging
import re
import sqlite3
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

from database import DB_PATH

logger = logging.getLogger(__name__)

SOURCES = [
    {
        "name":   "UKMTO",
        "url":    "https://www.ukmto.org/indian-ocean/recent-incidents/",
        "backup": "https://www.ukmto.org/",
    },
]

# Chokepoint coordinates for text-based geo-coding
CHOKEPOINT_COORDS = {
    "strait of hormuz":  (26.57,  56.49),
    "hormuz":            (26.57,  56.49),
    "gulf of oman":      (22.50,  59.00),
    "persian gulf":      (26.50,  52.00),
    "arabian sea":       (15.00,  65.00),
    "red sea":           (20.00,  38.50),
    "bab el-mandeb":     (12.60,  43.46),
    "gulf of aden":      (12.50,  47.50),
    "suez":              (30.50,  32.30),
    "suez canal":        (30.50,  32.30),
    "malacca":           ( 2.50, 101.50),
    "strait of malacca": ( 2.50, 101.50),
    "south china sea":   (14.00, 114.00),
    "gulf of guinea":    ( 1.50,   3.00),
    "west africa":       ( 5.00,   2.00),
    "bosphorus":         (41.12,  29.12),
    "black sea":         (43.00,  35.00),
    "mediterranean":     (35.00,  18.00),
    "north sea":         (56.00,   3.00),
    "indian ocean":      (-5.00,  80.00),
}


def _geocode(text: str):
    """Return (lat, lon) based on text mention of known maritime areas."""
    tl = text.lower()
    for name, coords in CHOKEPOINT_COORDS.items():
        if name in tl:
            return coords
    return (None, None)


def _detect_area(text: str) -> str:
    tl = text.lower()
    if any(w in tl for w in ["red sea", "gulf of aden", "bab el-mandeb"]):
        return "Red Sea / Gulf of Aden"
    if any(w in tl for w in ["hormuz", "persian gulf", "gulf of oman"]):
        return "Persian Gulf / Strait of Hormuz"
    if any(w in tl for w in ["malacca", "south china sea"]):
        return "Strait of Malacca"
    if any(w in tl for w in ["suez", "mediterranean"]):
        return "Suez / Mediterranean"
    if any(w in tl for w in ["bosphorus", "black sea"]):
        return "Bosphorus / Black Sea"
    if any(w in tl for w in ["gulf of guinea", "west africa", "nigeria", "ghana"]):
        return "Gulf of Guinea"
    if any(w in tl for w in ["indian ocean", "arabian sea"]):
        return "Indian Ocean"
    return "Global Maritime"


def _detect_severity(text: str) -> str:
    tl = text.lower()
    if any(w in tl for w in ["attack", "fire", "piracy", "hostile", "armed", "explosion", "warning"]):
        return "warning"
    if any(w in tl for w in ["advisory", "caution", "suspicious", "drone", "missile"]):
        return "advisory"
    return "information"


def _save_incidents(incidents: list):
    new_count = 0
    with sqlite3.connect(DB_PATH, check_same_thread=False) as conn:
        for inc in incidents:
            # Deduplicate by title
            exists = conn.execute(
                "SELECT id FROM incidents WHERE title=?", (inc["title"],)
            ).fetchone()
            if exists:
                continue

            conn.execute("""
                INSERT INTO incidents
                    (title, description, lat, lon, area, severity, source, published_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                inc["title"], inc["description"],
                inc["lat"],   inc["lon"],
                inc["area"],  inc["severity"],
                inc["source"], inc["published_at"],
            ))
            new_count += 1
        conn.commit()
    return new_count


def fetch_ukmto_incidents():
    """Scrape UKMTO advisory page and save incidents."""
    logger.info("Fetching maritime security advisories...")
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0 Safari/537.36"
        )
    }

    for src in SOURCES:
        try:
            r = requests.get(src["url"], headers=headers, timeout=20)
            if r.status_code != 200:
                # Try backup URL
                r = requests.get(src.get("backup", src["url"]), headers=headers, timeout=20)
                if r.status_code != 200:
                    logger.warning(f"{src['name']}: HTTP {r.status_code}")
                    continue

            soup = BeautifulSoup(r.text, "lxml")
            incidents = []

            # Strategy: find all heading-like elements and their surrounding text
            for tag in soup.find_all(["h1", "h2", "h3", "h4", "article", "li"]):
                text = tag.get_text(separator=" ", strip=True)
                if len(text) < 20 or len(text) > 600:
                    continue

                # Must contain maritime-relevant keywords
                tl = text.lower()
                if not any(k in tl for k in [
                    "vessel", "ship", "tanker", "incident", "advisory",
                    "warning", "attack", "pirac", "drilled", "suspicious",
                    "gulf", "sea", "strait", "canal", "hormuz", "aden",
                ]):
                    continue

                lat, lon = _geocode(text)
                inc = {
                    "title":        text[:200],
                    "description":  text[:500],
                    "lat":          lat,
                    "lon":          lon,
                    "area":         _detect_area(text),
                    "severity":     _detect_severity(text),
                    "source":       src["name"],
                    "published_at": datetime.now(timezone.utc).isoformat(),
                }
                incidents.append(inc)

            if incidents:
                saved = _save_incidents(incidents[:15])
                logger.info(f"{src['name']}: {saved} new incidents saved.")
            else:
                logger.info(f"{src['name']}: No new incidents found (or site structure changed).")

        except Exception as e:
            logger.error(f"{src['name']} fetch error: {e}")

    # Fallback / Complementary: Harvest security advisories & incidents from ingested maritime news
    try:
        harvest_incidents_from_news()
    except Exception as e:
        logger.warning(f"Error harvesting incidents from news: {e}")


def harvest_incidents_from_news():
    """Extract maritime security incidents and chokepoint alerts from news items."""
    security_keywords = [
        "attack", "missile", "drone", "houthi", "pirac", "hijack", "seiz",
        "explosion", "fire", "warning", "advisory", "suspicious", "strait of hormuz",
        "red sea", "bab el-mandeb", "gulf of aden", "strait crossings"
    ]
    with sqlite3.connect(DB_PATH, check_same_thread=False) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT title, summary, link, source, published, created_at FROM news ORDER BY id DESC LIMIT 50").fetchall()

    incidents = []
    for r in rows:
        combined = f"{r['title']} {r['summary'] or ''}".lower()
        if any(kw in combined for kw in security_keywords):
            lat, lon = _geocode(combined)
            if lat is not None and lon is not None:
                incidents.append({
                    "title": r["title"][:200],
                    "description": (r["summary"] or r["title"])[:500],
                    "lat": lat,
                    "lon": lon,
                    "area": _detect_area(combined),
                    "severity": _detect_severity(combined),
                    "source": f"{r['source']} Alert",
                    "published_at": r["published"] or r["created_at"],
                })

    if incidents:
        saved = _save_incidents(incidents[:20])
        if saved > 0:
            logger.info(f"Maritime Intel: {saved} incidents extracted from shipping alerts.")
