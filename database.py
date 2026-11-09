"""SQLite storage. One small local file; WAL mode so readers never block the AIS writer."""
import logging
import os
import sqlite3
import tempfile
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# MMSIs of the simulated "Hormuz fleet" that earlier versions inserted alongside real AIS data.
# They are purged from any existing database on startup.
_SIMULATED_MMSIS = (
    "403512000", "422038100", "352002235", "447012000", "241029000", "538008123", "413000543",
    "538006888", "205423000", "403529000", "241412000", "447035000", "466042000", "470123000",
    "403567000", "422099000", "413009876", "241088000", "538007456", "470889000",
)


def is_serverless() -> bool:
    """True on Vercel / AWS Lambda, where only the temp dir is writable and no background work runs."""
    markers = ("VERCEL", "AWS_LAMBDA_FUNCTION_NAME", "LAMBDA_TASK_ROOT")
    return any(os.environ.get(m) for m in markers)


DB_PATH = os.environ.get("OILWATCH_DB") or (
    os.path.join(tempfile.gettempdir(), "oilwatch.db") if is_serverless() else os.path.join(BASE_DIR, "oilwatch.db")
)


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 10000")
    return conn


def init_db():
    logger.info(f"Database: {DB_PATH}")
    with get_conn() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS vessels (
            mmsi        TEXT PRIMARY KEY,
            name        TEXT DEFAULT '',
            lat         REAL,
            lon         REAL,
            sog         REAL DEFAULT 0,
            cog         REAL DEFAULT 0,
            heading     REAL DEFAULT 0,
            ship_type   INTEGER,
            destination TEXT DEFAULT '',
            callsign    TEXT DEFAULT '',
            length      INTEGER DEFAULT 0,
            draught     REAL DEFAULT 0,
            updated_at  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_vessels_updated ON vessels(updated_at DESC);

        CREATE TABLE IF NOT EXISTS news (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            title      TEXT NOT NULL,
            link       TEXT UNIQUE NOT NULL,
            source     TEXT,
            published  TEXT,
            summary    TEXT,
            ai_brief   TEXT,
            sentiment  TEXT DEFAULT 'neutral',
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_news_created ON news(created_at DESC);

        CREATE TABLE IF NOT EXISTS oil_prices (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            product    TEXT NOT NULL,
            price      REAL NOT NULL,
            unit       TEXT DEFAULT 'USD/bbl',
            period     TEXT NOT NULL,
            updated_at TEXT DEFAULT (datetime('now')),
            UNIQUE(product, period)
        );

        CREATE TABLE IF NOT EXISTS incidents (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            title        TEXT NOT NULL,
            description  TEXT,
            lat          REAL,
            lon          REAL,
            area         TEXT,
            severity     TEXT DEFAULT 'advisory',
            source       TEXT,
            link         TEXT,
            published_at TEXT,
            created_at   TEXT DEFAULT (datetime('now'))
        );
        """)
        for col_sql in (
            "ALTER TABLE vessels ADD COLUMN draught REAL DEFAULT 0",
            "ALTER TABLE news ADD COLUMN sentiment TEXT DEFAULT 'neutral'",
            "ALTER TABLE incidents ADD COLUMN link TEXT",
        ):
            try:
                conn.execute(col_sql)
            except sqlite3.OperationalError:
                pass

        # Clean out data earlier versions produced that was not real.
        purged = conn.execute(
            f"DELETE FROM vessels WHERE mmsi IN ({','.join('?' * len(_SIMULATED_MMSIS))})", _SIMULATED_MMSIS
        ).rowcount
        purged += conn.execute("DELETE FROM incidents WHERE source = 'UKMTO'").rowcount  # scraped page navigation
        purged += conn.execute("DELETE FROM oil_prices WHERE period = 'Live'").rowcount
        if purged:
            logger.info(f"Removed {purged} simulated or invalid rows left by earlier versions.")
    logger.info("Database ready.")


def save_vessels(vessels: list[dict]):
    """Upsert a batch of vessel reports in one transaction."""
    if not vessels:
        return
    rows = [
        (
            v.get("mmsi"), v.get("name", ""), v.get("lat"), v.get("lon"), v.get("sog", 0), v.get("cog", 0),
            v.get("heading", 0), v.get("ship_type"), v.get("destination", ""), v.get("callsign", ""),
            v.get("length", 0), v.get("draught", 0), v.get("updated_at", ""),
        )
        for v in vessels
    ]
    with get_conn() as conn:
        conn.executemany("""
            INSERT INTO vessels
                (mmsi, name, lat, lon, sog, cog, heading, ship_type, destination, callsign, length, draught, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(mmsi) DO UPDATE SET
                lat = excluded.lat, lon = excluded.lon, sog = excluded.sog, cog = excluded.cog,
                heading = excluded.heading,
                ship_type   = COALESCE(excluded.ship_type, vessels.ship_type),
                destination = COALESCE(NULLIF(excluded.destination,''), vessels.destination),
                callsign    = COALESCE(NULLIF(excluded.callsign,''), vessels.callsign),
                length      = CASE WHEN excluded.length > 0 THEN excluded.length ELSE vessels.length END,
                draught     = CASE WHEN excluded.draught > 0 THEN excluded.draught ELSE vessels.draught END,
                name        = COALESCE(NULLIF(excluded.name,''), vessels.name),
                updated_at  = excluded.updated_at
        """, rows)


def get_known_tankers() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT mmsi, name, ship_type, length, destination, callsign, draught FROM vessels "
            "WHERE ship_type BETWEEN 80 AND 89"
        ).fetchall()
        return [dict(r) for r in rows]


def get_current_vessels(limit: int = 1500, max_age_hours: int = 48):
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=max_age_hours)).isoformat()
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT * FROM vessels
            WHERE lat IS NOT NULL
              AND ship_type BETWEEN 80 AND 89
              AND (length >= 115 OR length = 0 OR length IS NULL)
              AND updated_at >= ?
            ORDER BY updated_at DESC
            LIMIT ?
        """, (cutoff, limit)).fetchall()
        return [dict(r) for r in rows]


def get_latest_vessel_timestamp() -> str:
    with get_conn() as conn:
        row = conn.execute("SELECT MAX(updated_at) FROM vessels WHERE lat IS NOT NULL").fetchone()
        return row[0] if row and row[0] else ""


def get_news(limit: int = 30):
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT id, title, link, source, published, summary, ai_brief, sentiment, created_at
            FROM news
            ORDER BY COALESCE(published, created_at) DESC
            LIMIT ?
        """, (limit,)).fetchall()
        return [dict(r) for r in rows]


def get_oil_prices():
    """Latest EIA spot price per product."""
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT product, price, unit, period, updated_at FROM oil_prices o
            WHERE period = (SELECT MAX(period) FROM oil_prices WHERE product = o.product)
            ORDER BY product
        """).fetchall()
        return [dict(r) for r in rows]


def get_incidents(limit: int = 50):
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT * FROM incidents
            ORDER BY COALESCE(published_at, created_at) DESC
            LIMIT ?
        """, (limit,)).fetchall()
        return [dict(r) for r in rows]
