"""AETHER intelligence engine.

Two paths:
  * FAST path  - when another participant finishes a turn that looks like a question,
                 request or objection, immediately ask the LLM for a suggested reply.
  * SLOW path  - every N seconds (or after enough new turns) analyse ONLY the new turns,
                 together with a compact running summary and the current insight state,
                 and return structured upserts (action items, decisions, deadlines,
                 key points, concerns). Items keep stable ids so they are updated,
                 not duplicated.
"""
import asyncio
import datetime
import difflib
import json
import logging
import re
import time

from .llm import GroqClient, LLMError

log = logging.getLogger("aether.brain")

CATEGORIES = {
    # name: (id prefix, field used for duplicate detection)
    "action_items": ("A", "task"),
    "decisions": ("D", "decision"),
    "deadlines": ("T", "what"),
    "key_points": ("K", "point"),
    "concerns": ("C", "issue"),
    "commitments": ("P", "commitment"),
    "follow_ups": ("F", "item"),
}

QUESTION_START = re.compile(
    r"^(what|why|how|when|where|who|which|can|could|would|will|should|do|does|did|is|are|was|were|have|has|any|shall|may)\b",
    re.I,
)
COMMIT_WORDS = re.compile(
    r"\b(i'll|i will|we'll|we will|let's|lets|agreed|agree|decided|decide|deadline|due|assign|responsible|"
    r"take care of|action item|follow up|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|"
    r"next week|end of|eod|the \d+))\b",
    re.I,
)
TRIGGER_WORDS = re.compile(
    r"\b(concern|worried|problem|issue|risk|disagree|not sure|don't think|doesn't work|won't work|can't|cannot|"
    r"blocker|blocked|delay|expensive|budget|deadline|need you to|could you|can you|would you|please|thoughts|"
    r"what do you think|your take|opinion|explain|clarify)\b",
    re.I,
)

FAST_SYSTEM = """You are AETHER, a real-time meeting copilot whispering to the user ("You") during a live meeting.
Another participant just spoke. Decide if the user would benefit from a suggested reply RIGHT NOW
(a question they may need to answer, a request, an objection/concern, or a point needing a response).
Rules:
- Only show when genuinely useful. Small talk, filler, rhetorical or already-answered questions -> SHOW: no.
- The suggestion must be something the user can say out loud: natural, concise (max 2 sentences), first person.
- Base it ONLY on the conversation. NEVER claim progress, status, numbers, dates or commitments the user has not stated.
  If the needed facts are unknown, suggest a reply that frames the trade-offs from what WAS said, proposes a next step, or asks a clarifying question.
- Do not repeat a suggestion listed under RECENT SUGGESTIONS.
Output EXACTLY these lines, in this order, nothing else (if not useful, output only "SHOW: no"):
SHOW: yes
KIND: answer|response|objection|clarify
TRIGGER: <the question/point being addressed, max 12 words>
WHY: <max 12 words of reasoning>
SUGGESTION: <what the user could say>"""

