import os
from dotenv import load_dotenv

load_dotenv()

_PLACEHOLDERS = {"", "your_aisstream_key_here", "your_eia_key_here", "your_gemini_key_here"}


def _key(name: str) -> str:
    v = os.getenv(name, "").strip()
    return "" if v in _PLACEHOLDERS else v


class Settings:
    AISSTREAM_API_KEY: str = _key("AISSTREAM_API_KEY")
    EIA_API_KEY: str = _key("EIA_API_KEY")
    GEMINI_API_KEY: str = _key("GEMINI_API_KEY")
    GEMINI_MODEL: str = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

    # Cap AI briefs per news run so a cold start doesn't burn the free quota.
    MAX_AI_BRIEFS_PER_RUN: int = int(os.getenv("MAX_AI_BRIEFS_PER_RUN", "8"))
    # Hide vessels whose last AIS report is older than this.
    VESSEL_MAX_AGE_HOURS: int = int(os.getenv("VESSEL_MAX_AGE_HOURS", "48"))

    USER_AGENT = "OilWatch/1.1 (+https://github.com/kaloyantosev/oil)"

    RSS_FEEDS = [
        {"url": "https://gcaptain.com/feed/", "name": "gCaptain"},
        {"url": "https://splash247.com/feed/", "name": "Splash247"},
        {"url": "https://www.hellenicshippingnews.com/feed/", "name": "Hellenic Shipping"},
        {"url": "https://www.offshore-energy.biz/feed/", "name": "Offshore Energy"},
    ]

    # Whole-word / phrase matches (case-insensitive) for oil & shipping relevance.
    OIL_KEYWORDS = [
        "oil", "crude", "tanker", "tankers", "brent", "wti", "opec", "opec+", "petroleum",
        "vlcc", "suezmax", "aframax", "refinery", "refining", "lng", "lpg", "barrel", "barrels",
        "bunker", "bunkering", "freight", "pipeline", "sanctions", "embargo", "chokepoint",
        "suez", "hormuz", "bab el-mandeb", "malacca", "red sea", "persian gulf", "arabian sea",
        "houthi", "piracy", "shadow fleet",
    ]

    # When a page is served without background workers (Vercel), refresh lazily at most this often.
    SERVERLESS_REFRESH_MINUTES: int = 30


settings = Settings()
