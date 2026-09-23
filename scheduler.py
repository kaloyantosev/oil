"""
Background Scheduler
Runs EIA price fetches, RSS news collection, and UKMTO scraping on a schedule.
All jobs run in a thread pool — no async needed here.
"""
import logging
from datetime import datetime

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

from collectors.eia_collector import fetch_oil_prices
from collectors.news_collector import fetch_news
from collectors.ukmto_collector import fetch_ukmto_incidents

logger = logging.getLogger(__name__)

_scheduler = BackgroundScheduler(timezone="UTC")


def start_scheduler():
    now = datetime.utcnow()

    # ── News: every 30 minutes, run immediately on startup ──────────────────
    _scheduler.add_job(
        fetch_news,
        trigger=IntervalTrigger(minutes=30),
        id="fetch_news",
        replace_existing=True,
        max_instances=1,
        next_run_time=now,
    )

    # ── Oil prices: every 6 hours, run immediately on startup ───────────────
    _scheduler.add_job(
        fetch_oil_prices,
        trigger=IntervalTrigger(hours=6),
        id="fetch_prices",
        replace_existing=True,
        max_instances=1,
        next_run_time=now,
    )

    # ── UKMTO advisories: every hour, run immediately on startup ────────────
    _scheduler.add_job(
        fetch_ukmto_incidents,
        trigger=IntervalTrigger(hours=1),
        id="fetch_ukmto",
        replace_existing=True,
        max_instances=1,
        next_run_time=now,
    )

    _scheduler.start()
    logger.info("✓ Background scheduler started (news/30 min, prices/6 h, UKMTO/1 h)")


def stop_scheduler():
    if _scheduler.running:
        _scheduler.shutdown(wait=False)
