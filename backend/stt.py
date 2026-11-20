"""AssemblyAI Universal Streaming (v3) client.

One STTStream per audio source ("mic" = the user, "system" = other participants).
Audio arrives from the browser as 16 kHz mono PCM16 and is forwarded as binary
frames. Turn messages are converted into simple transcript events.
"""
import asyncio
import json
import logging
from urllib.parse import urlencode

import websockets

log = logging.getLogger("aether.stt")

AAI_URL = "wss://streaming.assemblyai.com/v3/ws"
FORMAT_GRACE_SECONDS = 0.5  # wait this long for the formatted version of a finished turn


class STTStream:
    def __init__(self, source, api_key, speech_model, speaker_labels, on_partial, on_final, on_status):
        self.source = source
        self.api_key = api_key
        self.speech_model = speech_model
        self.speaker_labels = speaker_labels
        self.on_partial = on_partial  # async (source, turn_key, speaker, text)
        self.on_final = on_final      # async (source, turn_key, speaker, text)
        self.on_status = on_status    # async (source, state, detail)
        self.ws = None
        self.active = False
        self.reader_task = None
        self.session_no = 0           # increments per (re)connection so turn keys stay unique
        self.finalized = set()
        self.pending_final = {}       # turn_key -> asyncio.Task (fallback finalize)

    def _url(self):
        params = {"sample_rate": 16000, "encoding": "pcm_s16le"}
        if self.speech_model:
            params["speech_model"] = self.speech_model
        if self.speaker_labels:
            params["speaker_labels"] = "true"
        return f"{AAI_URL}?{urlencode(params)}"

    async def start(self):
        self.active = True
        await self._connect()
        self.reader_task = asyncio.create_task(self._reader_loop())

    async def _connect(self):
        self.session_no += 1
        self.ws = await websockets.connect(
            self._url(),
            additional_headers={"Authorization": self.api_key},
            max_size=None,
            ping_interval=20,
        )

    async def send_audio(self, chunk: bytes):
        ws = self.ws
        if not (self.active and ws):
            return
        try:
            await ws.send(chunk)
        except Exception:
            pass  # reader loop handles reconnection

    async def _reader_loop(self):
        attempts = 0
        while self.active:
            try:
                async for raw in self.ws:
                    attempts = 0
                    if isinstance(raw, bytes):
                        continue
                    await self._handle(json.loads(raw))
                # socket closed normally
                if not self.active:
                    break
                log.warning("[%s] AssemblyAI socket closed (code=%s)", self.source, self.ws.close_code)
            except Exception as e:  # network error
                if not self.active:
                    break
                log.warning("[%s] AssemblyAI error: %s", self.source, e)
            # unexpected close -> reconnect with backoff
            attempts += 1
            if attempts > 5:
                await self.on_status(self.source, "error", "Transcription connection lost. Please restart listening.")
                self.active = False
                break
            await self.on_status(self.source, "reconnecting", f"Reconnecting (attempt {attempts})…")
            await asyncio.sleep(min(2 ** attempts, 10) * 0.5)
            try:
                await self._connect()
            except Exception as e:
                log.warning("[%s] reconnect failed: %s", self.source, e)

    def _speaker(self, msg):
        if self.source == "mic":
            return "You"
        label = msg.get("speaker_label")
        if not label:
            words = msg.get("words") or []
            labels = [w.get("speaker") for w in words if w.get("speaker")]
            if labels:
                label = max(set(labels), key=labels.count)
        if label and str(label).upper() not in ("UNKNOWN", "NONE"):
            return f"Speaker {label}"
        return "Participant"

    async def _handle(self, msg):
        t = msg.get("type")
        if t == "Begin":
            log.info("[%s] session begin: %s", self.source, msg.get("configuration"))
            await self.on_status(self.source, "connected", "")
        elif t == "Turn":
            key = f"{self.source}-{self.session_no}-{msg.get('turn_order', 0)}"
            text = (msg.get("transcript") or "").strip()
            if key in self.finalized:
                return
            speaker = self._speaker(msg)
            if not msg.get("end_of_turn"):
                if text:
                    await self.on_partial(self.source, key, speaker, text)
                return
            if msg.get("turn_is_formatted"):
                pending = self.pending_final.pop(key, None)
                if pending:
                    pending[0].cancel()
                await self._finalize(key, speaker, text)
            else:
                # show it as (nearly) final, but give AssemblyAI a moment to send the formatted version
                if text:
                    await self.on_partial(self.source, key, speaker, text)
                if key not in self.pending_final:
                    task = asyncio.create_task(self._delayed_finalize(key, speaker, text))
                    self.pending_final[key] = (task, speaker, text)
        elif t == "Termination":
            log.info("[%s] terminated: %s", self.source, msg)
        elif t == "Error":
            log.error("[%s] AssemblyAI error message: %s", self.source, msg)
            await self.on_status(self.source, "error", f"AssemblyAI: {msg.get('error')} ({msg.get('error_code')})")

    async def _delayed_finalize(self, key, speaker, text):
        try:
            await asyncio.sleep(FORMAT_GRACE_SECONDS)
        except asyncio.CancelledError:
            return
        self.pending_final.pop(key, None)
        await self._finalize(key, speaker, text)

    async def _finalize(self, key, speaker, text):
        if key in self.finalized:
            return
        self.finalized.add(key)
        if text:
            await self.on_final(self.source, key, speaker, text)

    async def stop(self):
        if not self.active and not self.ws:
            return
        self.active = False
        ws = self.ws
        try:
            if ws:
                await ws.send(json.dumps({"type": "Terminate"}))
                # let the reader receive the last Turn + Termination
                await asyncio.wait_for(self._drain(ws), timeout=4)
        except Exception:
            pass
        try:
            if ws:
                await ws.close()
        except Exception:
            pass
        if self.reader_task:
            self.reader_task.cancel()
        # flush any turns still waiting for formatting
        for key, (task, speaker, text) in list(self.pending_final.items()):
            task.cancel()
            await self._finalize(key, speaker, text)
        self.pending_final.clear()
        self.ws = None

    async def _drain(self, ws):
        # the reader loop keeps consuming messages until AssemblyAI closes the socket
        await ws.wait_closed()
