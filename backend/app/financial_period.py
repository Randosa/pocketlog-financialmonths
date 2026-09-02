"""Configurable financial-month boundaries.

Transactions retain their real calendar date. This module only determines
which reporting period contains a date. ``FINANCIAL_MONTH_START_DAY`` is read
once at process start, defaults to the existing calendar behaviour (1), and
accepts 1 through 31. For a day that does not exist in a short month, the
period begins on that month's final day.
"""

from __future__ import annotations

import calendar
import os
from datetime import date, timedelta


def _configured_start_day() -> int:
    raw = os.environ.get("FINANCIAL_MONTH_START_DAY", "1").strip()
    try:
        value = int(raw)
    except ValueError:
        value = 1
    return value if 1 <= value <= 31 else 1


MONTH_START_DAY = _configured_start_day()


def _month_start(year: int, month: int) -> date:
    return date(year, month, min(MONTH_START_DAY, calendar.monthrange(year, month)[1]))


def _shift_month(year: int, month: int, delta: int) -> tuple[int, int]:
    index = year * 12 + (month - 1) + delta
    return index // 12, index % 12 + 1


def period_for_anchor(year: int, month: int) -> tuple[date, date]:
    """Inclusive period whose anchor is calendar ``year/month`` (one-based)."""
    start = _month_start(year, month)
    next_year, next_month = _shift_month(year, month, 1)
    return start, _month_start(next_year, next_month) - timedelta(days=1)


def period_for_date(value: date) -> tuple[date, date]:
    """Return the inclusive financial period containing ``value``."""
    this_start = _month_start(value.year, value.month)
    if value < this_start:
        year, month = _shift_month(value.year, value.month, -1)
        return period_for_anchor(year, month)
    return period_for_anchor(value.year, value.month)


def financial_year(year: int) -> tuple[date, date]:
    """Inclusive financial year from that January anchor through December."""
    start, _ = period_for_anchor(year, 1)
    _, end = period_for_anchor(year, 12)
    return start, end

