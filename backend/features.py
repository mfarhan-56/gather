"""Additional PS-05 endpoints (additive; existing endpoints are untouched).

- POST /api/transcript/analyze : analyse an uploaded / pasted transcript (or turns) end-to-end
- POST /api/audio/start        : upload an audio recording to AssemblyAI (async, speaker labels)
- GET  /api/audio/status/{id}  : poll the transcription; returns speaker turns when done
- POST /api/crosscheck         : find updates to tasks from EARLIER meetings in a new meeting
"""
import json
import logging
import os
import re
import time

import httpx
from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse

from .brain import Brain, summarize
from .llm import GroqClient, LLMError

log = logging.getLogger("aether.features")
router = APIRouter()

AAI = "https://api.assemblyai.com/v2"
MAX_AUDIO_BYTES = 150 * 1024 * 1024


def _keys():
    return os.getenv("ASSEMBLYAI_API_KEY", "").strip(), os.getenv("GROQ_API_KEY", "").strip()


def _models():
    model = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b").strip()
    return model, os.getenv("GROQ_FAST_MODEL", model).strip()


def _err(msg, code=400):
    return JSONResponse({"error": msg}, status_code=code)


# ---------------------------------------------------------------- transcript parsing
TS = re.compile(r"^\s*\[?\(?\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\)?\]?\s*[-–]?\s*")
ARROW = re.compile(r"\d{1,2}:\d{2}(?::\d{2})?[.,]\d+\s*-->\s*\d")
VOICE = re.compile(r"^<v\s+([^>]+)>(.*?)(?:</v>)?$", re.I)
SPEAKER = re.compile(r"^([A-Z][\w .'\-()]{0,40}?)\s*:\s+(.+)$")


def parse_transcript(text, user_name=""):
    """Plain 'Name: text', WebVTT (<v Name>), SRT and timestamped lines -> merged speaker turns."""
    turns, current = [], None
    me = {"you", "me", "myself"} | ({user_name.strip().lower()} if user_name else set())
    for raw in (text or "").replace("\r", "").split("\n"):
        line = raw.strip()
        if not line or line.upper().startswith(("WEBVTT", "NOTE", "STYLE", "REGION")) or line.isdigit() or ARROW.search(line):
            continue
        line = TS.sub("", line)
        speaker, said = None, line
        m = VOICE.match(line)
        if m:
            speaker, said = m.group(1).strip(), re.sub(r"</?[^>]+>", "", m.group(2)).strip()
        else:
            m = SPEAKER.match(line)
            if m and len(m.group(1).split()) <= 4:
                speaker, said = m.group(1).strip(), m.group(2).strip()
        said = re.sub(r"</?[^>]+>", "", said).strip()
        if not said:
            continue
        speaker = speaker or current or "Speaker"
        if turns and turns[-1]["speaker"] == speaker:
            turns[-1]["text"] += " " + said
        else:
            turns.append({"speaker": speaker, "text": said})
        current = speaker
    for t in turns:
        t["source"] = "mic" if t["speaker"].strip().lower() in me else "system"
        if t["source"] == "mic":
            t["speaker"] = "You"
    return turns[:1500]


# ---------------------------------------------------------------- transcript analysis
@router.post("/api/transcript/analyze")
async def analyze_transcript(payload: dict = Body(...)):
    _, groq = _keys()
    if not groq:
        return _err("Server is missing GROQ_API_KEY", 500)
    user_name = str(payload.get("user_name") or "")[:60]
    turns = payload.get("turns")
    if not isinstance(turns, list) or not turns:
        turns = parse_transcript(str(payload.get("text") or "")[:400000], user_name)
    turns = [{"speaker": str(t.get("speaker") or "Speaker")[:60], "text": str(t.get("text") or "")[:4000],
              "source": "mic" if t.get("source") == "mic" else "system"} for t in turns if t.get("text")]
    if not turns:
        return _err("Couldn't find any conversation in that transcript.")

    model, fast = _models()
    llm = GroqClient(groq)

    async def _noop(_msg):
        return None

    try:
        brain = Brain(llm, _noop, model, fast, 9999, user_name=user_name, today=str(payload.get("today") or "")[:60])
        CHUNK = 45
        for i in range(0, len(turns), CHUNK):
            for t in turns[i:i + CHUNK]:
                brain.turns.append({"i": len(brain.turns), "speaker": t["speaker"], "source": t["source"], "text": t["text"], "t": time.time()})
            await brain.analyze()
        if brain.analyzed_upto < len(brain.turns):  # retry once if a chunk hit a temporary limit
            await brain.analyze()
        md = await summarize(llm, model, brain.turns, brain.state, brain.summary)
        title = None
        m = re.search(r"^#\s+(.+)$", md or "", re.M)
        if m:
            title = m.group(1).replace("*", "").strip()
        return {"turns": turns, "state": brain.state, "summary": md, "live_summary": brain.summary, "title": title,
                "complete": brain.analyzed_upto >= len(brain.turns)}
    except LLMError as e:
        return _err(f"AI temporarily unavailable: {str(e)[:200]}", 502)
    except Exception as e:
        log.exception("transcript analysis failed")
        return _err(f"Analysis failed: {str(e)[:200]}", 500)
    finally:
        await llm.http.aclose()


