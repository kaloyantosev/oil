"""
Oil market analytics from real futures data (Yahoo Finance via yfinance).

- Live quotes: Brent, WTI, Henry Hub gas, RBOB gasoline, ULSD heating oil, and the two
  nearest WTI contracts (picked from the CME expiry rule, never hard-coded).
- Derived: Brent-WTI spread, 3:2:1 crack spread, WTI M1-M2 calendar spread.
- History: 10 years of daily front-month closes; monthly series for charts, and each live
  metric's percentile and z-score against its own last 5 years for context.
- Commentary: a factual summary built from those numbers, plus optional Gemini commentary.

Nothing here falls back to invented numbers: when data is missing the value is null.
"""
import logging
import math
import threading
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

from collectors.llm import generate

logger = logging.getLogger(__name__)

QUOTE_TTL = 300          # seconds
HISTORY_TTL = 6 * 3600
MEMO_TTL = 1800

FRONT = {"brent": "BZ=F", "wti": "CL=F", "natgas": "NG=F", "gasoline": "RB=F", "heating_oil": "HO=F"}
MONTH_CODES = "FGHJKMNQUVXZ"

# Reference levels, not a valuation model. Approximate public estimates; check before relying on them.
REFERENCE_LEVELS = [
    {"name": "Middle East onshore full-cycle cost", "value": 30, "note": "approx., low end of the global cost curve"},
    {"name": "US shale new-well breakeven (WTI)", "value": 65, "note": "approx., Dallas Fed Energy Survey 2025 average"},
    {"name": "Saudi Arabia fiscal breakeven (Brent)", "value": 90, "note": "approx., IMF estimate; a budget need, not a price floor"},
]

_lock = threading.Lock()
_cache: dict[str, tuple[float, Any]] = {}


def _cached(key: str, ttl: int, fn):
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        value = fn()
        if value is not None:
            _cache[key] = (time.time(), value)
        return value if value is not None else (hit[1] if hit else None)


# ── Contract selection ───────────────────────────────────────────────────────

def _prev_business_day(d: date) -> date:
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def cl_last_trade(year: int, month: int) -> date:
    """CME WTI (CL) last trade: 3 business days before the 25th of the month before delivery
    (4 if the 25th is not a business day). Exchange holidays are ignored (off by <=1 day)."""
    py, pm = (year, month - 1) if month > 1 else (year - 1, 12)
    d25 = date(py, pm, 25)
    d = d25 if d25.weekday() < 5 else _prev_business_day(d25)
    for _ in range(3):
        d = _prev_business_day(d - timedelta(days=1))
    return d


def wti_contracts(today: Optional[date] = None, n: int = 2) -> list[str]:
    """Yahoo symbols for the next n WTI contracts still trading."""
    today = today or datetime.now(timezone.utc).date()
    out, y, m = [], today.year, today.month
    while len(out) < n:
        if cl_last_trade(y, m) >= today:
            out.append(f"CL{MONTH_CODES[m - 1]}{y % 100:02d}.NYM")
        y, m = (y, m + 1) if m < 12 else (y + 1, 1)
    return out


# ── Data fetch ───────────────────────────────────────────────────────────────

def _download(tickers: list[str], **kw):
    import yfinance as yf
    df = yf.download(tickers, progress=False, auto_adjust=False, threads=True, **kw)
    if df is None or df.empty:
        return None
    return df["Close"]


