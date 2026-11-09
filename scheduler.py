"""Background jobs (persistent hosts only): news + derived alerts every 30 min, EIA prices every 6 h."""
import logging
from datetime import datetime, timezone

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

from collectors.eia_collector import fetch_oil_prices
from collectors.news_collector import fetch_news

logger = logging.getLogger(__name__)
_scheduler = BackgroundScheduler(timezone="UTC")


def start_scheduler():
    now = datetime.now(timezone.utc)
    for fn, trigger, job_id in (
        (fetch_news, IntervalTrigger(minutes=30), "news"),
        (fetch_oil_prices, IntervalTrigger(hours=6), "eia_prices"),
    ):
        _scheduler.add_job(fn, trigger=trigger, id=job_id, replace_existing=True, max_instances=1,
                           coalesce=True, next_run_time=now)
    _scheduler.start()
    logger.info("Scheduler started: news/alerts every 30 min, EIA prices every 6 h.")


def stop_scheduler():
    if _scheduler.running:
        _scheduler.shutdown(wait=False)