# ---------------------------------------------------------------- audio (AssemblyAI async)
@router.post("/api/audio/start")
async def audio_start(request: Request):
    aai, _ = _keys()
    if not aai:
        return _err("Server is missing ASSEMBLYAI_API_KEY", 500)
    data = await request.body()
    if not data:
        return _err("No audio received.")
    if len(data) > MAX_AUDIO_BYTES:
        return _err("Audio file is too large (max 150 MB).")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=15)) as http:
            up = await http.post(f"{AAI}/upload", headers={"authorization": aai}, content=data)
            if up.status_code != 200:
                return _err(f"Upload to AssemblyAI failed (HTTP {up.status_code}).", 502)
            job = await http.post(f"{AAI}/transcript", headers={"authorization": aai},
                                  json={"audio_url": up.json()["upload_url"], "speaker_labels": True})
            if job.status_code != 200:
                return _err(f"AssemblyAI rejected the job (HTTP {job.status_code}): {job.text[:160]}", 502)
            return {"id": job.json()["id"]}
    except httpx.HTTPError as e:
        return _err(f"Network error talking to AssemblyAI: {e}", 502)


@router.get("/api/audio/status/{job_id}")
async def audio_status(job_id: str):
    aai, _ = _keys()
    if not aai or not re.match(r"^[\w-]{6,80}$", job_id):
        return _err("bad request")
    try:
        async with httpx.AsyncClient(timeout=30) as http:
            r = await http.get(f"{AAI}/transcript/{job_id}", headers={"authorization": aai})
        d = r.json()
    except Exception as e:
        return _err(f"Network error: {e}", 502)
    status = d.get("status")
    if status == "error":
        return {"status": "error", "error": d.get("error") or "Transcription failed"}
    if status != "completed":
        return {"status": status or "processing"}
    turns = [{"speaker": f"Speaker {u.get('speaker', '?')}", "text": u.get("text", ""), "source": "system"}
             for u in (d.get("utterances") or []) if u.get("text")]
    if not turns and d.get("text"):
        turns = [{"speaker": "Speaker", "text": d["text"], "source": "system"}]
    return {"status": "completed", "turns": turns, "duration": d.get("audio_duration")}


# ---------------------------------------------------------------- cross-meeting tracking
CROSS_SYSTEM = """You are Gather's commitment tracker. You receive OPEN TASKS from earlier meetings and the
TRANSCRIPT of a newer meeting. Find ONLY tasks whose status the new meeting clearly changes:
- "done": someone says it is finished/sent/shipped.
- "in_progress": someone reports active progress.
- "delayed": the date moved or it slipped (give new_due_date "YYYY-MM-DD" from CALENDAR if a new date is stated).
- "blocked": it is waiting on something; say what in note.
- "cancelled": the group dropped it.
Rules: match by meaning, not exact words. Never guess. If unsure, leave it out. Copy a short verbatim quote as evidence.
Return JSON: {"updates": [{"ref": str, "status": "done"|"in_progress"|"delayed"|"blocked"|"cancelled",
"new_due_date": str|null, "note": str (max 15 words), "evidence": {"quote": str, "speaker": str}, "confidence": number 0-1}]}"""


@router.post("/api/crosscheck")
async def crosscheck(payload: dict = Body(...)):
    _, groq = _keys()
    if not groq:
        return _err("Server is missing GROQ_API_KEY", 500)
    items = [i for i in (payload.get("open_items") or []) if isinstance(i, dict) and i.get("ref") and i.get("task")][:40]
    turns = payload.get("turns") or []
    if not items or not turns:
        return {"updates": []}
    transcript = "\n".join(f"{t.get('speaker', '?')}: {t.get('text', '')}" for t in turns)[-14000:]
    from .brain import Brain as _B  # reuse the calendar helper for date resolution
    cal = _B.__new__(_B)
    cal.today = str(payload.get("today") or time.strftime("%A, %Y-%m-%d"))[:60]
    user = (f"TODAY: {cal.today}\nCALENDAR: {_B._calendar(cal)}\nUSER NAME: {str(payload.get('user_name') or '')[:60]} (appears as \"You\")\n\n"
            f"OPEN TASKS:\n{json.dumps(items, ensure_ascii=False)}\n\nNEW MEETING TRANSCRIPT:\n{transcript}")
    llm = GroqClient(groq)
    try:
        out = await llm.chat([{"role": "system", "content": CROSS_SYSTEM}, {"role": "user", "content": user}],
                             model=_models()[0], max_tokens=1200, temperature=0.1)
        refs = {i["ref"] for i in items}
        ups = [u for u in (out.get("updates") or []) if isinstance(u, dict) and u.get("ref") in refs
               and u.get("status") in ("done", "in_progress", "delayed", "blocked", "cancelled")
               and float(u.get("confidence") or 0) >= 0.55]
        return {"updates": ups}
    except LLMError as e:
        return _err(f"AI temporarily unavailable: {str(e)[:200]}", 502)
    finally:
        await llm.http.aclose()
