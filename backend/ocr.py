"""OCR for screen snapshots (additive): suggests participant names visible in a snapshot.
Runs server-side with Groq's vision model so the API key never reaches the browser.
Results are suggestions only; the user must accept them in the UI."""
import json
import os
import re

import httpx
from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

router = APIRouter()
VISION_MODEL = os.getenv("GROQ_VISION_MODEL", "qwen/qwen3.8-27b")
PROMPT = ("This is a screenshot of a video meeting or shared screen. List ONLY the people's names you can actually read "
          "(video tile labels, participant list, name badges, speaker captions). Do not guess or invent names. "
          'Reply with JSON only: {"names": ["..."], "details": "other clearly visible meeting info, max 15 words, or empty"}')


SPEAKER_PROMPT = ("This is a screenshot of a video meeting taken WHILE someone is talking. Identify the person who is "
                  "currently speaking: the tile with a highlighted/coloured border or speaking indicator, or the large "
                  "active-speaker view. Read the name label shown for that person. Only answer with a name you can "
                  "actually read on screen; if you cannot tell who is speaking or cannot read the name, use null. "
                  'Reply with JSON only: {"speaker": "name" or null, "confidence": number 0-1}')


@router.post("/api/ocr/speaker")
async def ocr_speaker(payload: dict = Body(...)):
    """Who is currently highlighted as speaking in this snapshot (name read from the screen)."""
    key = os.getenv("GROQ_API_KEY", "").strip()
    if not key:
        return JSONResponse({"error": "Server is missing GROQ_API_KEY"}, status_code=500)
    img = str(payload.get("image") or "")
    if not re.match(r"^data:image/(jpeg|png|webp);base64,", img) or len(img) > 3_000_000:
        return JSONResponse({"error": "Send a JPEG/PNG snapshot under 2 MB."}, status_code=400)
    body = {"model": VISION_MODEL, "max_tokens": 900, "temperature": 0.0,
            "messages": [{"role": "user", "content": [{"type": "text", "text": SPEAKER_PROMPT}, {"type": "image_url", "image_url": {"url": img}}]}]}
    try:
        async with httpx.AsyncClient(timeout=40) as http:
            r = await http.post("https://api.groq.com/openai/v1/chat/completions", json=body, headers={"Authorization": f"Bearer {key}"})
        if r.status_code != 200:
            return JSONResponse({"error": f"Vision model unavailable (HTTP {r.status_code})."}, status_code=502)
        text = re.sub(r"<think>.*?</think>", "", r.json()["choices"][0]["message"].get("content") or "", flags=re.S)
        m = re.search(r"\{.*\}", text, re.S)
        data = json.loads(m.group(0)) if m else {}
        name = data.get("speaker")
        name = str(name).strip()[:60] if name and str(name).strip().lower() not in ("null", "none", "unknown") else None
        conf = float(data.get("confidence") or 0)
        return {"speaker": name, "confidence": max(0.0, min(1.0, conf))}
    except (httpx.HTTPError, ValueError, KeyError, TypeError) as e:
        return JSONResponse({"error": f"Speaker detection failed: {str(e)[:150]}"}, status_code=502)


@router.post("/api/ocr/names")
async def ocr_names(payload: dict = Body(...)):
    key = os.getenv("GROQ_API_KEY", "").strip()
    if not key:
        return JSONResponse({"error": "Server is missing GROQ_API_KEY"}, status_code=500)
    img = str(payload.get("image") or "")
    if not re.match(r"^data:image/(jpeg|png|webp);base64,", img) or len(img) > 3_000_000:
        return JSONResponse({"error": "Send a JPEG/PNG snapshot under 2 MB."}, status_code=400)
    body = {"model": VISION_MODEL, "max_tokens": 900, "temperature": 0.1,
            "messages": [{"role": "user", "content": [{"type": "text", "text": PROMPT}, {"type": "image_url", "image_url": {"url": img}}]}]}
    try:
        async with httpx.AsyncClient(timeout=40) as http:
            r = await http.post("https://api.groq.com/openai/v1/chat/completions", json=body, headers={"Authorization": f"Bearer {key}"})
        if r.status_code != 200:
            return JSONResponse({"error": f"Vision model unavailable (HTTP {r.status_code})."}, status_code=502)
        text = r.json()["choices"][0]["message"].get("content") or ""
        text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
        m = re.search(r"\{.*\}", text, re.S)
        data = json.loads(m.group(0)) if m else {}
        names = [str(n).strip()[:60] for n in (data.get("names") or []) if str(n).strip()][:20]
        return {"names": names, "details": str(data.get("details") or "")[:160]}
    except (httpx.HTTPError, ValueError, KeyError) as e:
        return JSONResponse({"error": f"OCR failed: {str(e)[:150]}"}, status_code=502)
