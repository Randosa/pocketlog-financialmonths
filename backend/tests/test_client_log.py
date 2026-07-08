"""POST /api/client-log/reload-events — frontend reload breadcrumbs.

The endpoint's whole job is to put client-reported reload reasons into the
central log (→ LOG_FILE), so the tests pin: the log line appears with the
right fields, the reason vocabulary is a closed enum (no client free text can
reach a log line), and the route stays session-only with CSRF enforced.
"""

from __future__ import annotations

import logging

import pytest
from fastapi.testclient import TestClient

URL = "/api/client-log/reload-events"

EVENT = {"reason": "sw_update", "occurred_at": "2026-07-08T06:30:00Z"}


@pytest.fixture(autouse=True)
def _capture_pocketlog(caplog):
    """pocketlog.* loggers set propagate=False, so pytest's root-attached
    caplog handler would never see the records — attach it directly.

    Depending on test collection order, alembic's in-process ``fileConfig``
    (session DB setup) may have run AFTER the app modules were imported and
    disabled every logger it doesn't know about, including ``pocketlog.api``.
    Production never hits this — migrations run in a separate process there —
    so just re-enable it for the assertion.
    """
    caplog.set_level(logging.INFO, logger="pocketlog")
    plog = logging.getLogger("pocketlog")
    logging.getLogger("pocketlog.api").disabled = False
    plog.addHandler(caplog.handler)
    try:
        yield
    finally:
        plog.removeHandler(caplog.handler)


def test_events_land_in_log(client, regular_user, caplog):
    res = client.post(
        URL,
        json={
            "events": [
                EVENT,
                {"reason": "session_expired", "occurred_at": "2026-07-08T07:00:00Z"},
            ]
        },
    )
    assert res.status_code == 204
    messages = (r.getMessage() for r in caplog.records)
    lines = [m for m in messages if "client reload" in m]
    assert len(lines) == 2
    assert f"user_id={regular_user.id} reason=sw_update" in lines[0]
    assert "occurred_at=2026-07-08T06:30:00+00:00" in lines[0]
    assert f"user_id={regular_user.id} reason=session_expired" in lines[1]


def test_unknown_reason_rejected(client, caplog):
    """The reason vocabulary is closed — anything else is a 422, so no
    client-chosen string can ever reach a log line."""
    bad = {"reason": "evil\ninjected", "occurred_at": "2026-07-08T06:30:00Z"}
    res = client.post(URL, json={"events": [bad]})
    assert res.status_code == 422
    assert not any("client reload" in r.getMessage() for r in caplog.records)


def test_batch_bounds(client):
    res = client.post(URL, json={"events": []})
    assert res.status_code == 422
    res = client.post(URL, json={"events": [EVENT] * 21})
    assert res.status_code == 422
    res = client.post(URL, json={"events": [EVENT] * 20})
    assert res.status_code == 204


def test_requires_session(app):
    res = TestClient(app).post(URL, json={"events": [EVENT]})
    assert res.status_code == 401


def test_requires_csrf(client):
    res = client.post(URL, json={"events": [EVENT]}, headers={"X-CSRF-Token": ""})
    assert res.status_code == 403


def test_bearer_key_cannot_reach_it(client, app):
    """Session-only: even a full write-scope API key gets a 401 — the
    endpoint never consults the Authorization header."""
    created = client.post("/api/api-keys", json={"name": "clog", "scopes": ["write"]})
    assert created.status_code == 201, created.text
    raw_key = created.json()["key"]
    res = TestClient(app).post(
        URL,
        json={"events": [EVENT]},
        headers={"Authorization": f"Bearer {raw_key}"},
    )
    assert res.status_code == 401