def _fetch_quotes() -> Optional[dict]:
    m1, m2 = wti_contracts()
    symbols = list(FRONT.values()) + [m1, m2]
    try:
        close = _download(symbols, period="7d", interval="1d")
    except Exception as e:
        logger.warning(f"Quote download failed: {e}")
        return None
    if close is None:
        return None

    def last_two(sym):
        s = close[sym].dropna() if sym in close else []
        if len(s) == 0:
            return None, None, None
        return float(s.iloc[-1]), (float(s.iloc[-2]) if len(s) > 1 else None), s.index[-1].date().isoformat()

    q: dict[str, Any] = {"contracts": {"wti_m1": m1, "wti_m2": m2}}
    for name, sym in {**FRONT, "wti_m1": m1, "wti_m2": m2}.items():
        last, prev, asof = last_two(sym)
        q[name] = round(last, 4 if name in ("gasoline", "heating_oil") else 2) if last is not None else None
        q[f"{name}_chg"] = round(last - prev, 4 if name in ("gasoline", "heating_oil") else 2) if last is not None and prev is not None else None
        q[f"{name}_asof"] = asof

    q["spread"] = round(q["brent"] - q["wti"], 2) if q["brent"] is not None and q["wti"] is not None else None
    q["crack_321"] = _crack(q["gasoline"], q["heating_oil"], q["wti"])
    q["calendar_spread"] = (
        round(q["wti_m1"] - q["wti_m2"], 2) if q["wti_m1"] is not None and q["wti_m2"] is not None else None
    )
    q["fetched_at"] = datetime.now(timezone.utc).isoformat()
    return q if q["brent"] is not None or q["wti"] is not None else None


def _crack(rb, ho, cl):
    """3:2:1 crack in $/bbl: (2 x RBOB + 1 x ULSD, both $/gal x 42) - 3 x WTI, per barrel of crude."""
    if rb is None or ho is None or cl is None:
        return None
    return round((2 * rb * 42 + ho * 42 - 3 * cl) / 3, 2)


def _fetch_history() -> Optional[dict]:
    try:
        close = _download(list(FRONT.values()), period="10y", interval="1d")
    except Exception as e:
        logger.warning(f"History download failed: {e}")
        return None
    if close is None:
        return None
    df = close.rename(columns={v: k for k, v in FRONT.items()}).dropna(how="all")
    df["spread"] = df["brent"] - df["wti"]
    df["crack_321"] = (2 * df["gasoline"] * 42 + df["heating_oil"] * 42 - 3 * df["wti"]) / 3
    return {"daily": df}


def get_quotes() -> Optional[dict]:
    return _cached("quotes", QUOTE_TTL, _fetch_quotes)


def _history() -> Optional[dict]:
    return _cached("history", HISTORY_TTL, _fetch_history)


# ── Public API ───────────────────────────────────────────────────────────────

SERIES_META = {
    "brent": ("Brent crude (front month)", "$/bbl"),
    "wti": ("WTI crude (front month)", "$/bbl"),
    "spread": ("Brent-WTI spread", "$/bbl"),
    "crack_321": ("3:2:1 crack spread", "$/bbl"),
    "natgas": ("Henry Hub natural gas", "$/MMBtu"),
}


def get_historical_data() -> dict:
    """Monthly closes for charts (last trading day of each month)."""
    h = _history()
    if not h:
        return {"available": False, "dates": [], "series": {}}
    try:
        monthly = h["daily"].resample("ME").last()
    except ValueError:  # pandas < 2.2
        monthly = h["daily"].resample("M").last()
    dates = [d.strftime("%Y-%m") for d in monthly.index]

    def clean(col):
        return [None if (v is None or (isinstance(v, float) and math.isnan(v))) else round(float(v), 2) for v in monthly[col]]

    return {
        "available": True,
        "source": "Yahoo Finance continuous front-month futures, month-end close",
        "dates": dates,
        "series": {k: {"name": n, "unit": u, "data": clean(k)} for k, (n, u) in SERIES_META.items()},
    }


def _context(series, current: Optional[float]) -> Optional[dict]:
    """Percentile and z-score of the current value within the last 5 years of daily data."""
    if current is None or series is None:
        return None
    s = series.dropna()
    s = s[s.index >= s.index.max() - timedelta(days=5 * 365)]
    if len(s) < 250:
        return None
    pct = float((s < current).mean() * 100)
    sd = float(s.std())
    return {
        "percentile_5y": round(pct),
        "z_5y": round((current - float(s.mean())) / sd, 2) if sd > 0 else None,
        "min_5y": round(float(s.min()), 2),
        "max_5y": round(float(s.max()), 2),
        "median_5y": round(float(s.median()), 2),
    }


