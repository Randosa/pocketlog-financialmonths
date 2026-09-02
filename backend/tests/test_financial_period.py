from datetime import date

from app import financial_period


def _with_start_day(day: int):
    old = financial_period.MONTH_START_DAY
    financial_period.MONTH_START_DAY = day
    return old


def test_period_for_date_before_and_after_boundary():
    old = _with_start_day(16)
    try:
        assert financial_period.period_for_date(date(2026, 9, 2)) == (
            date(2026, 8, 16),
            date(2026, 9, 15),
        )
        assert financial_period.period_for_date(date(2026, 9, 15)) == (
            date(2026, 8, 16),
            date(2026, 9, 15),
        )
        assert financial_period.period_for_date(date(2026, 9, 16)) == (
            date(2026, 9, 16),
            date(2026, 10, 15),
        )
    finally:
        financial_period.MONTH_START_DAY = old


def test_period_handles_year_and_leap_year_boundaries():
    old = _with_start_day(16)
    try:
        assert financial_period.period_for_date(date(2027, 1, 14)) == (
            date(2026, 12, 16),
            date(2027, 1, 15),
        )
        assert financial_period.period_for_date(date(2024, 2, 29)) == (
            date(2024, 2, 16),
            date(2024, 3, 15),
        )
    finally:
        financial_period.MONTH_START_DAY = old