ANALYSIS_SYSTEM = """You are AETHER's meeting-analysis engine. You maintain a live, structured record of a meeting.
"You" is the AETHER user. Other speakers are participants.
You receive: a running SUMMARY, the CURRENT STATE of extracted items (with ids), and NEW TRANSCRIPT turns
(a few earlier turns are included as context, marked [context]).
Extract only what the NEW turns add or change. Rules:
- Return ONLY new items or items whose details changed. To update an existing item, reuse its exact id. New items: id=null.
- Never create an item that duplicates an existing one; update it instead.
- "You" may also be addressed by the user's name (given as USER NAME): tasks for that name belong to "You".
- due_date: resolve any deadline to a calendar date "YYYY-MM-DD" by looking it up in CALENDAR ("by Wednesday" -> the first Wed after TODAY; "tomorrow" -> the day after TODAY). null if no date was given.
- Capture EVERY task and commitment, including ones taken by other participants (one item per task; split "I'll do X and Y" into two).
- action_items: concrete tasks. owner = person responsible ("You" if assigned to/accepted by the user) or null. assigned_by = the speaker who asked for / assigned the task (use their speaker label, "You" for the user), or null if self-assigned/unclear. status "confirmed" if someone accepted/was assigned it, "proposed" if only suggested. done=true only if stated completed.
- decisions: status "confirmed" only when the group clearly agreed; otherwise "proposed". decided_by = who proposed/made the final call (speaker label) or null.
- commitments: explicit promises a person made in their own words ("I'll send it by Friday", "we will deliver X"). who = the person promising, to_whom = who it was promised to (or null), when = the time phrase or null.
- deadlines: project dates and milestones (launches, due dates, events) that are not one person's promise. who = responsible person or null.
- follow_ups: things the user should chase after the meeting: unanswered questions, items waiting on someone, things to confirm or revisit next time. owner = who should follow up (usually "You") or null.
- key_points: important facts, requirements, numbers, technical details. Concise. Skip trivia.
- concerns: type "objection" | "risk" | "open_question". resolved=true if addressed later. suggestion = a short way the user could respond or mitigate (or null).
- Use the speakers' own facts. Never invent details. Keep every text field under 25 words.
- EVERY item (all categories) also gets "evidence": {"quote": the exact words from the transcript that support it (max 20 words, copied verbatim), "speaker": who said it} and "confidence": a number 0-1 for how clearly the transcript supports it.
- action_items also get "priority": "high"|"medium"|"low" (urgency + impact: near deadlines, blockers for others, client-facing = higher), "priority_reason": max 10 words, and "depends_on": what this task waits on (another task, decision or person, max 12 words) or null.
- If the new turns contain nothing meaningful, return empty lists.
- summary: rewrite the running summary to include the new turns, max 120 words.
Return JSON exactly:
{"summary": str,
 "action_items": [{"id": str|null, "task": str, "owner": str|null, "assigned_by": str|null, "deadline": str|null, "due_date": str|null, "status": "confirmed"|"proposed", "done": bool, "priority": "high"|"medium"|"low", "priority_reason": str, "depends_on": str|null, "evidence": {"quote": str, "speaker": str}, "confidence": number}],
 "decisions": [{"id": str|null, "decision": str, "context": str|null, "decided_by": str|null, "status": "confirmed"|"proposed", "evidence": {"quote": str, "speaker": str}, "confidence": number}],
 "commitments": [{"id": str|null, "commitment": str, "who": str, "to_whom": str|null, "when": str|null, "due_date": str|null, "evidence": {"quote": str, "speaker": str}, "confidence": number}],
 "follow_ups": [{"id": str|null, "item": str, "owner": str|null, "reason": str|null, "evidence": {"quote": str, "speaker": str}, "confidence": number}],
 "deadlines": [{"id": str|null, "what": str, "who": str|null, "when": str, "due_date": str|null, "evidence": {"quote": str, "speaker": str}, "confidence": number}],
 "key_points": [{"id": str|null, "point": str, "evidence": {"quote": str, "speaker": str}, "confidence": number}],
 "concerns": [{"id": str|null, "issue": str, "type": "objection"|"risk"|"open_question", "resolved": bool, "suggestion": str|null, "evidence": {"quote": str, "speaker": str}, "confidence": number}]}"""

SUMMARY_SYSTEM = """You are AETHER. Write a clear, well-organized meeting summary in Markdown using the transcript
and the extracted items. The FIRST line must be "# <short specific meeting title, max 7 words>". Then sections: ## Overview (3-5 sentences), ## Key Discussion Points, ## Decisions,
## Action Items (task - owner - deadline), ## Deadlines & Commitments, ## Open Questions & Risks, ## Suggested Next Steps.
Only include facts from the meeting. Omit a section's bullets with "None noted." if empty."""


def _norm(s):
    return re.sub(r"[^a-z0-9 ]", "", (s or "").lower()).strip()


