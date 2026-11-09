"""
News collector: oil & shipping RSS feeds, keyword relevance filter, keyword tone tag,
and (optionally) a two-sentence Gemini brief for the newest articles.
"""
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import feedparser
import requests

from collectors.llm import generate
from config import settings
from database import get_conn

logger = logging.getLogger(__name__)


def _word_regex(words: list[str], prefix: bool = False) -> re.Pattern:
    """Whole-word match (or word-prefix match for stems like 'pirac')."""
    alts = "|".join(re.escape(w.lower()) for w in sorted(words, key=len, reverse=True))
    return re.compile(rf"\b(?:{alts})" + ("" if prefix else r"\b"), re.IGNORECASE)


_RELEVANT = _word_regex(settings.OIL_KEYWORDS)
_TAG_RE = re.compile(r"<[^>]+>")

# Tone from an oil-price perspective. Stems match word prefixes ("escalat" -> escalation).
_UP = _word_regex([
    "attack", "missile", "drone", "houthi", "pirac", "hijack", "disrupt", "blockade", "outage",
    "sanction", "seiz", "escalat", "explosion", "force majeure", "shut-in", "production cut",
    "output cut", "supply cut", "inventory draw", "stock draw", "deficit", "curtail",
], prefix=True)
_DOWN = _word_regex([
    "glut", "oversuppl", "surplus", "inventory build", "stock build", "weak demand", "recession",
    "slowdown", "output hike", "production increase", "quota increase", "ceasefire", "peace deal",
    "sanctions relief", "price war", "demand destruction",
], prefix=True)


def _strip_html(text: str) -> str:
    return re.sub(r"\s+", " ", _TAG_RE.sub(" ", text or "")).strip()


def classify_tone(text: str) -> str:
    up, down = len(_UP.findall(text)), len(_DOWN.findall(text))
    return "bullish" if up > down else "bearish" if down > up else "neutral"


def _fetch_feed(cfg: dict) -> list[dict]:
    try:
        r = requests.get(cfg["url"], headers={"User-Agent": settings.USER_AGENT}, timeout=15)
        r.raise_for_status()
    except Exception as e:
        logger.warning(f"RSS {cfg['name']}: {e}")
        return []
    items = []
    for entry in feedparser.parse(r.content).entries[:20]:
        title = (entry.get("title") or "").strip()
        link = (entry.get("link") or "").strip()
        summary = _strip_html(entry.get("summary") or entry.get("description") or "")[:1200]
        if not title or not link or not _RELEVANT.search(f"{title} {summary}"):
            continue
        published = None
        raw_date = entry.get("published") or entry.get("updated")
        if raw_date:
            try:
                published = parsedate_to_datetime(raw_date).astimezone(timezone.utc).isoformat()
            except Exception:
                published = None
        items.append({"title": title, "link": link, "source": cfg["name"], "published": published, "summary": summary})
    return items


def _ai_brief(title: str, summary: str):
    text = generate(
        "You are an oil market analyst. In exactly 2 sentences: (1) what happened, factually; "
        "(2) the plausible consequence for oil supply, shipping routes or prices. Do not invent facts "
        "beyond the text. If it is unrelated to oil, energy or shipping, reply only NOT_RELEVANT.\n\n"
        f"Headline: {title}\nDetails: {summary[:800]}"
    )
    return None if not text or "NOT_RELEVANT" in text else text


def fetch_news(with_ai: bool = True) -> int:
    """Fetch all feeds in parallel, store new relevant articles. Returns number of new articles."""
    with ThreadPoolExecutor(max_workers=len(settings.RSS_FEEDS)) as pool:
        items = [it for feed in pool.map(_fetch_feed, settings.RSS_FEEDS) for it in feed]

    with get_conn() as conn:
        known = {r[0] for r in conn.execute("SELECT link FROM news")}
    fresh = [it for it in items if it["link"] not in known]
    fresh.sort(key=lambda it: it["published"] or "", reverse=True)

    ai_budget = settings.MAX_AI_BRIEFS_PER_RUN if with_ai else 0
    for it in fresh:
        it["tone"] = classify_tone(f"{it['title']} {it['summary']}")
        it["ai_brief"] = None
        if ai_budget > 0:
            it["ai_brief"] = _ai_brief(it["title"], it["summary"])
            ai_budget -= 1

    with get_conn() as conn:
        conn.executemany(
            "INSERT OR IGNORE INTO news (title, link, source, published, summary, ai_brief, sentiment) "
            "VALUES (?,?,?,?,?,?,?)",
            [(it["title"], it["link"], it["source"], it["published"], it["summary"][:600], it["ai_brief"], it["tone"])
             for it in fresh],
        )
    logger.info(f"News: {len(fresh)} new of {len(items)} relevant items.")

    from collectors.alerts_collector import extract_alerts_from_news
    extract_alerts_from_news()
    return len(fresh)
