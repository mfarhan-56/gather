# AETHER — Real-Time AI Meeting Copilot

AETHER listens to your online meeting (Google Meet, Zoom, Teams, or anything that plays audio), transcribes it live with **AssemblyAI**, and uses an **LLM (Groq)** to surface suggested replies, action items, decisions, deadlines, key points and concerns *while the meeting is happening*.

## How it works

```
Browser (mic + shared meeting audio)
   │  16 kHz PCM over WebSocket
   ▼
FastAPI backend ──► AssemblyAI Streaming v3 (one session per source: "You" / "Others")
   │                     │ live transcript turns
   │◄────────────────────┘
   ├─ FAST path: question/objection from others → instant suggested reply (~1-2 s)
   └─ SLOW path: every ~20 s, analyse only NEW turns + rolling summary + current state
                 → structured upserts (stable ids, no duplicates)
   │
   ▼  insights over WebSocket
Live dashboard
```

* **Two audio streams** → speaker attribution is exact: your mic is always "You", meeting audio is "Others" (with AssemblyAI diarization into Speaker A/B/...).
* **Rolling context**: a compact running summary + current extracted state + only the new turns are sent to the LLM — no reprocessing the whole transcript, low token cost.
* **API keys stay on the server**; the browser never sees them.

## Run locally (Windows)

1. Copy `.env.example` to `.env` and paste your `ASSEMBLYAI_API_KEY` and `GROQ_API_KEY`.
2. Double-click `run.bat` (or `python -m uvicorn backend.app:app --port 8000`).
3. Open http://localhost:8000 in **Chrome or Edge**.
4. Click **Start listening** → allow the microphone → in the share dialog choose your meeting **tab** (Google Meet) or **Entire screen** (Zoom/Teams desktop app) and enable **Share audio**.

Use headphones so your mic does not re-capture the other participants.

## Deploy (Render)

Push to GitHub → Render → *New → Blueprint* → pick the repo (uses `render.yaml`) → set `ASSEMBLYAI_API_KEY` and `GROQ_API_KEY` → deploy. HTTPS is provided automatically (required for mic/screen capture).

## Privacy

Listening only starts after the user confirms everyone has consented; a live indicator is shown while listening; Stop ends capture immediately. Nothing is stored server-side after the browser disconnects.