class Brain:
    def __init__(self, llm: GroqClient, emit, model: str, fast_model: str, interval: float,
                 user_name: str = "", today: str = ""):
        self.llm = llm
        self.user_name = (user_name or "").strip()[:60]
        self.today = (today or time.strftime("%A, %Y-%m-%d"))[:40]
        self.emit = emit  # async (dict) -> None
        self.model = model
        self.fast_model = fast_model
        self.interval = interval
        self.turns = []  # {"i", "speaker", "source", "text", "t"}
        self.analyzed_upto = 0
        self.summary = ""
        self.state = {k: [] for k in CATEGORIES}
        self.counters = {k: 0 for k in CATEGORIES}
        self.recent_suggestions = []
        self.analysis_lock = asyncio.Lock()
        self.fast_inflight = 0
        self.loop_task = None
        self.started_at = None
        self.running = False
        self.urgent = False          # something commitment-like was said -> analyse soon
        self.last_analysis = 0.0
        self.quota_warned = False

    # ---------- lifecycle ----------
    def start(self):
        if self.running:
            return
        self.running = True
        self.started_at = self.started_at or time.time()
        self.loop_task = asyncio.create_task(self._loop())

    async def stop(self):
        self.running = False
        if self.loop_task:
            self.loop_task.cancel()
            self.loop_task = None
        await self.analyze()  # final flush

    async def _loop(self):
        """Analyse every `interval` seconds when there is new speech, or after ~5 s when a
        commitment/decision was just said. Skips a cycle when the Groq token budget is low
        so live suggestions always have room (prevents rate-limit errors)."""
        try:
            while self.running:
                await asyncio.sleep(1)
                new = len(self.turns) - self.analyzed_upto
                if new <= 0 or self.analysis_lock.locked():
                    continue
                since = time.time() - self.last_analysis
                interval = self.interval
                if self.llm.requests_left(self.model) < 40:
                    interval = max(interval, 45)  # daily request quota nearly used up: slow down
                    if not self.quota_warned:
                        self.quota_warned = True
                        await self.emit({"type": "notice", "level": "warn",
                                         "message": "Groq daily quota is running low; insights will update less often."})
                due = since >= interval or new >= 8 or (self.urgent and since >= 5)
                if not due:
                    continue
                if self.llm.tokens_left(self.model) < 2500:
                    continue  # wait for the per-minute token window to refill
                asyncio.create_task(self.analyze())
        except asyncio.CancelledError:
            pass

    # ---------- input ----------
    async def add_turn(self, speaker, source, text):
        turn = {"i": len(self.turns), "speaker": speaker, "source": source, "text": text, "t": time.time()}
        self.turns.append(turn)
        if COMMIT_WORDS.search(text):
            self.urgent = True
        if source != "mic" and self._worth_fast_path(text):
            asyncio.create_task(self._fast_suggest(turn))

    def _worth_fast_path(self, text):
        words = text.split()
        if len(words) < 3:
            return False
        return "?" in text or bool(QUESTION_START.match(text)) or bool(TRIGGER_WORDS.search(text))

    # ---------- fast path ----------
    def _fmt(self, turns, context_upto=None):
        lines = []
        for t in turns:
            tag = "[context] " if context_upto is not None and t["i"] < context_upto else ""
            lines.append(f"{tag}{t['speaker']}: {t['text']}")
        return "\n".join(lines)

    async def _fast_suggest(self, turn):
        if self.fast_inflight >= 2:
            return
        self.fast_inflight += 1
        sid = None
        stream = None
        try:
            recent = self.turns[max(0, turn["i"] - 12): turn["i"] + 1]
            user = (
                f"MEETING SUMMARY SO FAR:\n{self.summary or '(meeting just started)'}\n\n"
                f"RECENT CONVERSATION:\n{self._fmt(recent)}\n\n"
                f"LATEST TURN (respond to this): {turn['speaker']}: {turn['text']}\n"
                f"(The user's name is {self.user_name or 'unknown'}; they appear as \"You\".)\n\n"
                f"RECENT SUGGESTIONS:\n" + ("\n".join(f"- {s}" for s in self.recent_suggestions[-5:]) or "(none)")
            )
            stream = self.llm.stream_text(
                [{"role": "system", "content": FAST_SYSTEM}, {"role": "user", "content": user}],
                model=self.fast_model, max_tokens=250, temperature=0.4,
            )
            buf, header, sugg = "", {}, ""
            async for delta in stream:
                if sid is None:
                    buf += delta
                    # consume completed header lines (SHOW / KIND / TRIGGER / WHY)
                    while "\n" in buf and "SUGGESTION:" not in buf.split("\n", 1)[0]:
                        line, buf = buf.split("\n", 1)
                        if ":" in line:
                            k, v = line.split(":", 1)
                            header[k.strip().upper()] = v.strip()
                        if header.get("SHOW", "yes").lower().startswith("no"):
                            return
                    if "SUGGESTION:" in buf:
                        if any(t["source"] == "mic" for t in self.turns[turn["i"] + 1:]):
                            return  # the user already answered
                        sugg = buf.split("SUGGESTION:", 1)[1].lstrip()
                        sid = f"S{turn['i']}-{int(time.time() * 1000) % 100000}"
                        await self.emit({
                            "type": "suggestion_start", "id": sid,
                            "kind": (header.get("KIND") or "response").split("|")[0].strip().lower(),
                            "trigger": header.get("TRIGGER") or turn["text"],
                            "why": header.get("WHY", ""), "speaker": turn["speaker"],
                        })
                        if sugg:
                            await self.emit({"type": "suggestion_delta", "id": sid, "text": sugg})
                else:
                    sugg += delta
                    await self.emit({"type": "suggestion_delta", "id": sid, "text": delta})
            if sid is None:
                return
            sugg = sugg.strip().strip('"')
            duplicate = any(difflib.SequenceMatcher(None, _norm(sugg), _norm(x)).ratio() > 0.8
                            for x in self.recent_suggestions[-8:])
            if not sugg or duplicate:
                await self.emit({"type": "suggestion_cancel", "id": sid})
                return
            self.recent_suggestions.append(sugg)
            await self.emit({"type": "suggestion_done", "id": sid, "suggestion": sugg})
        except LLMError as e:
            log.warning("fast path failed: %s", e)
            if sid:
                await self.emit({"type": "suggestion_cancel", "id": sid})
            await self._llm_error(e)
        except Exception:
            log.exception("fast path crashed")
            if sid:
                await self.emit({"type": "suggestion_cancel", "id": sid})
        finally:
            if stream is not None:
                try:
                    await stream.aclose()
                except Exception:
                    pass
            self.fast_inflight -= 1

    def _calendar(self):
        """Next 21 days as 'Sat 2026-11-21, Sun 2026-11-22, ...' so the model looks dates up
        instead of doing (error-prone) weekday arithmetic."""
        m = re.search(r"(\d{4})-(\d{2})-(\d{2})", self.today or "")
        try:
            base = datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else datetime.date.today()
        except ValueError:
            base = datetime.date.today()
        days = [base + datetime.timedelta(days=i) for i in range(22)]
        return ", ".join(("TODAY " if i == 0 else "") + d.strftime("%a %Y-%m-%d") for i, d in enumerate(days))

    # ---------- slow path ----------
    def _state_for_prompt(self):
        compact = {}
        skip = ("updated", "new", "evidence", "confidence", "priority_reason", "doneAt", "dueUser", "agent", "actions")
        for cat, items in self.state.items():
            compact[cat] = [{k: v for k, v in it.items() if k not in skip} for it in items[-25:]]
        return json.dumps(compact, ensure_ascii=False)

    async def analyze(self):
        if self.analysis_lock.locked():
            return
        async with self.analysis_lock:
            end = len(self.turns)
            start = self.analyzed_upto
            if end <= start:
                return
            self.last_analysis = time.time()
            self.urgent = False
            ctx_from = max(0, start - 4)
            chunk = self.turns[ctx_from:end]
            user = (
                f"SUMMARY:\n{self.summary or '(empty)'}\n\n"
                f"TODAY: {self.today}\nUSER NAME: {self.user_name or '(unknown)'}\n"
                f"CALENDAR (use this to resolve weekdays, never compute): {self._calendar()}\n\n"
                f"CURRENT STATE:\n{self._state_for_prompt()}\n\n"
                f"NEW TRANSCRIPT:\n{self._fmt(chunk, context_upto=start)}"
            )
            try:
                out = await self.llm.chat(
                    [{"role": "system", "content": ANALYSIS_SYSTEM}, {"role": "user", "content": user}],
                    model=self.model, max_tokens=2000, temperature=0.2,
                )
            except LLMError as e:
                log.warning("analysis failed: %s", e)
                await self._llm_error(e)
                return  # keep analyzed_upto so the turns are retried next cycle
            self.analyzed_upto = end
            if isinstance(out.get("summary"), str) and out["summary"].strip():
                self.summary = out["summary"].strip()
            changed = []
            for cat in CATEGORIES:
                for item in out.get(cat) or []:
                    if isinstance(item, dict):
                        cid = self._upsert(cat, item)
                        if cid:
                            changed.append(cid)
            await self.emit({"type": "insights", "state": self.state, "changed": changed, "summary": self.summary})

    def _upsert(self, cat, item):
        prefix, key_field = CATEGORIES[cat]
        text = (item.get(key_field) or "").strip()
        if not text:
            return None
        items = self.state[cat]
        target = None
        iid = item.get("id")
        if iid:
            target = next((x for x in items if x["id"] == iid), None)
        if target is None:  # guard against duplicates the model failed to link
            for x in items:
                if difflib.SequenceMatcher(None, _norm(x.get(key_field)), _norm(text)).ratio() > 0.82:
                    target = x
                    break
        clean = {k: v for k, v in item.items() if k != "id" and v is not None}
        if target is not None:
            if target.get("done") and clean.get("done") is False:
                clean.pop("done")  # never undo a task the user ticked off
            before = dict(target)
            target.update(clean)
            if target != before:
                target["updated"] = time.time()
                return target["id"]
            return None
        self.counters[cat] += 1
        new = {"id": f"{prefix}{self.counters[cat]}", **clean, "updated": time.time()}
        items.append(new)
        return new["id"]

    def set_done(self, item_id, done):
        for it in self.state["action_items"]:
            if it["id"] == item_id:
                it["done"] = bool(done)
                return True
        return False

    # ---------- summary ----------
    async def final_summary(self):
        await self.analyze()
        return await summarize(self.llm, self.model, self.turns, self.state, self.summary)

    async def _llm_error(self, e):
        await self.emit({"type": "notice", "level": "warn", "message": f"AI temporarily unavailable: {str(e)[:160]}"})


