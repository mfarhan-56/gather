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

## Meeting recording (optional, user-started)

Tick **Record live (screen + audio)** in the Start dialog (and the consent box). Gather then records the **tab, window or screen you pick in the browser's share dialog** — nothing else, never in the background.

While recording, a **REC** bar shows a live preview, the elapsed time, what is captured and a **Stop recording** button. Recording also stops automatically when you stop screen sharing or end the meeting.

**What gets saved**
* The video (WebM, or MP4 where the browser supports it) plus a snapshot of the shared screen every 30 s.
* Stored **only in this browser** (IndexedDB). Meeting data stays in localStorage as before. Use **Download** on the meeting page to keep a permanent copy.
* Every transcript line and every extracted task/decision/commitment shows its time (`mm:ss`, seconds on hover). Click it to jump to that moment in the recording. Timestamps also appear in the To-do list and the Tasks panel.
* **Screen details**: under each snapshot you can type names or details you see. These are labelled **User-confirmed** — Gather does not read names from images automatically.
* Speaker labels are editable: click a speaker's name in the transcript to rename it throughout that meeting.

**Browser and audio limitations (be precise when demoing)**
* Needs a recent **Chrome or Edge** on desktop (MediaRecorder + screen sharing + IndexedDB). On unsupported browsers the option is disabled with an explanation.
* **Shared audio is only recorded when the browser provides it**: Chrome/Edge on Windows give audio for a shared **tab** or **entire screen** when "Share audio" is ticked; a shared **single window** has no audio; macOS does not provide system audio. Gather tells you exactly which audio it is recording ("your microphone", "shared audio", or both). Your microphone is included if you allowed it.
* Size is roughly 10–20 MB per 5 minutes. If browser storage is full, the recording is **downloaded to your computer instead** and the transcript, tasks and snapshots metadata are still saved — the meeting is never lost.
* Recordings do not sync between devices or browsers, and are removed if you clear this site's browser data.
* "You vs Others" labels come from the two separate audio streams (your mic vs. the shared audio) during live transcription; within the shared audio, speakers are separated by AssemblyAI diarization (Speaker A/B…), which you can rename.
