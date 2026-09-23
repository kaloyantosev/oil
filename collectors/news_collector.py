"""
News Collector
Fetches oil and maritime news from multiple RSS feeds.
Uses Gemini AI to generate a 2-sentence "what to expect" brief for each article.
"""
import logging
import re
import sqlite3
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Optional

import feedparser
import requests

from config import settings

logger = logging.getLogger(__name__)

OIL_KEYWORDS = [kw.lower() for kw in settings.OIL_KEYWORDS]

# Simple HTML tag stripper
_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(text: str) -> str:
    return _TAG_RE.sub("", text or "").strip()


def _is_relevant(title: str, body: str = "") -> bool:
    combined = (title + " " + body).lower()
    return any(kw in combined for kw in OIL_KEYWORDS)


def _get_ai_brief(title: str, content: str) -> Optional[str]:
    """Call Gemini 1.5 Flash to generate a 'what to expect' brief."""
    if not settings.GEMINI_API_KEY or settings.GEMINI_API_KEY == "your_gemini_key_here":
        return None

    try:
        import google.generativeai as genai
        genai.configure(api_key=settings.GEMINI_API_KEY)
        model = genai.GenerativeModel("gemini-3.6-flash")

        prompt = (
            "You are an oil market intelligence analyst.\n\n"
            f"News headline: {title}\n"
            f"Details: {content[:800]}\n\n"
            "Write EXACTLY 2 sentences:\n"
            "1. What happened (factual, specific).\n"
            "2. What oil market participants should expect as a consequence "
            "(prices, routes, supply/demand impact).\n\n"
            "If the article is completely unrelated to oil, energy, or shipping, "
            "respond only with: NOT_RELEVANT"
        )

        response = model.generate_content(prompt)
        brief = response.text.strip()

        if "NOT_RELEVANT" in brief:
            return None
        return brief

    except Exception as e:
        logger.warning(f"Gemini error: {e}")
        return None


# ── Sentiment Keywords (Aligned strictly: Bullish = Oil Price Rising, Bearish = Oil Price Falling)
BULLISH_KEYWORDS = [
    "attack", "missile", "drone", "houthi", "pirac", "disrupt", "strait", "hormuz",
    "cut", "surge", "spike", "outage", "strike", "blockade", "sanction", "closure",
    "seiz", "tension", "curtail", "tight", "escalat", "war", "conflict", "explosion",
    "draw", "deficit", "pipeline halt", "force majeure", "shut-in", "output reduction"
]

BEARISH_KEYWORDS = [
    "drop", "plunge", "fall", "slump", "inventory build", "glut", "recession",
    "weak demand", "oversupply", "cheating", "surplus", "slowdown", "weakness",
    "stockpile increase", "output hike", "quota increase", "ceasefire", "peace deal", "sanction relief"
]


def _classify_sentiment(title: str, summary: str = "") -> str:
    """
    Classifies market sentiment from an oil price perspective:
    - 'bullish': indicates upward pressure on crude oil prices (supply curbs, geopolitical risk, inventory draw).
    - 'bearish': indicates downward pressure on crude oil prices (demand destruction, surplus, supply hikes).
    - 'neutral': balanced or routine operational news.
    """
    combined = (title + " " + (summary or "")).lower()
    bull_count = sum(1 for kw in BULLISH_KEYWORDS if kw in combined)
    bear_count = sum(1 for kw in BEARISH_KEYWORDS if kw in combined)
    if bull_count > bear_count and bull_count > 0:
        return "bullish"
    elif bear_count > bull_count and bear_count > 0:
        return "bearish"
    return "neutral"


def fetch_news():
    """Pull all RSS feeds, filter for oil relevance, store with AI briefs."""
    logger.info("Fetching news feeds...")
    new_count = 0

    for feed_cfg in settings.RSS_FEEDS:
        try:
            # feedparser handles encoding/redirects automatically
            parsed = feedparser.parse(feed_cfg["url"])
            entries = parsed.entries[:15]

            for entry in entries:
                title   = (entry.get("title", "") or "").strip()
                link    = (entry.get("link",  "") or "").strip()
                summary = _strip_html(
                    entry.get("summary", "") or entry.get("description", "") or ""
                )[:1200]

                if not title or not link:
                    continue

                if not _is_relevant(title, summary):
                    continue

                # Parse publication date
                published = None
                raw_date = entry.get("published") or entry.get("updated")
                if raw_date:
                    try:
                        published = parsedate_to_datetime(raw_date).isoformat()
                    except Exception:
                        published = datetime.now(timezone.utc).isoformat()

                # Skip duplicates
                with sqlite3.connect("oilwatch.db", check_same_thread=False) as conn:
                    if conn.execute(
                        "SELECT id FROM news WHERE link=?", (link,)
                    ).fetchone():
                        continue

                # Generate AI brief and sentiment
                ai_brief = _get_ai_brief(title, summary)
                sentiment = _classify_sentiment(title, summary)

                # Store in DB
                with sqlite3.connect("oilwatch.db", check_same_thread=False) as conn:
                    conn.execute("""
                        INSERT OR IGNORE INTO news
                            (title, link, source, published, summary, ai_brief, sentiment)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    """, (
                        title,
                        link,
                        feed_cfg["name"],
                        published,
                        summary[:600],
                        ai_brief,
                        sentiment,
                    ))
                    conn.commit()

                new_count += 1

        except Exception as e:
            logger.error(f"RSS error [{feed_cfg['name']}]: {e}")

    logger.info(f"News: {new_count} new articles saved.")