FOLLOWUP_SYSTEM = """You are AETHER. Write a concise, friendly follow-up message the user can send to the meeting
participants right after the meeting. Plain text (no Markdown headings), ready to paste into email or chat.
Structure: a subject line starting with "Subject: ", a one-line thank-you, a short recap (2-3 sentences),
"Decisions:" bullets, "Action items:" bullets as "- <task> — <owner> (<deadline>)", "Open questions:" bullets if any,
and a short closing line. Use "-" for bullets. Only include facts from the meeting; skip empty sections.
Refer to the user in first person (I/we). Keep it under 220 words."""


async def followup_message(llm, model, title, turns, state, summary="", user_name=""):
    compact = {cat: [{k: v for k, v in it.items() if k not in ("updated", "new", "doneAt", "dueUser")}
                     for it in (state or {}).get(cat, [])[-25:]] for cat in CATEGORIES}
    tail = "\n".join(f"{t.get('speaker', '?')}: {t.get('text', '')}" for t in (turns or [])[-60:])
    who = (f"The user (shown as \"You\" in the data) is named {user_name}. In the message, write tasks owned by \"You\" "
           f"with the name {user_name}." if user_name else "The user appears as \"You\"; in the message write \"me\" for their tasks.")
    user = (f"{who}\nMEETING TITLE: {title or 'Meeting'}\n\nSUMMARY:\n{summary or '(none)'}\n\n"
            f"EXTRACTED ITEMS:\n{json.dumps(compact, ensure_ascii=False)}\n\nEND OF TRANSCRIPT:\n{tail or '(none)'}")
    return await llm.chat(
        [{"role": "system", "content": FOLLOWUP_SYSTEM}, {"role": "user", "content": user}],
        model=model, json_mode=False, max_tokens=700, temperature=0.4,
    )


