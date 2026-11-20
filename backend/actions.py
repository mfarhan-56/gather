"""Real app actions through Composio (Gmail + Google Calendar).

The AETHER agent prepares drafts; these endpoints execute an action only when the user
explicitly clicks a button (human-in-the-loop). Each AETHER user maps to a Composio
user_id, and connections use Composio-managed Google OAuth.
"""
import asyncio
import logging
import os
import re

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

log = logging.getLogger("aether.actions")
router = APIRouter(prefix="/api/composio")

TOOLKITS = {"gmail": "gmail", "googlecalendar": "googlecalendar"}
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_client = None


def _composio():
    global _client
    key = os.getenv("COMPOSIO_API_KEY", "").strip()
    if not key:
        return None
    if _client is None:
        from composio import Composio
        _client = Composio(api_key=key)
    return _client


def _uid(raw):
    raw = re.sub(r"[^A-Za-z0-9_-]", "", str(raw or ""))[:60]
    return f"aether-{raw}" if raw else None


def _err(msg, code=400):
    return JSONResponse({"ok": False, "error": msg}, status_code=code)


def _active_accounts(c, user_id):
    """Return {toolkit_slug: connected_account_id} for ACTIVE connections of this user."""
    out = {}
    try:
        res = c.connected_accounts.list(user_ids=[user_id], statuses=["ACTIVE"])
    except TypeError:
        res = c.connected_accounts.list(statuses=["ACTIVE"])
    for acc in getattr(res, "items", None) or []:
        if getattr(acc, "user_id", user_id) not in (user_id, None):
            continue
        tk = getattr(getattr(acc, "toolkit", None), "slug", None)
        if tk and tk not in out:
            out[tk] = getattr(acc, "id", None)
    return out


_auth_configs = {}


def _auth_config_id(c, toolkit):
    """Find (or create once) the Composio-managed OAuth auth config for a toolkit."""
    if toolkit in _auth_configs:
        return _auth_configs[toolkit]
    res = c.auth_configs.list()
    for item in getattr(res, "items", None) or []:
        if getattr(getattr(item, "toolkit", None), "slug", None) == toolkit:
            _auth_configs[toolkit] = item.id
            return item.id
    ac = c.auth_configs.create(toolkit, {"type": "use_composio_managed_auth"})
    acid = getattr(ac, "id", None) or getattr(getattr(ac, "auth_config", None), "id", None)
    _auth_configs[toolkit] = acid
    return acid


@router.get("/status")
async def status(user: str = ""):
    c = _composio()
    if not c:
        return {"enabled": False, "connected": {}}
    uid = _uid(user)
    if not uid:
        return _err("missing user")
    try:
        accounts = await asyncio.to_thread(_active_accounts, c, uid)
        return {"enabled": True, "connected": {k: k in accounts for k in TOOLKITS}}
    except Exception as e:
        log.exception("composio status failed")
        return _err(f"Composio error: {str(e)[:200]}", 502)


@router.post("/connect")
async def connect(payload: dict = Body(...)):
    c = _composio()
    if not c:
        return _err("Server is missing COMPOSIO_API_KEY", 500)
    uid = _uid(payload.get("user"))
    toolkit = TOOLKITS.get(str(payload.get("toolkit") or ""))
    if not uid or not toolkit:
        return _err("missing user or unknown toolkit")
    try:
        auth_config_id = await asyncio.to_thread(_auth_config_id, c, toolkit)
        req = await asyncio.to_thread(c.connected_accounts.link, uid, auth_config_id)
        url = getattr(req, "redirect_url", None) or getattr(req, "redirectUrl", None)
        if not url:
            return _err("Composio did not return a connection link", 502)
        return {"ok": True, "redirect_url": url}
    except Exception as e:
        log.exception("composio connect failed")
        return _err(f"Composio error: {str(e)[:200]}", 502)


def _emails(value):
    items = value if isinstance(value, list) else re.split(r"[,;\s]+", str(value or ""))
    return [x.strip() for x in items if x and EMAIL_RE.match(x.strip())]


@router.post("/execute")
async def execute(payload: dict = Body(...)):
    """Run ONE explicit, user-approved action."""
    c = _composio()
    if not c:
        return _err("Server is missing COMPOSIO_API_KEY", 500)
    uid = _uid(payload.get("user"))
    action = str(payload.get("action") or "")
    a = payload.get("args") or {}
    if not uid:
        return _err("missing user")

    if action in ("gmail_send", "gmail_draft"):
        to = _emails(a.get("to"))
        if action == "gmail_send" and not to:
            return _err("Enter a valid recipient email address.")
        args = {"recipient_email": to[0] if to else "", "subject": str(a.get("subject") or "")[:300],
                "body": str(a.get("body") or "")[:20000], "is_html": False}
        if len(to) > 1:
            args["extra_recipients"] = to[1:]
        if not args["recipient_email"]:
            args.pop("recipient_email")
        slug = "GMAIL_SEND_EMAIL" if action == "gmail_send" else "GMAIL_CREATE_EMAIL_DRAFT"
        toolkit = "gmail"
    elif action == "calendar_event":
        start = str(a.get("start") or "")
        if not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", start):
            return _err("Pick a start date and time.")
        args = {"summary": str(a.get("title") or "Meeting")[:200], "start_datetime": start[:16] + ":00",
                "event_duration_hour": int(a.get("hours") or 0), "event_duration_minutes": int(a.get("minutes") or 30),
                "timezone": str(a.get("timezone") or "UTC")[:60], "calendar_id": "primary",
                "description": str(a.get("description") or "")[:5000],
                "send_updates": "all" if a.get("notify") else "none", "create_meeting_room": bool(a.get("meet", True))}
        attendees = _emails(a.get("attendees"))
        if attendees:
            args["attendees"] = attendees
        slug = "GOOGLECALENDAR_CREATE_EVENT"
        toolkit = "googlecalendar"
    else:
        return _err("unknown action")

    try:
        accounts = await asyncio.to_thread(_active_accounts, c, uid)
        if toolkit not in accounts:
            return _err(f"Connect {'Gmail' if toolkit == 'gmail' else 'Google Calendar'} first (Settings → Connected apps).", 409)
        res = await asyncio.to_thread(
            c.tools.execute, slug, args, user_id=uid, connected_account_id=accounts[toolkit],
            dangerously_skip_version_check=True,
        )
        data = res if isinstance(res, dict) else getattr(res, "__dict__", {"result": str(res)})
        ok = bool(data.get("successful", data.get("success", True))) and not data.get("error")
        if not ok:
            return _err(f"{slug} failed: {str(data.get('error'))[:300]}", 502)
        return {"ok": True, "action": action, "slug": slug}
    except Exception as e:
        log.exception("composio execute failed")
        return _err(f"Composio error: {str(e)[:250]}", 502)
