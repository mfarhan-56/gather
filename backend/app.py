"""AETHER backend: FastAPI app.

Browser  <--WebSocket /ws-->  this server  <--WebSocket-->  AssemblyAI (one per audio source)
                                   |
                                   +--> Brain (Groq LLM) --> insights back to the browser

Browser -> server messages:
  binary : 1 byte source id (0 = mic, 1 = system audio) + PCM16 16 kHz mono audio
  text   : {"type": "start", "sources": ["mic", "system"]} | {"type": "stop"}
           {"type": "summary"} | {"type": "toggle_done", "id": "A1", "done": true}
"""
import asyncio
import json
import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Body, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .actions import router as actions_router
from .features import router as features_router
from .ocr import router as ocr_router
from .brain import Brain, followup_message, run_agent, summarize
from .llm import GroqClient, LLMError
from .stt import STTStream

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("aether")

AAI_KEY = os.getenv("ASSEMBLYAI_API_KEY", "").strip()
GROQ_KEY = os.getenv("GROQ_API_KEY", "").strip()
SPEECH_MODEL = os.getenv("ASSEMBLYAI_SPEECH_MODEL", "universal-3-6-pro").strip()
SPEAKER_LABELS = os.getenv("ASSEMBLYAI_SPEAKER_LABELS", "true").lower() == "true"
MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b").strip()
FAST_MODEL = os.getenv("GROQ_FAST_MODEL", MODEL).strip()
INTERVAL = float(os.getenv("ANALYSIS_INTERVAL_SECONDS", "12"))

SOURCES = {0: "mic", 1: "system"}

app = FastAPI(title="AETHER")
app.include_router(actions_router)
app.include_router(features_router)
app.include_router(ocr_router)
FRONTEND = ROOT / "frontend"


@app.middleware("http")
async def no_stale_frontend(request, call_next):
    """Make browsers revalidate the page and its scripts on every load, so updates are
    never hidden behind a cached old version."""
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


@app.get("/")
async def index():
    return FileResponse(FRONTEND / "index.html")


@app.get("/api/health")
async def health():
    return JSONResponse({"ok": True, "assemblyai_key": bool(AAI_KEY), "groq_key": bool(GROQ_KEY)})


@app.post("/api/summary")
async def summary_api(payload: dict = Body(...)):
    """Summarize a saved meeting (history lives in the browser, so it sends turns + state)."""
    if not GROQ_KEY:
        return JSONResponse({"error": "Server is missing GROQ_API_KEY"}, status_code=500)
    turns = payload.get("turns") or []
    if not isinstance(turns, list) or not turns:
        return JSONResponse({"error": "No transcript to summarize"}, status_code=400)
    llm = GroqClient(GROQ_KEY)
    try:
        md = await summarize(llm, MODEL, turns[-2000:], payload.get("state") or {}, payload.get("summary") or "")
        return JSONResponse({"markdown": md})
    except LLMError as e:
        return JSONResponse({"error": str(e)[:200]}, status_code=502)
    finally:
        await llm.http.aclose()


@app.post("/api/agent")
async def agent_api(payload: dict = Body(...)):
    """AETHER Agent: reason about one task with cross-meeting context and produce deliverables."""
    if not GROQ_KEY:
        return JSONResponse({"error": "Server is missing GROQ_API_KEY"}, status_code=500)
    task = payload.get("task") or {}
    if not task.get("task"):
        return JSONResponse({"error": "No task given"}, status_code=400)
    llm = GroqClient(GROQ_KEY)
    try:
        out = await run_agent(llm, MODEL, task, payload.get("context") or [],
                              str(payload.get("user_name") or "")[:60], str(payload.get("today") or "")[:60])
        return JSONResponse(out)
    except LLMError as e:
        return JSONResponse({"error": str(e)[:200]}, status_code=502)
    finally:
        await llm.http.aclose()


@app.post("/api/followup")
async def followup_api(payload: dict = Body(...)):
    """Draft a follow-up message for a saved meeting."""
    if not GROQ_KEY:
        return JSONResponse({"error": "Server is missing GROQ_API_KEY"}, status_code=500)
    llm = GroqClient(GROQ_KEY)
    try:
        text = await followup_message(llm, MODEL, str(payload.get("title") or "")[:120], (payload.get("turns") or [])[-200:],
                                      payload.get("state") or {}, str(payload.get("summary") or "")[:6000],
                                      str(payload.get("user_name") or "")[:60])
        return JSONResponse({"text": text})
    except LLMError as e:
        return JSONResponse({"error": str(e)[:200]}, status_code=502)
    finally:
        await llm.http.aclose()


app.mount("/static", StaticFiles(directory=FRONTEND), name="static")