AGENT_SYSTEM = """You are AETHER Agent, an autonomous assistant that gets the user's meeting tasks DONE.
You receive ONE task assigned to the user plus CONTEXT from all their meetings. Think for yourself:
work out what the task really needs, use the context (people, facts, related commitments, open follow-ups,
dependencies, deadlines), then produce the actual deliverables so the user only has to review and send.
Rules:
- Produce real, complete work: full emails / documents / messages, not outlines. Professional and concise.
- Never invent facts (prices, dates, numbers). Use placeholders like [PRICE PER SEAT] and ask a question instead.
- "to" must be the person's NAME only (e.g. "Sofia (Horizon Retail)"). NEVER write or guess an email address anywhere.
- Use what the context says (e.g. requirements a client mentioned, unconfirmed dependencies) - that is the point.
- Proactive: point out risks, dependencies or related things the user should do (e.g. nudge someone whose input is needed); you may add a drafted message for it as an extra output.
- Nothing is sent automatically; the user approves everything.
- The user's name is given; write in their voice (first person).
Return JSON:
{"thinking": [3-6 short sentences showing your reasoning],
 "plan": [2-5 short steps],
 "outputs": [{"type": "email"|"document"|"message", "title": str, "to": str|null, "subject": str|null, "body": str}],
 "questions": [short questions for missing facts],
 "proactive": [short notes on risks / dependencies / next steps]}"""


