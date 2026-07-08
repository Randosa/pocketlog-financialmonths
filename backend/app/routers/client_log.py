"""Client-side boot/reload diagnostics.

The frontend reloads itself automatically in two situations (service-worker
update takeover, expired session on a 401) — both look like an unexplained
"blink" to the user. A third breadcrumb, ``boot_failed``, marks a boot whose
post-login data loads died (backend restarting, dead network). The browser
cannot write to the server log directly and the page's memory dies with a
reload, so the frontend parks a breadcrumb in localStorage and delivers it
here on its next authenticated boot (core.js ``reportReloadEvents``). This
endpoint's only job is to put those events into the central log, where
``LOG_FILE`` makes them persistent.

Session-only (``CurrentUser``): bearer API keys have no reason to write log
lines, and keeping them out bounds the spam surface to logged-in browsers.
``reason`` is a closed enum in the schema — no client free text reaches the
log line.
"""

import logging

from fastapi import APIRouter, Response

from .. import schemas
from ..deps import CurrentUser

logger = logging.getLogger("pocketlog.api")

router = APIRouter()


@router.post("/api/client-log/reload-events", status_code=204)
def report_reload_events(payload: schemas.ReloadEventsIn, user: CurrentUser):
    for event in payload.events:
        logger.info(
            "client event user_id=%d reason=%s occurred_at=%s",
            user.id,
            event.reason,
            event.occurred_at.isoformat(),
        )
    return Response(status_code=204)
