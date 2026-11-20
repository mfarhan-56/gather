"""Real app actions through Composio: Gmail, Google Calendar, Slack, Notion, GitHub, Google Docs.

The AETHER agent prepares drafts; these endpoints execute an action only when the user
explicitly clicks a button (human-in-the-loop). Each AETHER user maps to a Composio
user_id, and connections use Composio-managed OAuth (no developer-console setup).
"""
import asyncio
import logging
import os
import re

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

log = logging.getLogger("aether.actions")
router = APIRouter(prefix="/api/composio")

TOOLKITS = ["gmail", "googlecalendar", "slack", "notion", "github", "googledocs"]
LABEL = {"gmail": "Gmail", "googlecalendar": "Google Calendar", "slack": "Slack",
         "notion": "Notion", "github": "GitHub", "googledocs": "Google Docs"}
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_client = None
_auth_configs = {}


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


def _run(c, uid, accounts, toolkit, slug, args):
    res = c.tools.execute(slug, args, user_id=uid, connected_account_id=accounts[toolkit],
                          dangerously_skip_version_check=True)
    data = res if isinstance(res, dict) else getattr(res, "__dict__", {"data": str(res)})
    ok = bool(data.get("successful", data.get("success", True))) and not data.get("error")
    if not ok:
        raise RuntimeError(f"{slug} failed: {str(data.get('error'))[:300]}")
    return data.get("data", data)


def _find_dicts(obj, must_have):
    """Recursively collect dicts that contain all keys in must_have (robust to response nesting)."""
    found = []
    if isinstance(obj, dict):
        if all(k in obj for k in must_have):
            found.append(obj)
        for v in obj.values():
            found.extend(_find_dicts(v, must_have))
    elif isinstance(obj, list):
        for v in obj:
            found.extend(_find_dicts(v, must_have))
    return found


def _find_value(obj, keys):
    if isinstance(obj, dict):
        for k in keys:
            if isinstance(obj.get(k), str) and obj[k]:
                return obj[k]
        for v in obj.values():
            r = _find_value(v, keys)
            if r:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = _find_value(v, keys)
            if r:
                return r
    return None


def _notion_title(page):
    for prop in (page.get("properties") or {}).values():
        if isinstance(prop, dict) and prop.get("type") == "title":
            parts = prop.get("title") or []
            text = "".join(p.get("plain_text", "") for p in parts if isinstance(p, dict))
            if text:
                return text
    return page.get("title") if isinstance(page.get("title"), str) else "Untitled page"


def _emails(value):
    items = value if isinstance(value, list) else re.split(r"[,;\s]+", str(value or ""))
    return [x.strip() for x in items if x and EMAIL_RE.match(x.strip())]


# ---------------------------------------------------------------- endpoints
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
    toolkit = str(payload.get("toolkit") or "")
    if not uid or toolkit not in TOOLKITS:
        return _err("missing user or unknown app")
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