async def run_agent(llm, model, task, context, user_name="", today=""):
    user = (f"TODAY: {today or time.strftime('%A, %Y-%m-%d')}\nUSER NAME: {user_name or '(unknown)'}\n\n"
            f"TASK:\n{json.dumps(task, ensure_ascii=False)}\n\n"
            f"CONTEXT FROM MEETINGS:\n{json.dumps(context, ensure_ascii=False)[:14000]}")
    return await llm.chat(
        [{"role": "system", "content": AGENT_SYSTEM}, {"role": "user", "content": user}],
        model=model, json_mode=True, max_tokens=1800, temperature=0.4,
    )


async def summarize(llm, model, turns, state, running_summary=""):
    """Stateless summary: used at the end of a live meeting and for saved meetings."""
    transcript = "\n".join(f"{t.get('speaker', '?')}: {t.get('text', '')}" for t in turns)
    if len(transcript) > 24000:  # keep within token budget: summary + tail of transcript
        transcript = "...(earlier part condensed in summary)...\n" + transcript[-24000:]
    compact = {cat: [{k: v for k, v in it.items() if k not in ("updated", "new")} for it in (state or {}).get(cat, [])[-25:]]
               for cat in CATEGORIES}
    user = (
        f"RUNNING SUMMARY:\n{running_summary or '(none)'}\n\nEXTRACTED ITEMS:\n{json.dumps(compact, ensure_ascii=False)}\n\n"
        f"TRANSCRIPT:\n{transcript or '(no speech captured)'}"
    )
    return await llm.chat(
        [{"role": "system", "content": SUMMARY_SYSTEM}, {"role": "user", "content": user}],
        model=model, json_mode=False, max_tokens=1500, temperature=0.3,
    )