def _ord(n: int) -> str:
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def _fmt(x, d=2, sign=False):
    if x is None:
        return "n/a"
    return f"{x:+.{d}f}" if sign else f"{x:.{d}f}"


def _summary(q: dict, ctx: dict) -> list[str]:
    lines = []
    if q.get("brent") is not None:
        c = ctx.get("brent") or {}
        lines.append(
            f"Brent ${_fmt(q['brent'])}/bbl ({_fmt(q.get('brent_chg'), sign=True)} on the day)"
            + (f", {_ord(c['percentile_5y'])} percentile of its 5-year range (${c['min_5y']}-${c['max_5y']})." if c else ".")
        )
    cs = q.get("calendar_spread")
    if cs is not None:
        shape = "backwardation: prompt barrels priced above next month, a sign of tight near-term supply" if cs > 0.05 else \
                "contango: prompt barrels priced below next month, a sign of ample near-term supply" if cs < -0.05 else \
                "flat between the two nearest contracts"
        lines.append(f"WTI {q['contracts']['wti_m1'].split('.')[0]}-{q['contracts']['wti_m2'].split('.')[0]} spread {_fmt(cs, sign=True)} $/bbl, {shape}.")
    if q.get("crack_321") is not None:
        c = ctx.get("crack_321") or {}
        lines.append(
            f"3:2:1 crack ${_fmt(q['crack_321'])}/bbl"
            + (f", {_ord(c['percentile_5y'])} percentile of 5 years (median ${c['median_5y']})." if c else ".")
        )
    if q.get("spread") is not None:
        c = ctx.get("spread") or {}
        lines.append(
            f"Brent-WTI ${_fmt(q['spread'])}/bbl"
            + (f", {_ord(c['percentile_5y'])} percentile of 5 years (median ${c['median_5y']})." if c else ".")
        )
    if q.get("brent") is not None:
        above = [r["name"] for r in REFERENCE_LEVELS if q["brent"] >= r["value"]]
        below = [r["name"] for r in REFERENCE_LEVELS if q["brent"] < r["value"]]
        if below:
            lines.append(f"Brent is below the {below[0].lower()} (~${next(r['value'] for r in REFERENCE_LEVELS if r['name'] == below[0])}).")
        elif above:
            lines.append("Brent is above all reference cost and fiscal levels shown.")
    return lines


def get_analysis(news: list[dict]) -> dict:
    q = get_quotes()
    if not q:
        return {"available": False, "error": "Market data unavailable (Yahoo Finance did not respond).",
                "reference_levels": REFERENCE_LEVELS}
    h = _history()
    daily = h["daily"] if h else None
    ctx = {}
    if daily is not None:
        for k in ("brent", "wti", "spread", "crack_321", "natgas"):
            ctx[k] = _context(daily[k], q.get(k))
    summary = _summary(q, ctx)
    commentary = _cached(f"memo:{q.get('brent')}:{q.get('wti')}", MEMO_TTL, lambda: _ai_commentary(summary, news))
    return {
        "available": True,
        "quotes": q,
        "context": ctx,
        "summary": summary,
        "ai_commentary": commentary,
        "reference_levels": REFERENCE_LEVELS,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def _ai_commentary(summary: list[str], news: list[dict]) -> str:
    # Returns "" when AI is unavailable, so the empty result is cached too (no retry on every request).
    headlines = "\n".join(f"- {n.get('title', '')}" for n in news[:8])
    return generate(
        "You are a commodities analyst. Using ONLY the facts and headlines below, write 3 short bullet points "
        "(max 90 words total) on what is driving crude right now and what to watch over the next few weeks. "
        "No price targets, no invented numbers, no author or book references.\n\n"
        "FACTS:\n" + "\n".join(f"- {s}" for s in summary) + f"\n\nHEADLINES:\n{headlines}"
    ) or ""
