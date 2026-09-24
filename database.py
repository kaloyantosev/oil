import os
import shutil
import sqlite3
import logging

import tempfile

logger = logging.getLogger(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SEED_DB  = os.path.join(BASE_DIR, "oilwatch.db")

def is_serverless() -> bool:
    """Detect if running in Vercel, AWS Lambda, or a read-only container."""
    serverless_vars = [
        "VERCEL", "VERCEL_ENV", "VERCEL_REGION", "NOW_REGION",
        "AWS_LAMBDA_FUNCTION_NAME", "LAMBDA_TASK_ROOT", "AWS_EXECUTION_ENV",
        "_HANDLER"
    ]
    for var in serverless_vars:
        if os.environ.get(var):
            return True
    if os.path.exists("/var/task") or os.path.exists("/var/runtime"):
        return True
    try:
        test_file = os.path.join(BASE_DIR, ".write_check")
        with open(test_file, "w") as f:
            f.write("ok")
        if os.path.exists(test_file):
            os.remove(test_file)
        return False
    except Exception:
        return True

# On Vercel / AWS Lambda / Serverless platforms, only temp dir is writable
if is_serverless():
    tmp_dir = tempfile.gettempdir()
    os.makedirs(tmp_dir, exist_ok=True)
    DB_PATH = os.path.join(tmp_dir, "oilwatch.db")
    if not os.path.exists(DB_PATH) and os.path.exists(SEED_DB):
        try:
            shutil.copyfile(SEED_DB, DB_PATH)
            logger.info(f"Copied seeded oilwatch.db to {DB_PATH}")
        except Exception as e:
            logger.warning(f"Could not copy seeded db to temp: {e}")
else:
    DB_PATH = SEED_DB


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Create all tables if they don't exist."""
    logger.info(f"Initializing database at {DB_PATH}...")
    try:
        with get_conn() as conn:
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
                source       TEXT DEFAULT 'UKMTO',
                published_at TEXT,
                created_at   TEXT DEFAULT (datetime('now'))
            );
        """)
        # Safe column migrations for existing databases
        for col_sql in [
            "ALTER TABLE vessels ADD COLUMN draught REAL DEFAULT 0",
            "ALTER TABLE news ADD COLUMN sentiment TEXT DEFAULT 'neutral'"
        ]:
            try:
                conn.execute(col_sql)
            except sqlite3.OperationalError:
                pass
        logger.info("Database ready.")
    except Exception as e:
        logger.error(f"init_db encountered error: {e}", exc_info=True)


def get_current_vessels(limit: int = 800):
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT * FROM vessels
            WHERE lat IS NOT NULL
              AND ship_type BETWEEN 80 AND 89
              AND (length >= 115 OR length = 0 OR length IS NULL)
            ORDER BY updated_at DESC, length DESC
            LIMIT ?
        """, (limit,)).fetchall()
        return [dict(r) for r in rows]


def get_latest_vessel_timestamp() -> str:
    with get_conn() as conn:
        row = conn.execute("SELECT MAX(updated_at) FROM vessels WHERE lat IS NOT NULL").fetchone()
        return row[0] if row and row[0] else ""


def get_news(limit: int = 30):
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT id, title, link, source, published, ai_brief, sentiment, created_at
            FROM news
            ORDER BY created_at DESC
            LIMIT ?
        """, (limit,)).fetchall()
        return [dict(r) for r in rows]


def get_oil_prices():
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT product, price, unit, period, updated_at
            FROM oil_prices
            ORDER BY product, period DESC
        """).fetchall()
        # Return latest per product only
        seen = {}
        for row in [dict(r) for r in rows]:
            p = row["product"]
            if p not in seen:
                seen[p] = row
        return list(seen.values())


def get_incidents():
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT * FROM incidents
            ORDER BY created_at DESC
            LIMIT 50
        """).fetchall()
        return [dict(r) for r in rows]
