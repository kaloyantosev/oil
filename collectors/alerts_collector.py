"""
Maritime security alerts derived from the news feed.

UKMTO's incident page renders client-side and has no public API, so incidents are not
scraped. Instead, news articles that describe a security event in a named maritime area
become map alerts, plotted at that area's reference point and linked to the article.
They are labelled as news-derived everywhere they appear.
"""
import logging
import re

from database import get_conn

logger = logging.getLogger(__name__)

# (pattern, area label, reference lat, lon). Order matters: specific before general.
AREAS = [
    (r"strait of hormuz|\bhormuz", "Strait of Hormuz", 26.57, 56.49),
    (r"gulf of oman|fujairah", "Gulf of Oman", 24.5, 58.0),
    (r"persian gulf|arabian gulf", "Persian Gulf", 27.0, 51.5),
    (r"bab[ -]el[ -]mandeb", "Bab el-Mandeb", 12.6, 43.46),
    (r"gulf of aden", "Gulf of Aden", 12.5, 47.5),
    (r"red sea|houthi", "Red Sea", 16.0, 41.0),
    (r"suez", "Suez Canal", 30.5, 32.3),
    (r"strait of malacca|\bmalacca|singapore strait", "Strait of Malacca", 2.5, 101.5),
    (r"south china sea", "South China Sea", 14.0, 114.0),
    (r"gulf of guinea|nigeria|bonny", "Gulf of Guinea", 3.0, 5.0),
    (r"black sea|bosphorus|novorossiysk", "Black Sea", 43.0, 35.0),
    (r"baltic|primorsk|ust-luga", "Baltic Sea", 58.5, 21.0),
    (r"arabian sea", "Arabian Sea", 16.0, 63.0),
    (r"somali", "Somali Basin", 4.0, 50.0),
]
_AREAS = [(re.compile(p, re.I), name, lat, lon) for p, name, lat, lon in AREAS]

_EVENT = re.compile(
    r"\b(attack|missile|drone|pirac|pirate|hijack|boarded|seiz|detain|explosion|blast|limpet mine|sea mine|"
    r"naval mine|struck by|hit by|fired upon|gunfire|suspicious approach|gps jamming|gps interference|"
    r"collision|grounding|ran aground)",
    re.I,
)
_WARNING = re.compile(r"\b(attack|missile|explosion|blast|hijack|seiz|struck by|hit by|fired upon|gunfire)", re.I)


def extract_alerts_from_news(lookback: int = 80) -> int:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT title, summary, link, source, published, created_at FROM news ORDER BY id DESC LIMIT ?",
            (lookback,),
        ).fetchall()
        known = {r[0] for r in conn.execute("SELECT link FROM incidents WHERE link IS NOT NULL")}

    new = []
    for r in rows:
        if r["link"] in known:
            continue
        text = f"{r['title']} {r['summary'] or ''}"
        if not _EVENT.search(text):
            continue
        area = next(((name, lat, lon) for rx, name, lat, lon in _AREAS if rx.search(text)), None)
        if not area:
            continue
        new.append((
            r["title"][:200], (r["summary"] or "")[:500], area[1], area[2], area[0],
            "warning" if _WARNING.search(text) else "advisory",
            f"News: {r['source']}", r["link"], r["published"] or r["created_at"],
        ))

    if new:
        with get_conn() as conn:
            conn.executemany(
                "INSERT INTO incidents (title, description, lat, lon, area, severity, source, link, published_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                new,
            )
        logger.info(f"Alerts: {len(new)} security alerts derived from news.")
    return len(new)