@router.post("/lookup")
async def lookup(payload: dict = Body(...)):
    """Options for pickers: Slack channels, Notion parent pages, GitHub repositories."""
    c = _composio()
    if not c:
        return _err("Server is missing COMPOSIO_API_KEY", 500)
    uid = _uid(payload.get("user"))
    what = str(payload.get("what") or "")
    spec = {
        "slack_channels": ("slack", "SLACK_LIST_ALL_CHANNELS", {"limit": 200, "exclude_archived": True,
                                                              "types": "public_channel,private_channel"}),
        "notion_pages": ("notion", "NOTION_SEARCH_NOTION_PAGE", {"query": str(payload.get("q") or ""),
                                                                "filter_value": "page", "filter_property": "object",
                                                                "page_size": 30}),
        "github_repos": ("github", "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER", {"per_page": 50, "sort": "updated"}),
    }.get(what)
    if not uid or not spec:
        return _err("bad lookup")
    toolkit, slug, args = spec
    try:
        accounts = await asyncio.to_thread(_active_accounts, c, uid)
        if toolkit not in accounts:
            return _err(f"Connect {LABEL[toolkit]} first (Settings → Connected apps).", 409)
        data = await asyncio.to_thread(_run, c, uid, accounts, toolkit, slug, args)
        if what == "slack_channels":
            opts = [{"value": d["id"], "label": "#" + d["name"]} for d in _find_dicts(data, ["id", "name"])
                    if str(d.get("id", "")).startswith(("C", "G"))]
        elif what == "notion_pages":
            opts = [{"value": d["id"], "label": _notion_title(d)} for d in _find_dicts(data, ["id", "object"])
                    if d.get("object") == "page"]
        else:
            opts = [{"value": d["full_name"], "label": d["full_name"]} for d in _find_dicts(data, ["full_name", "name"])
                    if "/" in str(d.get("full_name", ""))]
        seen, uniq = set(), []
        for o in opts:
            if o["value"] not in seen:
                seen.add(o["value"])
                uniq.append(o)
        return {"ok": True, "options": uniq[:100]}
    except Exception as e:
        log.exception("composio lookup failed")
        return _err(f"Composio error: {str(e)[:250]}", 502)


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
    link = None

    if action in ("gmail_send", "gmail_draft"):
        to = _emails(a.get("to"))
        if action == "gmail_send" and not to:
            return _err("Enter a valid recipient email address.")
        args = {"subject": str(a.get("subject") or "")[:300], "body": str(a.get("body") or "")[:20000], "is_html": False}
        if to:
            args["recipient_email"] = to[0]
        if len(to) > 1:
            args["extra_recipients"] = to[1:]
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
        slug, toolkit = "GOOGLECALENDAR_CREATE_EVENT", "googlecalendar"
    elif action == "slack_message":
        channel = str(a.get("channel") or "").strip()
        text = str(a.get("text") or "").strip()
        if not channel or not text:
            return _err("Pick a Slack channel and write a message.")
        args = {"channel": channel, "markdown_text": text[:12000]}
        slug, toolkit = "SLACK_SEND_MESSAGE", "slack"
    elif action == "notion_page":
        parent = str(a.get("parent_id") or "").strip()
        if not parent:
            return _err("Pick a Notion page to create it under.")
        args = {"parent_id": parent, "title": str(a.get("title") or "AETHER note")[:200],
                "markdown": str(a.get("content") or "")[:50000]}
        slug, toolkit = "NOTION_CREATE_NOTION_PAGE", "notion"
    elif action == "github_issue":
        full = str(a.get("repo") or "").strip()
        if "/" not in full or not str(a.get("title") or "").strip():
            return _err("Pick a repository and enter an issue title.")
        owner, repo = full.split("/", 1)
        args = {"owner": owner, "repo": repo, "title": str(a.get("title"))[:250], "body": str(a.get("body") or "")[:60000]}
        slug, toolkit = "GITHUB_CREATE_AN_ISSUE", "github"
    elif action == "google_doc":
        args = {"title": str(a.get("title") or "AETHER document")[:200], "markdown_text": str(a.get("content") or "")[:100000]}
        slug, toolkit = "GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN", "googledocs"
    else:
        return _err("unknown action")

    try:
        accounts = await asyncio.to_thread(_active_accounts, c, uid)
        if toolkit not in accounts:
            return _err(f"Connect {LABEL[toolkit]} first (Settings → Connected apps).", 409)
        data = await asyncio.to_thread(_run, c, uid, accounts, toolkit, slug, args)
        if action == "google_doc":
            doc_id = _find_value(data, ["documentId", "document_id", "id"])
            link = f"https://docs.google.com/document/d/{doc_id}/edit" if doc_id else None
        elif action == "notion_page":
            link = _find_value(data, ["url", "public_url"])
        elif action == "github_issue":
            link = _find_value(data, ["html_url"])
        elif action == "calendar_event":
            link = _find_value(data, ["htmlLink", "html_link"])
        return {"ok": True, "action": action, "slug": slug, "link": link}
    except Exception as e:
        log.exception("composio execute failed")
        return _err(str(e)[:300] if "failed:" in str(e) else f"Composio error: {str(e)[:250]}", 502)