class MeetingSession:
    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.send_lock = asyncio.Lock()
        self.llm = GroqClient(GROQ_KEY)
        self.brain = Brain(self.llm, self.emit, MODEL, FAST_MODEL, INTERVAL)
        self.streams: dict[str, STTStream] = {}
        self.closed = False

    async def emit(self, msg: dict):
        if self.closed:
            return
        try:
            async with self.send_lock:
                await self.ws.send_text(json.dumps(msg, ensure_ascii=False))
        except Exception:
            self.closed = True

    # --- STT callbacks ---
    async def on_partial(self, source, key, speaker, text):
        await self.emit({"type": "transcript", "key": key, "source": source, "speaker": speaker, "text": text, "final": False})

    async def on_final(self, source, key, speaker, text):
        await self.emit({"type": "transcript", "key": key, "source": source, "speaker": speaker, "text": text, "final": True})
        await self.brain.add_turn(speaker, source, text)

    async def on_status(self, source, state, detail):
        await self.emit({"type": "stt_status", "source": source, "state": state, "detail": detail})

    # --- commands ---
    async def start(self, sources, user_name="", today=""):
        if not AAI_KEY or not GROQ_KEY:
            missing = [n for n, v in (("ASSEMBLYAI_API_KEY", AAI_KEY), ("GROQ_API_KEY", GROQ_KEY)) if not v]
            await self.emit({"type": "notice", "level": "error", "message": f"Server is missing: {', '.join(missing)}"})
            return
        await self.stop_streams()
        if self.brain.running or self.brain.turns:
            await self.brain.stop()
            self.brain = Brain(self.llm, self.emit, MODEL, FAST_MODEL, INTERVAL)  # new meeting, clean context
        self.brain.user_name = str(user_name or "").strip()[:60]
        if today:
            self.brain.today = str(today)[:40]
        for src in sources:
            if src not in ("mic", "system"):
                continue
            stream = STTStream(
                src, AAI_KEY, SPEECH_MODEL,
                speaker_labels=(SPEAKER_LABELS and src == "system"),
                on_partial=self.on_partial, on_final=self.on_final, on_status=self.on_status,
            )
            try:
                await stream.start()
                self.streams[src] = stream
            except Exception as e:
                log.exception("could not connect to AssemblyAI")
                await self.emit({"type": "notice", "level": "error",
                                 "message": f"Could not connect to AssemblyAI for {src}: {e}"})
        if self.streams:
            self.brain.start()
            await self.emit({"type": "listening", "on": True, "sources": list(self.streams)})

    async def stop_streams(self):
        streams, self.streams = list(self.streams.values()), {}
        await asyncio.gather(*(s.stop() for s in streams), return_exceptions=True)

    async def stop(self, summary=False):
        await self.stop_streams()
        await self.emit({"type": "listening", "on": False})
        await self.brain.stop()  # final analysis of the last turns
        if summary and self.brain.turns:
            await self.summary()

    async def summary(self):
        await self.emit({"type": "summary_status", "state": "working"})
        try:
            md = await self.brain.final_summary()
            await self.emit({"type": "summary", "markdown": md})
        except LLMError as e:
            await self.emit({"type": "summary_status", "state": "error", "message": str(e)[:200]})

    async def audio(self, data: bytes):
        if len(data) < 3:
            return
        src = SOURCES.get(data[0])
        stream = self.streams.get(src)
        if stream:
            await stream.send_audio(data[1:])

    async def close(self):
        self.closed = True
        await self.stop_streams()
        self.brain.running = False
        if self.brain.loop_task:
            self.brain.loop_task.cancel()
        await self.llm.http.aclose()


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    session = MeetingSession(ws)
    await session.emit({"type": "hello", "assemblyai_key": bool(AAI_KEY), "groq_key": bool(GROQ_KEY)})
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                await session.audio(msg["bytes"])
                continue
            text = msg.get("text")
            if not text:
                continue
            try:
                cmd = json.loads(text)
            except json.JSONDecodeError:
                continue
            kind = cmd.get("type")
            if kind == "start":
                asyncio.create_task(session.start(cmd.get("sources") or ["mic", "system"],
                                                  cmd.get("user_name", ""), cmd.get("today", "")))
            elif kind == "stop":
                asyncio.create_task(session.stop(summary=bool(cmd.get("summary"))))
            elif kind == "summary":
                asyncio.create_task(session.summary())
            elif kind == "toggle_done":
                if session.brain.set_done(cmd.get("id"), cmd.get("done")):
                    await session.emit({"type": "insights", "state": session.brain.state, "changed": [],
                                        "summary": session.brain.summary})
            elif kind == "ping":
                await session.emit({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("websocket error")
    finally:
        await session.close()
