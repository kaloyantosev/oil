import os
from dotenv import load_dotenv

load_dotenv()


class Settings:
    AISSTREAM_API_KEY: str = os.getenv("AISSTREAM_API_KEY", "")
    EIA_API_KEY: str = os.getenv("EIA_API_KEY", "")
    GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "")

    RSS_FEEDS = [
        {"url": "https://gcaptain.com/feed/", "name": "gCaptain"},
        {"url": "https://splash247.com/feed/", "name": "Splash247"},
        {"url": "https://www.hellenicshippingnews.com/feed/", "name": "Hellenic Shipping"},
        {"url": "https://www.offshoreenergytoday.com/feed/", "name": "Offshore Energy"},
        {"url": "https://feeds.reuters.com/reuters/businessNews", "name": "Reuters Business"},
        {"url": "https://www.tankeroperator.com/rss/", "name": "Tanker Operator"},
    ]

    OIL_KEYWORDS = [
        "oil", "crude", "tanker", "brent", "wti", "opec", "petroleum",
        "shipping", "vessel", "maritime", "suez", "hormuz", "bab el-mandeb",
        "malacca", "gulf", "energy", "refinery", "LNG", "LPG", "cargo",
        "VLCC", "discharge", "freight", "bunker", "barrel", "pipeline",
        "sanctions", "embargo", "chokepoint", "disruption", "attack",
        "piracy", "Red Sea", "Arabian Sea", "Persian Gulf",
    ]


settings = Settings()
