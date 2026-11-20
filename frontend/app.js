// Gather frontend
//  - Dashboard (#/)            : stats, meeting history, open action items across meetings
//  - Live meeting (#/live)     : captures mic + meeting audio, live transcript + AI insights
//  - Meeting page (#/meeting/X): saved transcript, summary, items for one meeting
// Meeting history is stored in this browser (localStorage) so it survives server restarts.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const CATS = ["action_items", "decisions", "commitments", "follow_ups", "deadlines", "key_points", "concerns"];
  const emptyState = () => Object.fromEntries(CATS.map((c) => [c, []]));

  // =====================================================================
  // Storage
  // =====================================================================
  const Store = {
    get IDX() { return K("index"); },
    ids() { try { return JSON.parse(localStorage.getItem(this.IDX) || "[]"); } catch { return []; } },
    get(id) { try { return JSON.parse(localStorage.getItem(K("m." + id))); } catch { return null; } },
    list() { return this.ids().map((id) => this.get(id)).filter(Boolean).sort((a, b) => b.startedAt - a.startedAt); },
    save(m) {
      try {
        localStorage.setItem(K("m." + m.id), JSON.stringify(m));
        const ids = this.ids();
        if (!ids.includes(m.id)) { ids.push(m.id); localStorage.setItem(this.IDX, JSON.stringify(ids)); }
      } catch (e) {
        toast("Browser storage is full — delete some old meetings.", "error");
      }
    },
    remove(id) {
      localStorage.removeItem(K("m." + id));
      localStorage.setItem(this.IDX, JSON.stringify(this.ids().filter((x) => x !== id)));
    },
  };

  // =====================================================================
  // State
  // =====================================================================
  let ws = null, wsReady = false, listening = false;
  let audioCtx = null, mediaStreams = [];
  let timerInt = null;
  let current = null;            // the meeting being recorded (or last recorded in this tab)
  let summaryPendingFor = null;  // meeting id awaiting a summary from the live session
  let saveTimer = null;
  const turnEls = new Map();
  const streaming = new Map();   // suggestion id -> suggestion being streamed
  const SRC_ID = { mic: 0, system: 1 };

  function newMeeting() {
    const now = new Date();
    return {
      id: "m" + now.getTime().toString(36),
      title: "Meeting — " + now.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
      titleAuto: true,
      startedAt: now.getTime(), endedAt: null, duration: 0,
      turns: [], state: emptyState(), suggestions: [], liveSummary: "", summary: null, summaryError: null,
    };
  }
  function saveCurrentSoon() {
    if (!current) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => current && Store.save(current), 800);
  }

  // =====================================================================
  // WebSocket
  // =====================================================================
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = "arraybuffer";
    setConn("warn", "Connecting…");
    ws.onopen = () => { wsReady = true; setConn("ok", "Connected"); };
    ws.onclose = () => {
      wsReady = false;
      setConn("bad", "Disconnected — retrying");
      if (listening) { toast("Connection to server lost. Meeting saved and stopped.", "error"); finishMeeting(false); }
      setTimeout(connect, 2000);
    };
    ws.onmessage = (ev) => { try { handle(JSON.parse(ev.data)); } catch (e) { console.error(e); } };
  }
  setInterval(() => { if (wsReady) send({ type: "ping" }); }, 25000);
  const send = (obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  function handle(m) {
    switch (m.type) {
      case "hello":
        if (!m.assemblyai_key || !m.groq_key) toast("Server is missing API keys — check the .env file.", "error");
        break;
      case "transcript":
        if (!current) return;
        renderTurn(m);
        Pip.turn(m);
        if (m.final) { current.turns.push({ speaker: m.speaker, source: m.source, text: m.text, t: Date.now() }); saveCurrentSoon(); }
        break;
      case "suggestion_start": {
        if (!current) return;
        streaming.set(m.id, { ...m, suggestion: "" });
        renderLiveSuggestion({ ...m, suggestion: "" }, true);
        Pip.renderSuggestion();
        break;
      }
      case "suggestion_delta": {
        const s = streaming.get(m.id);
        if (!s) return;
        s.suggestion += m.text;
        const el = document.querySelector(`.sugg[data-sid="${m.id}"] .a`);
        if (el) el.textContent = s.suggestion;
        Pip.soon(Pip.renderSuggestion);
        break;
      }
      case "suggestion_done": {
        const s = streaming.get(m.id);
        streaming.delete(m.id);
        if (!s || !current) return;
        s.suggestion = m.suggestion;
        const el = document.querySelector(`.sugg[data-sid="${m.id}"]`);
        if (el) { el.classList.remove("typing"); el.querySelector(".a").textContent = m.suggestion; }
        current.suggestions.unshift({ kind: s.kind, speaker: s.speaker, trigger: s.trigger, suggestion: m.suggestion, why: s.why, t: Date.now() });
        current.suggestions = current.suggestions.slice(0, 60);
        saveCurrentSoon();
        Pip.renderSuggestion();
        break;
      }
      case "suggestion_cancel":
        streaming.delete(m.id);
        document.querySelector(`.sugg[data-sid="${m.id}"]`)?.remove();
        Pip.renderSuggestion();
        break;
      case "insights":
        if (!current) return;
        current.state = mergeLocal(current.state, m.state);
        current.liveSummary = m.summary || current.liveSummary;
        renderInsights(current.state, m.changed || [], "", current.id);
        Pip.renderFeed();
        saveCurrentSoon();
        break;
      case "stt_status":
        if (m.state === "reconnecting") toast(`Transcription (${m.source === "mic" ? "you" : "meeting audio"}) reconnecting…`, "warn");
        if (m.state === "error") toast(m.detail, "error");
        break;
      case "notice": toast(m.message, m.level); break;
      case "summary_status":
        if (m.state === "error" && summaryPendingFor) setSummary(summaryPendingFor, null, m.message || "Summary failed");
        break;
      case "summary":
        if (summaryPendingFor) setSummary(summaryPendingFor, m.markdown, null);
        break;
    }
  }

  function setSummary(id, markdown, error) {
    const mtg = (current && current.id === id) ? current : Store.get(id);
    if (!mtg) return;
    mtg.summary = markdown;
    mtg.summaryError = error;
    if (markdown && mtg.titleAuto) {
      const h = markdown.match(/^#\s+(.+)$/m);
      if (h) mtg.title = h[1].replace(/[*#]/g, "").trim();
    }
    Store.save(mtg);
    if (summaryPendingFor === id) summaryPendingFor = null;
    if (route.view === "meeting" && route.id === id) renderMeetingPage(id);
    if (markdown) document.dispatchEvent(new CustomEvent("aether:summary-ready", { detail: { id } }));
  }

  // =====================================================================
  // Audio capture
  // =====================================================================
  async function startCapture(withSystem) {
    const sources = [];
    audioCtx = new AudioContext();
    await audioCtx.audioWorklet.addModule("/static/pcm-worklet.js");
    const sink = audioCtx.createGain();
    sink.gain.value = 0; // keep the graph running without playing anything back
    sink.connect(audioCtx.destination);

    if (withSystem) {
      try {
        const disp = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          systemAudio: "include",
          selfBrowserSurface: "exclude",
        });
        if (disp.getAudioTracks().length === 0) {
          disp.getTracks().forEach((t) => t.stop());
          toast("No audio was shared. Restart and tick “Share audio” (tab or entire screen).", "error");
        } else {
          mediaStreams.push(disp);
          attach(new MediaStream(disp.getAudioTracks()), "system", sink);
          sources.push("system");
          disp.getTracks().forEach((t) => (t.onended = () => {
            if (listening) toast("Screen/tab sharing ended — meeting audio is no longer captured.", "warn");
          }));
        }
      } catch (e) {
        toast("Meeting audio not shared — continuing with your microphone only.", "warn");
      }
    }
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      mediaStreams.push(mic);
      attach(mic, "mic", sink);
      sources.push("mic");
    } catch (e) {
      toast("Microphone permission denied — only meeting audio will be captured.", "warn");
    }

    return sources;
  }

  function attach(stream, source, sink) {
    const node = new AudioWorkletNode(audioCtx, "pcm-worklet");
    audioCtx.createMediaStreamSource(stream).connect(node);
    node.connect(sink);
    const meter = source === "mic" ? $("micLevel") : $("sysLevel");
    node.port.onmessage = ({ data }) => {
      meter.style.width = Math.min(100, Math.round(Math.sqrt(data.level) * 100)) + "%";
      if (!listening || !ws || ws.readyState !== 1) return;
      const pcm = new Uint8Array(data.pcm);
      const out = new Uint8Array(pcm.length + 1);
      out[0] = SRC_ID[source];
      out.set(pcm, 1);
      ws.send(out.buffer);
    };
  }

  function stopCapture() {
    mediaStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    mediaStreams = [];
    if (audioCtx) audioCtx.close().catch(() => {});
    audioCtx = null;
    $("micLevel").style.width = "0";
    $("sysLevel").style.width = "0";
  }

  // =====================================================================
  // Live meeting controls
  // =====================================================================
  function openStartDialog() {
    if (!Auth.current) return;
    if (listening) { location.hash = "#/live"; return; }
    const st = Settings.get();
    $("optSystem").checked = st.capture;
    if (Pip.supported()) $("optPip").checked = st.pip;
    if (!wsReady) return toast("Not connected to the server yet.", "warn");
    $("optTitle").value = "";
    $("startModal").hidden = false;
    setTimeout(() => $("optTitle").focus(), 50);
  }
  $("startBtn").onclick = openStartDialog;
  $("newMeetingBtn").onclick = openStartDialog;
  $("optConsent").onchange = (e) => ($("confirmStart").disabled = !e.target.checked);
  $("cancelStart").onclick = () => ($("startModal").hidden = true);

  $("confirmStart").onclick = async () => {
    $("startModal").hidden = true;
    $("startBtn").disabled = true;
    location.hash = "#/live";
    try {
      const sources = await startCapture($("optSystem").checked);
      if (!sources.length) {
        stopCapture();
        $("startBtn").disabled = false;
        return toast("No audio source available.", "error");
      }
      current = newMeeting();
      const chosen = $("optTitle").value.trim();
      if (chosen) { current.title = chosen; current.titleAuto = false; } // never overwritten by the AI title
      resetLiveView();
      Store.save(current);
      listening = true;
      send({ type: "start", sources, user_name: Profile.get().name || "", today: todayString() });
      setListeningUI(true);
      Pip.lastTurn = null;
      if ($("optPip").checked) Pip.open(true); else Pip.renderAll();
    } catch (e) {
      console.error(e);
      stopCapture();
      $("startBtn").disabled = false;
      toast("Could not start audio capture: " + e.message, "error");
    }
  };

  $("stopBtn").onclick = () => finishMeeting(true);

  function finishMeeting(serverAlive) {
    if (!current) return;
    stopCapture();
    listening = false;
    setListeningUI(false);
    Pip.close();
    current.endedAt = Date.now();
    current.duration = current.endedAt - current.startedAt;
    if (!current.turns.length) {
      if (serverAlive) send({ type: "stop" });
      Store.remove(current.id);
      toast("Nothing was captured, so the meeting wasn't saved.", "warn");
      current = null;
      location.hash = "#/";
      return;
    }
    Store.save(current);
    if (serverAlive) {
      summaryPendingFor = current.id;
      send({ type: "stop", summary: true }); // server flushes final analysis, then writes the summary
    }
    location.hash = "#/meeting/" + current.id;
  }

  $("liveTitle").onchange = (e) => {
    if (!current) return;
    current.title = e.target.value.trim() || current.title;
    current.titleAuto = false;
    saveCurrentSoon();
  };

  function setListeningUI(on) {
    document.body.classList.toggle("listening", on);
    $("startBtn").disabled = on;
    $("stopBtn").disabled = !on;
    $("listenPill").classList.toggle("live", on);
    $("listenText").textContent = on ? "Listening" : "Idle";
    $("navLive").hidden = !on;
    if (on && !timerInt) { timerInt = setInterval(tick, 1000); tick(); }
    if (!on && timerInt) { clearInterval(timerInt); timerInt = null; }
  }
  function tick() {
    if (!current) return;
    $("timer").textContent = fmtClock(Date.now() - current.startedAt);
  }
  function setConn(level, text) {
    $("connPill").className = "pill " + level;
    $("connText").textContent = text;
  }

  function resetLiveView() {
    turnEls.clear();
    $("transcript").innerHTML = "";
    $("suggestions").innerHTML = `<div class="empty small">Suggested replies will appear here during the conversation.</div>`;
    $("turnCount").textContent = "0";
    $("timer").textContent = "00:00";
    $("liveTitle").value = current ? current.title : "";
    renderInsights(current ? current.state : emptyState(), [], "", current?.id);
    if (!current) {
      $("transcript").innerHTML = `<div class="empty"><div class="empty-icon"></div>
        <p>Press <b>Start listening</b>, allow the microphone, then choose your meeting tab (or entire screen) and tick <b>“Share audio”</b>.</p></div>`;
    }
  }

  // =====================================================================
  // Live transcript & suggestions
  // =====================================================================
  const tbox = $("transcript");
  let autoScroll = true;
  tbox.addEventListener("scroll", () => {
    autoScroll = tbox.scrollHeight - tbox.scrollTop - tbox.clientHeight < 60;
    $("jumpBtn").hidden = autoScroll;
  });
  $("jumpBtn").onclick = () => { tbox.scrollTop = tbox.scrollHeight; };

  function initials(name) {
    if (name === "You") return "YOU";
    const m = String(name).match(/Speaker (\w+)/);
    return m ? m[1].slice(0, 2).toUpperCase() : String(name).slice(0, 2).toUpperCase();
  }
  const turnHTML = (speaker, text, me) =>
    `<div class="avatar">${esc(initials(speaker))}</div><div><div class="who">${esc(speaker)}</div><div class="txt">${esc(text)}</div></div>`;

  function renderTurn(m) {
    tbox.querySelector(".empty")?.remove();
    let el = turnEls.get(m.key);
    if (!el) {
      el = document.createElement("div");
      el.className = "turn";
      tbox.appendChild(el);
      turnEls.set(m.key, el);
    }
    el.classList.toggle("me", m.source === "mic");
    el.classList.toggle("partial", !m.final);
    el.innerHTML = turnHTML(m.speaker, m.text);
    if (m.final && !el.dataset.final) {
      el.dataset.final = "1";
      $("turnCount").textContent = String(current.turns.length + 1);
    }
    if (autoScroll) tbox.scrollTop = tbox.scrollHeight;
  }

  const KIND = { answer: "Possible answer", response: "Suggested response", objection: "Handle objection", clarify: "Clarify" };
  function suggestionEl(s, old = false, typing = false) {
    const el = document.createElement("div");
    el.className = "sugg" + (old ? " old" : "") + (typing ? " typing" : "");
    if (s.id) el.dataset.sid = s.id;
    el.innerHTML = `
      <div class="q">${KIND[s.kind] || KIND.response} · <b>${esc(s.speaker)}:</b> “${esc(s.trigger)}”</div>
      <div class="a">${esc(s.suggestion)}</div>
      <div class="meta"><span>${esc(s.why || "")}</span><button class="copy">Copy</button></div>`;
    el.querySelector(".copy").onclick = () =>
      navigator.clipboard.writeText(el.querySelector(".a").textContent).then(() => toast("Copied"));
    return el;
  }
  function renderLiveSuggestion(s, typing = false) {
    const box = $("suggestions");
    box.querySelector(".empty")?.remove();
    box.querySelectorAll(".sugg").forEach((x) => x.classList.add("old"));
    box.prepend(suggestionEl(s, false, typing));
    [...box.querySelectorAll(".sugg")].slice(6).forEach((x) => x.remove());
  }

  // =====================================================================
  // Insight cards (shared by live view and meeting page)
  // =====================================================================
  const tagOwner = (o) => (o ? `<span class="tag ${/^you$/i.test(o) ? "me" : ""}">${esc(o)}</span>` : "");
  const tagWhen = (w) => (w ? `<span class="tag">${esc(w)}</span>` : "");
  const evidenceHTML = (it) => {
    const q = it.evidence && it.evidence.quote;
    if (!q) return "";
    const c = typeof it.confidence === "number" ? Math.round(it.confidence * 100) : null;
    return `<div class="evidence" data-quote="${esc(q)}" title="Click to find this in the transcript">“${esc(q)}”<span>${esc(it.evidence.speaker || "")}${c !== null ? ` · ${c}% sure` : ""}</span></div>`;
  };
  const prioTag = (it) => (it.priority ? `<span class="tag prio prio-${esc(it.priority)}" title="${esc(it.priority_reason || "")}">${esc(it.priority)} priority</span>` : "");
  const dependsHTML = (it) => (it.depends_on ? `<div class="depends">Waits on: ${esc(it.depends_on)}</div>` : "");
  const RENDER = {
    action_items: (it, mid) => `
      <div class="item ${it.done ? "done" : ""}" data-id="${esc(it.id)}">
        <input type="checkbox" ${it.done ? "checked" : ""} data-toggle="${esc(it.id)}" data-meeting="${esc(mid)}" />
        <div class="body"><div class="main">${esc(it.task)}</div>
        <div class="sub">${tagOwner(it.owner)}${tagWhen(it.deadline)}${it.assigned_by ? `<span class="tag">from ${esc(it.assigned_by)}</span>` : ""}<span class="tag ${esc(it.status)}">${esc(it.status || "proposed")}</span>${prioTag(it)}</div>${dependsHTML(it)}${evidenceHTML(it)}</div>
        ${it.done || !mid ? "" : `<button class="btn agent-btn ${it.agent ? "ready" : ""}" data-agent="m:${esc(mid)}:${esc(it.id)}" title="Let Gather Agent handle this">${it.agent ? "Ready" : "Do it"}</button>`}
      </div>`,
    decisions: (it) => `
      <div class="item" data-id="${esc(it.id)}"><div class="icon"></div>
        <div class="body"><div class="main">${esc(it.decision)}</div>
        <div class="sub"><span class="tag ${esc(it.status)}">${esc(it.status || "proposed")}</span>${it.decided_by ? `<span class="tag">${esc(it.decided_by)}</span>` : ""}${it.context ? `<span>${esc(it.context)}</span>` : ""}</div>${evidenceHTML(it)}</div>
      </div>`,
    commitments: (it) => `
      <div class="item" data-id="${esc(it.id)}"><div class="icon"></div>
        <div class="body"><div class="main"><b>${esc(it.who || "Someone")}</b>${it.to_whom ? ` → ${esc(it.to_whom)}` : ""}: ${esc(it.commitment)}</div>
        <div class="sub">${tagWhen(it.when)}</div>${evidenceHTML(it)}</div>
      </div>`,
    follow_ups: (it) => `
      <div class="item" data-id="${esc(it.id)}"><div class="icon"></div>
        <div class="body"><div class="main">${esc(it.item)}</div>
        <div class="sub">${tagOwner(it.owner)}${it.reason ? `<span>${esc(it.reason)}</span>` : ""}</div>${evidenceHTML(it)}</div>
      </div>`,
    deadlines: (it) => `
      <div class="item" data-id="${esc(it.id)}"><div class="icon"></div>
        <div class="body"><div class="main">${esc(it.what)}</div>
        <div class="sub">${tagWhen(it.when)}${tagOwner(it.who)}</div>${evidenceHTML(it)}</div>
      </div>`,
    key_points: (it) => `
      <div class="item" data-id="${esc(it.id)}"><div class="icon"></div>
        <div class="body"><div class="main">${esc(it.point)}</div>${evidenceHTML(it)}</div>
      </div>`,
    concerns: (it) => `
      <div class="item" data-id="${esc(it.id)}"><div class="icon">${it.type === "objection" ? "" : it.type === "risk" ? "" : ""}</div>
        <div class="body"><div class="main">${esc(it.issue)}</div>
        <div class="sub"><span class="tag ${esc(it.type)}">${esc((it.type || "risk").replace("_", " "))}</span>${it.resolved ? `<span class="tag resolved">resolved</span>` : ""}</div>
        ${it.suggestion && !it.resolved ? `<div class="reply">${esc(it.suggestion)}</div>` : ""}${evidenceHTML(it)}</div>
      </div>`,
  };

  function sortedItems(state, cat) {
    const items = (state?.[cat] || []).slice().reverse(); // newest first
    if (cat === "action_items") items.sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0));
    if (cat === "concerns") items.sort((a, b) => (a.resolved ? 1 : 0) - (b.resolved ? 1 : 0));
    return items;
  }
  function renderInsights(state, changed, prefix, meetingId) {
    for (const cat of CATS) {
      const items = sortedItems(state, cat);
      $(prefix + cat).innerHTML = items.map((it) => RENDER[cat](it, meetingId)).join("");
      $(prefix + "cnt-" + cat).textContent = items.length;
    }
    changed.forEach((id) => document.querySelector(`#view-live .item[data-id="${id}"]`)?.classList.add("flash"));
  }

  // =====================================================================
  // Personal manager: one task list built from every meeting + own tasks
  // =====================================================================
  const Profile = {
    get() { return { name: Auth.current?.name || "" }; },
    set(p) { if (p.name) Auth.update({ name: p.name }); },
  };
  const Manual = {
    get KEY() { return K("tasks"); },
    all() { try { return JSON.parse(localStorage.getItem(this.KEY) || "[]"); } catch { return []; } },
    save(list) { localStorage.setItem(this.KEY, JSON.stringify(list)); },
  };

  const DAY = 86400000;
  const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const fromIso = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  const todayString = () => new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }) + ` (${isoDate(new Date())})`;

  // Fallback for items without a resolved date: "Friday", "tomorrow", "Dec 10th"... relative to the meeting date
  function parseDue(text, baseTs) {
    if (!text) return null;
    const t = String(text).toLowerCase();
    const base = startOfDay(new Date(baseTs || Date.now()));
    if (/\b(today|tonight|eod|end of (the )?day)\b/.test(t)) return base;
    if (/\btomorrow\b/.test(t)) return new Date(base.getTime() + DAY);
    if (/\bnext week\b/.test(t)) return new Date(base.getTime() + 7 * DAY);
    if (/end of (the )?month/.test(t)) return new Date(base.getFullYear(), base.getMonth() + 1, 0);
    const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    for (let i = 0; i < 7; i++) {
      if (t.includes(days[i])) return new Date(base.getTime() + (((i - base.getDay() + 7) % 7) || 7) * DAY);
    }
    const cleaned = t.replace(/(\d+)(st|nd|rd|th)\b/g, "$1").replace(/\b(by|on|before|due)\b/g, "").trim();
    if (!/[a-z]{3}/.test(cleaned) || !/\d/.test(cleaned)) return null;
    const d = new Date(/\d{4}/.test(cleaned) ? cleaned : cleaned + " " + base.getFullYear());
    if (isNaN(d)) return null;
    if (d.getTime() < base.getTime() - 60 * DAY) d.setFullYear(d.getFullYear() + 1);
    return startOfDay(d);
  }

  function dueLabel(d) {
    if (!d) return "";
    const diff = Math.round((startOfDay(d) - startOfDay()) / DAY);
    if (diff < 0) return `Overdue ${-diff}d`;
    if (diff === 0) return "Today";
    if (diff === 1) return "Tomorrow";
    if (diff < 7) return d.toLocaleDateString([], { weekday: "long" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  const dueClass = (d) => { if (!d) return ""; const diff = Math.round((startOfDay(d) - startOfDay()) / DAY); return diff < 0 ? "overdue" : diff === 0 ? "today" : diff < 7 ? "soon" : ""; };

  function isMineOwner(o) {
    if (!o) return null; // unassigned
    const name = (Profile.get().name || "").trim().toLowerCase().split(/\s+/)[0];
    return /^(you|me|myself|i)$/i.test(o.trim()) || (!!name && name.length > 1 && o.toLowerCase().includes(name));
  }

  function collectTasks() {
    const out = [];
    for (const m of Store.list()) {
      for (const it of m.state?.action_items || []) {
        const mine = isMineOwner(it.owner);
        out.push({
          ref: `m:${m.id}:${it.id}`, text: it.task, owner: it.owner,
          mine: mine !== false, unassigned: mine === null, waiting: mine === false,
          due: fromIso(it.due_date) || parseDue(it.deadline, m.startedAt),
          done: !!it.done, doneAt: it.doneAt || null, status: it.status,
          meetingId: m.id, meetingTitle: m.title, meetingDate: m.startedAt, assignedBy: it.assigned_by || null, agent: !!it.agent,
          priority: it.priority || null, priorityReason: it.priority_reason || null, dependsOn: it.depends_on || null,
          progress: it.progress || null, progressNote: it.progressNote || null, evidence: it.evidence || null,
        });
      }
    }
    for (const t of Manual.all()) {
      out.push({ ref: `t:${t.id}`, text: t.text, owner: null, mine: true, unassigned: false, waiting: false,
                 due: fromIso(t.due_date), done: !!t.done, doneAt: t.doneAt || null, manual: true, agent: !!t.agent });
    }
    return out;
  }

  function collectDeadlines(tasks) {
    const today = startOfDay();
    const items = [];
    for (const t of tasks) if (!t.done && t.due) items.push({ text: t.text, who: t.owner, due: t.due, meetingId: t.meetingId, meetingTitle: t.meetingTitle });
    for (const m of Store.list()) {
      for (const c of m.state?.commitments || []) {
        const due = fromIso(c.due_date) || parseDue(c.when, m.startedAt);
        if (!due || items.some((x) => x.meetingId === m.id && +x.due === +due)) continue;
        items.push({ text: c.commitment, who: c.who, due, meetingId: m.id, meetingTitle: m.title });
      }
      for (const dl of m.state?.deadlines || []) {
        const due = fromIso(dl.due_date) || parseDue(dl.when, m.startedAt);
        if (!due) continue;
        // skip if the same meeting already has a task due that day (avoid duplicates)
        if (items.some((x) => x.meetingId === m.id && +x.due === +due)) continue;
        items.push({ text: dl.what, who: dl.who, due, meetingId: m.id, meetingTitle: m.title });
      }
    }
    return items.filter((x) => x.due >= new Date(today.getTime() - 14 * DAY)).sort((a, b) => a.due - b.due);
  }

  function findTaskTarget(ref) {
    const [kind, a, b] = ref.split(":");
    if (kind === "t") {
      const list = Manual.all();
      const t = list.find((x) => x.id === a);
      return t ? { obj: t, save: () => Manual.save(list) } : null;
    }
    const mtg = current && current.id === a ? current : Store.get(a);
    const it = mtg && (mtg.state?.action_items || []).find((x) => x.id === b);
    return it ? { obj: it, save: () => Store.save(mtg), meetingId: a, itemId: b } : null;
  }
  function setTaskDone(ref, done) {
    const t = findTaskTarget(ref);
    if (!t) return;
    t.obj.done = done;
    t.obj.doneAt = done ? Date.now() : null;
    t.save();
    if (t.meetingId && listening && current && current.id === t.meetingId) send({ type: "toggle_done", id: t.itemId, done });
  }
  function setTaskDue(ref, iso) {
    const t = findTaskTarget(ref);
    if (!t) return;
    t.obj.due_date = iso || null;
    t.obj.dueUser = true; // user override: keep it even if the AI updates the item later
    t.save();
  }
  // keep user-only fields when the live session sends a fresh state
  function mergeLocal(prev, next) {
    const old = new Map((prev?.action_items || []).map((x) => [x.id, x]));
    for (const it of next?.action_items || []) {
      const o = old.get(it.id);
      if (!o) continue;
      if (o.doneAt) it.doneAt = o.doneAt;
      if (o.agent) it.agent = o.agent;
      if (o.dueUser) { it.due_date = o.due_date; it.dueUser = true; }
    }
    return next;
  }

  // tick / untick or re-date a task anywhere in the app
  document.addEventListener("change", (e) => {
    const d = e.target.dataset || {};
    let ref = d.ref;
    if (!ref && d.toggle && d.meeting) ref = `m:${d.meeting}:${d.toggle}`;
    if (!ref) return;
    if (d.due !== undefined) setTaskDue(ref, e.target.value);
    else {
      setTaskDone(ref, e.target.checked);
      e.target.closest(".item")?.classList.toggle("done", e.target.checked);
    }
    if (route.view === "home") renderHome();
  });

  function taskRow(t) {
    const ownerTag = t.waiting ? `<span class="tag">Owner · ${esc(t.owner)}</span>` : t.unassigned ? `<span class="tag">Unassigned</span>` : "";
    const src = t.manual ? `<span class="tag">Personal</span>`
      : `${t.dependsOn && !t.done ? `<span class="tag waits">Waits on ${esc(t.dependsOn)}</span>` : ""}<span class="origin"><a class="from" href="#/meeting/${esc(t.meetingId)}">${esc(t.meetingTitle)}</a> · ${esc(new Date(t.meetingDate).toLocaleDateString([], { month: "short", day: "numeric" }))}${t.assignedBy ? ` · Assigned by <b>${esc(t.assignedBy)}</b>` : ""}</span>`;
    return `
      <div class="item task ${t.done ? "done" : ""}">
        <input type="checkbox" ${t.done ? "checked" : ""} data-ref="${esc(t.ref)}" />
        <div class="body"><div class="main">${esc(t.text)}</div>
          <div class="sub">${t.due ? `<span class="tag due ${dueClass(t.due)}">${esc(dueLabel(t.due))}</span>` : ""}${t.priority && !t.done ? `<span class="tag prio prio-${esc(t.priority)}" title="${esc(t.priorityReason || "")}">${esc(t.priority)}</span>` : ""}${t.progress ? `<span class="tag progress">${esc(t.progress.replace("_", " "))}</span>` : ""}${ownerTag}${t.status === "proposed" ? `<span class="tag proposed">proposed</span>` : ""}${src}</div>
        </div>
        ${t.done ? "" : `<input type="date" class="due-input" title="Change due date" data-ref="${esc(t.ref)}" data-due="1" value="${t.due ? isoDate(t.due) : ""}" />`}
        ${t.done || !t.mine ? "" : `<button class="btn agent-btn ${t.agent ? "ready" : ""}" data-agent="${esc(t.ref)}" title="Let Gather Agent handle this">${t.agent ? "Ready" : "Do it"}</button>`}
      </div>`;
  }

  let taskFilter = "mine";
  document.querySelectorAll("#taskFilter .tab").forEach((b) => (b.onclick = () => {
    taskFilter = b.dataset.filter;
    document.querySelectorAll("#taskFilter .tab").forEach((x) => x.classList.toggle("active", x === b));
    renderHome();
  }));

  function renderHome() {
    const name = (Profile.get().name || "").trim();
    const hr = new Date().getHours();
    $("greeting").textContent = (hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening") + (name ? `, ${name.split(" ")[0]}` : "");
    $("liveBanner").hidden = !listening;
    const W = Settings.get().widgets;
    document.querySelectorAll("#view-home [data-widget]").forEach((el) => { if (el.id !== "dueBanner") el.hidden = !W[el.dataset.widget]; });
    $("mgrGrid").classList.toggle("single", !W.todo || !(W.deadlines || W.done || W.recent));

    const tasks = collectTasks();
    const today = startOfDay();
    const weekEnd = new Date(today.getTime() + 7 * DAY);
    const mine = tasks.filter((t) => t.mine);
    const openMine = mine.filter((t) => !t.done);
    const overdue = openMine.filter((t) => t.due && t.due < today);
    const dueToday = openMine.filter((t) => t.due && +startOfDay(t.due) === +today);
    const dueWeek = openMine.filter((t) => t.due && t.due >= today && t.due < weekEnd);
    const doneWeek = mine.filter((t) => t.done && t.doneAt && t.doneAt >= today.getTime() - 6 * DAY);
    const doneMine = mine.filter((t) => t.done).length;

    $("stOverdue").textContent = overdue.length;
    $("stToday").textContent = dueToday.length;
    $("stWeek").textContent = dueWeek.length;
    $("stOpen").textContent = openMine.length;
    $("stDoneWeek").textContent = doneWeek.length;
    const pct = mine.length ? Math.round((doneMine / mine.length) * 100) : 0;
    $("progressBar").style.width = pct + "%";
    $("progressText").textContent = mine.length ? `${pct}% of your tasks completed (${doneMine}/${mine.length})` : "No tasks yet — they'll appear here from your meetings.";

    const urgent = [...overdue, ...dueToday.filter((t) => !overdue.includes(t))];
    $("dueBanner").hidden = !urgent.length || !W.banner;
    if (urgent.length) {
      $("dueBanner").innerHTML = `<span>${overdue.length ? `<b>${overdue.length} overdue</b>` : ""}${overdue.length && dueToday.length ? " and " : ""}${dueToday.length ? `<b>${dueToday.length} due today</b>` : ""}: ${urgent.slice(0, 3).map((t) => esc(t.text)).join(" · ")}${urgent.length > 3 ? " …" : ""}</span>`;
    }
    $("heroLine").textContent = openMine.length
      ? `You have ${openMine.length} open task${openMine.length === 1 ? "" : "s"}${dueWeek.length ? `, ${dueWeek.length} due this week` : ""}.`
      : "You're all caught up. New commitments from your meetings will appear here.";

    // to-do list with filter + urgency groups
    const open = tasks.filter((t) => !t.done);
    const byFilter = { mine: open.filter((t) => t.mine), waiting: open.filter((t) => t.waiting), all: open };
    $("fMine").textContent = byFilter.mine.length;
    $("fWaiting").textContent = byFilter.waiting.length;
    $("fAll").textContent = byFilter.all.length;
    const list = byFilter[taskFilter];
    const groups = [
      ["Overdue", (t) => t.due && t.due < today],
      ["Today", (t) => t.due && +startOfDay(t.due) === +today],
      ["This week", (t) => t.due && t.due > today && t.due < weekEnd],
      ["Later", (t) => t.due && t.due >= weekEnd],
      ["No due date", (t) => !t.due],
    ];
    let html = "";
    for (const [label, f] of groups) {
      const PR = { high: 0, medium: 1, low: 2 };
      const g = list.filter(f).sort((a, b) => ((PR[a.priority] ?? 1) - (PR[b.priority] ?? 1)) || ((a.due || 0) - (b.due || 0)));
      if (g.length) html += `<div class="group-label">${label} <span>${g.length}</span></div><div class="list">${g.map(taskRow).join("")}</div>`;
    }
    $("todoList").innerHTML = html || `<div class="empty small">${taskFilter === "waiting" ? "Nobody owes you anything right now." : "Nothing to do. You're all caught up."}</div>`;

    // done
    const done = tasks.filter((t) => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    $("doneCount").textContent = done.length;
    $("doneList").innerHTML = done.slice(0, 12).map(taskRow).join("") || `<div class="empty small">Completed tasks will show up here.</div>`;

    // deadlines timeline
    const dls = collectDeadlines(tasks);
    $("dlCount").textContent = dls.length;
    $("deadlineList").innerHTML = dls.slice(0, 12).map((x) => `
      <div class="tl-item ${dueClass(x.due)}">
        <div class="tl-date"><b>${x.due.getDate()}</b><span>${x.due.toLocaleDateString([], { month: "short" })}</span></div>
        <div class="body"><div class="main">${esc(x.text)}</div>
          <div class="sub"><span class="tag due ${dueClass(x.due)}">${esc(dueLabel(x.due))}</span>${x.who ? `<span class="tag ${isMineOwner(x.who) ? "me" : ""}">${esc(x.who)}</span>` : ""}${x.meetingId ? `<a class="from" href="#/meeting/${esc(x.meetingId)}">${esc(x.meetingTitle)}</a>` : `<span class="tag">Personal</span>`}</div>
        </div>
      </div>`).join("") || `<div class="empty small">No upcoming deadlines.</div>`;

    // recent meetings
    $("recentMeetings").innerHTML = Store.list().slice(0, 4).map(meetingCard).join("") || `<div class="empty small">No meetings yet. Click <b>New meeting</b> to start.</div>`;
    updateRemindBtn();
  }

  // add personal task / reminder
  $("addTask").onsubmit = (e) => {
    e.preventDefault();
    const text = $("newTaskText").value.trim();
    if (!text) return;
    const list = Manual.all();
    list.push({ id: "t" + Date.now().toString(36), text, due_date: $("newTaskDate").value || null, done: false, created: Date.now() });
    Manual.save(list);
    $("newTaskText").value = "";
    $("newTaskDate").value = "";
    $("addTask").hidden = true;
    renderHome();
    toast("Task added");
  };
  $("addTaskToggle").onclick = () => { $("addTask").hidden = !$("addTask").hidden; if (!$("addTask").hidden) $("newTaskText").focus(); };
  $("addTaskCancel").onclick = () => { $("addTask").hidden = true; };

  // reminders (desktop notifications, at most once per task per day)
  function updateRemindBtn() {
    const b = $("remindBtn");
    if (!("Notification" in window)) { b.hidden = true; return; }
    const on = Notification.permission === "granted";
    b.textContent = on ? "Reminders on" : Notification.permission === "denied" ? "Reminders blocked" : "Enable reminders";
    b.disabled = on || Notification.permission === "denied";
  }
  $("remindBtn").onclick = async () => {
    const p = await Notification.requestPermission();
    updateRemindBtn();
    if (p === "granted") { toast("Reminders enabled — Gather will notify you about due and overdue tasks."); checkReminders(); }
  };
  function checkReminders() {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const today = startOfDay();
    const key = K("notified." + isoDate(today));
    let sent = [];
    try { sent = JSON.parse(localStorage.getItem(key) || "[]"); } catch {}
    const due = collectTasks().filter((t) => t.mine && !t.done && t.due && t.due <= today && !sent.includes(t.ref));
    if (!due.length) return;
    const body = due.length === 1 ? `${due[0].text} — ${dueLabel(due[0].due)}` : `${due.length} tasks need attention: ` + due.slice(0, 3).map((t) => t.text).join("; ");
    try { new Notification("Gather reminder", { body }); } catch {}
    localStorage.setItem(key, JSON.stringify([...sent, ...due.map((t) => t.ref)]));
  }
  setInterval(checkReminders, 10 * 60 * 1000);

  // =====================================================================
  // Gather Agent: reasons over the task + all meetings, produces deliverables
  // =====================================================================
  let agentRef = null;
  function agentContext() {
    return Store.list().slice(0, 12).map((m) => {
      const s = m.state || {};
      const pick = (arr, f) => (arr || []).slice(-12).map(f);
      return {
        meeting: m.title, date: new Date(m.startedAt).toDateString(), overview: (overview(m) || "").slice(0, 600),
        action_items: pick(s.action_items, (x) => `${x.task} | owner: ${x.owner || "?"} | from: ${x.assigned_by || "?"} | due: ${x.due_date || x.deadline || "-"}${x.done ? " | DONE" : ""}`),
        decisions: pick(s.decisions, (x) => `${x.decision} (${x.status})`),
        commitments: pick(s.commitments, (x) => `${x.who}${x.to_whom ? " -> " + x.to_whom : ""}: ${x.commitment} ${x.when || ""}`),
        follow_ups: pick(s.follow_ups, (x) => x.item),
        concerns: pick(s.concerns, (x) => `${x.issue}${x.resolved ? " (resolved)" : ""}`),
        key_points: pick(s.key_points, (x) => x.point),
      };
    });
  }
  async function runAgent(ref, force = false) {
    const t = findTaskTarget(ref);
    if (!t) return toast("Task not found", "warn");
    agentRef = ref;
    const it = t.obj;
    const [kind, mid] = ref.split(":");
    const mtg = kind === "m" ? ((current && current.id === mid) ? current : Store.get(mid)) : null;
    $("agentModal").hidden = false;
    $("agentTask").innerHTML = `<b>Task:</b> ${esc(it.task || it.text)}${mtg ? ` <span class="muted">· from ${esc(mtg.title)}${it.assigned_by ? `, assigned by ${esc(it.assigned_by)}` : ""}</span>` : ""}`;
    if (it.agent && !force) return renderAgent(it.agent);
    $("agentBody").innerHTML = `<div class="loading"><div class="spinner"></div>Gather Agent is thinking, planning and drafting…</div>`;
    try {
      const r = await fetch("/api/agent", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: { task: it.task || it.text, owner: it.owner || "You", assigned_by: it.assigned_by || null,
                  deadline: it.deadline || it.due_date || null, meeting: mtg ? mtg.title : "personal task" },
          context: agentContext(), user_name: Profile.get().name || "", today: todayString(),
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
      data.at = Date.now();
      const fresh = findTaskTarget(ref);
      if (fresh) { fresh.obj.agent = data; fresh.save(); }
      if (agentRef === ref) renderAgent(data);
      if (route.view === "home") renderHome();
      if (route.view === "meeting" && route.id) renderMeetingPage(route.id);
    } catch (e) {
      if (agentRef === ref) $("agentBody").innerHTML = `<div class="empty small">The agent couldn't finish: ${esc(e.message)}<br><br>Click ↻ Redo to try again.</div>`;
    }
  }
  function renderAgent(a) {
    const list = (arr) => (arr || []).map((x) => `<li>${esc(x)}</li>`).join("");
    const ICON = { email: "", document: "", message: "" };
    let html = "";
    if (a.thinking?.length) html += `<h2>Thinking</h2><ul class="agent-think">${list(a.thinking)}</ul>`;
    if (a.plan?.length) html += `<h2>Plan</h2><ol>${list(a.plan)}</ol>`;
    if (a.questions?.length) html += `<h2>Needs your input</h2><ul class="agent-q">${list(a.questions)}</ul>`;
    if (a.outputs?.length) {
      html += `<h2>Ready for your review</h2>`;
      a.outputs.forEach((o, i) => {
        html += `<div class="agent-out">
          <div class="agent-out-head"><b>${ICON[o.type] || ""} ${esc(o.title || o.type)}</b>${o.to ? `<span class="muted"> · to ${esc(o.to)}</span>` : ""}</div>
          ${o.subject ? `<div class="muted small">Subject: ${esc(o.subject)}</div>` : ""}
          <textarea class="followup-text agent-text" data-out="${i}">${esc(o.body || "")}</textarea>
          <div class="row">
            <button class="btn primary sm" data-copy-out="${i}">Copy</button>
            ${o.type === "email" ? `<button class="btn ghost sm" data-gmail-out="${i}">Open in Gmail ↗</button>` : ""}
            <button class="btn ghost sm" data-dl-out="${i}">Download</button>
          </div></div>`;
      });
    }
    if (a.proactive?.length) html += `<h2>Proactive</h2><ul>${list(a.proactive)}</ul>`;
    html += `<p class="muted small">Nothing has been sent. Review, edit and send it yourself.</p>`;
    $("agentBody").innerHTML = html;
    const body = $("agentBody");
    const outText = (i) => body.querySelector(`textarea[data-out="${i}"]`).value;
    body.querySelectorAll("[data-copy-out]").forEach((b) => (b.onclick = () => navigator.clipboard.writeText(outText(b.dataset.copyOut)).then(() => toast("Copied"))));
    body.querySelectorAll("[data-gmail-out]").forEach((b) => (b.onclick = () => {
      const o = a.outputs[b.dataset.gmailOut];
      // only pre-fill an address that really appears in the user's meeting data (never a guessed one)
      const m = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(o.to || "");
      const to = m && JSON.stringify(agentContext()).includes(m[0]) ? m[0] : "";
      const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(o.subject || o.title || "")}&body=${encodeURIComponent(outText(b.dataset.gmailOut))}`;
      window.open(url, "_blank", "noopener");
    }));
    body.querySelectorAll("[data-dl-out]").forEach((b) => (b.onclick = () => {
      const o = a.outputs[b.dataset.dlOut];
      const el = document.createElement("a");
      el.href = URL.createObjectURL(new Blob([(o.subject ? "Subject: " + o.subject + "\n\n" : "") + outText(b.dataset.dlOut)], { type: "text/plain" }));
      el.download = (o.title || "aether-draft").replace(/[^\w\- ]+/g, "").trim() + ".txt";
      el.click();
    }));
    // integration point for frontend/agent.js (real app actions via Composio)
    document.dispatchEvent(new CustomEvent("aether:agent-rendered", { detail: { data: a, ref: agentRef, body } }));
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-agent]");
    if (!b) return;
    e.preventDefault();
    runAgent(b.dataset.agent);
  });
  $("agentClose").onclick = () => { $("agentModal").hidden = true; agentRef = null; };
  $("agentRerun").onclick = () => agentRef && runAgent(agentRef, true);

  // =====================================================================
  // Meetings page (history)
  // =====================================================================
  function meetingCard(m) {
    const s = m.state || {};
    const snippet = overview(m) || (m.turns[0] ? `${m.turns[0].speaker}: ${m.turns[0].text}` : "No transcript");
    const live = listening && current && current.id === m.id;
    return `<a class="mcard" href="${live ? "#/live" : "#/meeting/" + m.id}">
      <div class="top"><span class="t">${live ? '<i class="live-dot"></i> ' : ""}${esc(m.title)}</span><span class="d">${esc(fmtDate(m.startedAt))}</span></div>
      <div class="snip">${esc(snippet)}</div>
      <div class="chips">
        <span class="tag">${esc(fmtDuration(m.duration || (live ? Date.now() - m.startedAt : 0)))}</span>
        <span class="tag">${(s.action_items || []).length} tasks</span>
        <span class="tag">${(s.decisions || []).length} decisions</span>
        <span class="tag">${m.turns.length} lines</span>
      </div></a>`;
  }
  function renderMeetings() {
    const list = Store.list();
    let totalMs = 0, decisions = 0;
    for (const m of list) { totalMs += m.duration || 0; decisions += (m.state?.decisions || []).length; }
    $("stMeetings").textContent = list.length;
    $("stHours").textContent = fmtDuration(totalMs);
    $("stDecisions").textContent = decisions;
    const q = $("search").value.trim().toLowerCase();
    const shown = !q ? list : list.filter((m) =>
      (m.title + " " + (m.summary || "") + " " + (m.liveSummary || "") + " " + m.turns.map((t) => t.text).join(" ")).toLowerCase().includes(q));
    $("meetingList").innerHTML = shown.length ? shown.map(meetingCard).join("")
      : `<div class="empty"><div class="empty-icon"></div><p>${q ? "No meetings match your search." : "No meetings yet. Click <b>New meeting</b> on the dashboard to start."}</p></div>`;
  }
  $("search").oninput = renderMeetings;

  function overview(m) {
    if (m.summary) {
      const lines = m.summary.split(/\r?\n/);
      const i = lines.findIndex((l) => /^##\s*overview/i.test(l));
      const para = (i >= 0 ? lines.slice(i + 1) : lines).find((l) => l.trim() && !l.startsWith("#"));
      if (para) return para.replace(/[*_`]/g, "");
    }
    return m.liveSummary || "";
  }

  // =====================================================================
  // Meeting page
  // =====================================================================
  function renderMeetingPage(id) {
    const m = (current && current.id === id) ? current : Store.get(id);
    if (!m) { toast("Meeting not found", "warn"); location.hash = "#/"; return; }
    $("mTitle").value = m.title;
    const speakers = [...new Set(m.turns.map((t) => t.speaker))];
    $("mMeta").innerHTML = `
      <span>${esc(fmtDate(m.startedAt))}</span>
      <span>${esc(fmtDuration(m.duration))}</span>
      <span>${speakers.length} speaker${speakers.length === 1 ? "" : "s"}: ${esc(speakers.join(", "))}</span>`;

    // summary
    const sb = $("mSummary");
    if (m.summary) sb.innerHTML = md(m.summary);
    else if (summaryPendingFor === id) sb.innerHTML = `<div class="loading"><div class="spinner"></div>Gather is writing the summary…</div>`;
    else sb.innerHTML = `<div class="empty small">${m.summaryError ? "Summary failed: " + esc(m.summaryError) + "<br><br>" : ""}
      <button class="btn primary sm" id="mGen">Generate summary</button></div>`;
    $("mGen")?.addEventListener("click", () => generateSummary(id));

    // transcript
    $("m-turns").textContent = m.turns.length;
    $("mTranscript").innerHTML = m.turns.length
      ? m.turns.map((t) => `<div class="turn ${t.source === "mic" ? "me" : ""}">${turnHTML(t.speaker, t.text)}</div>`).join("")
      : `<div class="empty small">No transcript.</div>`;

    renderInsights(m.state || emptyState(), [], "m-", m.id);

    renderFollowup(m);
    $("m-sugg-count").textContent = m.suggestions.length;
    const sbox = $("m-suggestions");
    sbox.innerHTML = m.suggestions.length ? "" : `<div class="empty small">No suggestions were needed.</div>`;
    m.suggestions.forEach((s) => sbox.appendChild(suggestionEl(s, true)));
  }

  function renderFollowup(m) {
    const box = $("mFollow");
    if (m.followup) {
      box.innerHTML = `<textarea class="followup-text" id="mFollowText" spellcheck="false"></textarea>
        <div class="row"><button class="btn primary sm" id="mFollowCopy">Copy message</button><span class="muted small">Edit freely; changes are saved.</span></div>`;
      $("mFollowText").value = m.followup;
      $("mFollowText").oninput = (e) => { m.followup = e.target.value; Store.save(m); };
      $("mFollowCopy").onclick = () => navigator.clipboard.writeText($("mFollowText").value).then(() => toast("Follow-up copied"));
      $("mFollowGen").textContent = "↻ Redraft";
    } else {
      box.innerHTML = `<div class="empty small">Draft a ready-to-send recap for the participants: decisions, who does what, and deadlines.</div>`;
      $("mFollowGen").textContent = "Draft";
    }
  }
  $("mFollowGen").onclick = async () => {
    const id = route.id;
    const m = (current && current.id === id) ? current : Store.get(id);
    if (!m) return;
    if (!m.turns.length) return toast("This meeting has no transcript.", "warn");
    $("mFollow").innerHTML = `<div class="loading"><div class="spinner"></div>Writing the follow-up…</div>`;
    try {
      const r = await fetch("/api/followup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: m.title, turns: m.turns, state: m.state, summary: m.summary || m.liveSummary, user_name: Profile.get().name || "" }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
      m.followup = data.text.trim();
      Store.save(m);
    } catch (e) {
      toast("Could not draft the follow-up: " + e.message, "error");
    }
    if (route.id === id) renderFollowup(m);
  };

  async function generateSummary(id) {
    const m = (current && current.id === id) ? current : Store.get(id);
    if (!m) return;
    $("mSummary").innerHTML = `<div class="loading"><div class="spinner"></div>Gather is writing the summary…</div>`;
    try {
      const r = await fetch("/api/summary", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turns: m.turns, state: m.state, summary: m.liveSummary }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
      setSummary(id, data.markdown, null);
    } catch (e) {
      setSummary(id, null, e.message);
    }
    if (route.id === id) renderMeetingPage(id);
  }

  $("mRegen").onclick = () => route.id && generateSummary(route.id);
  $("mTitle").onchange = (e) => {
    const m = (current && current.id === route.id) ? current : Store.get(route.id);
    if (!m) return;
    m.title = e.target.value.trim() || m.title;
    m.titleAuto = false;
    Store.save(m);
    toast("Title saved");
  };
  $("mDelete").onclick = () => {
    if (!route.id || !confirm("Delete this meeting permanently?")) return;
    Store.remove(route.id);
    if (current && current.id === route.id) current = null;
    location.hash = "#/";
  };
  $("mExport").onclick = () => {
    const m = Store.get(route.id);
    if (!m) return;
    const s = m.state || {};
    const sec = (title, arr, f) => arr?.length ? `\n## ${title}\n` + arr.map((x) => "- " + f(x)).join("\n") + "\n" : "";
    let out = `# ${m.title}\n\n${fmtDate(m.startedAt)} · ${fmtDuration(m.duration)}\n`;
    if (m.summary) out += "\n" + m.summary.replace(/^#\s+.*\n?/, "") + "\n";
    out += sec("Action Items", s.action_items, (x) => `[${x.done ? "x" : " "}] ${x.task}${x.owner ? " — " + x.owner : ""}${x.deadline ? " (" + x.deadline + ")" : ""}`);
    out += sec("Decisions", s.decisions, (x) => `${x.decision} [${x.status}]`);
    out += sec("Deadlines", s.deadlines, (x) => `${x.what} — ${x.when}${x.who ? " (" + x.who + ")" : ""}`);
    out += sec("Concerns", s.concerns, (x) => `${x.issue} [${x.type}${x.resolved ? ", resolved" : ""}]`);
    out += sec("Commitments", s.commitments, (x) => `${x.who || "Someone"}${x.to_whom ? " → " + x.to_whom : ""}: ${x.commitment}${x.when ? " (" + x.when + ")" : ""}`);
    out += sec("Follow-ups", s.follow_ups, (x) => `${x.item}${x.owner ? " — " + x.owner : ""}`);
    out += sec("Key Points", s.key_points, (x) => x.point);
    if (m.followup) out += "\n## Follow-up message\n\n" + m.followup + "\n";
    out += "\n## Transcript\n" + m.turns.map((t) => `**${t.speaker}:** ${t.text}`).join("\n\n") + "\n";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([out], { type: "text/markdown" }));
    a.download = (m.title.replace(/[^\w\- ]+/g, "").trim() || "meeting") + ".md";
    a.click();
  };

  // =====================================================================
  // Floating copilot (Document Picture-in-Picture): stays on top of the
  // meeting window (Meet tab, Zoom/Teams app) and mirrors the live meeting.
  // =====================================================================
  const Pip = {
    win: null,
    lastTurn: null,
    renderTimer: null,
    supported: () => "documentPictureInPicture" in window,

    async open(auto = false) {
      if (!this.supported()) return toast("Pop-out needs Chrome or Edge (version 116+).", "warn");
      if (this.win) { this.win.focus?.(); return; }
      try {
        const w = await documentPictureInPicture.requestWindow({ width: 380, height: 560 });
        this.win = w;
        const d = w.document;
        d.title = "Gather Copilot";
        for (const href of ["https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Cormorant+Garamond:wght@500;600&display=swap",
                            location.origin + "/static/styles.css", location.origin + "/static/theme.css"]) {
          const l = d.createElement("link"); l.rel = "stylesheet"; l.href = href; d.head.appendChild(l);
        }
        d.body.className = "pip";
        d.body.innerHTML = `
          <div class="pip-head">
            <div class="pip-brand"><svg class="mark sm" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="13.5"/><path d="M22.5 11.2A8 8 0 1 0 24 16h-7.5"/></svg><b>Gather</b></div>
            <span class="pip-status" id="pStatus">Idle</span>
            <span class="timer" id="pTimer">00:00</span>
            <button class="btn danger sm" id="pStop">■ Stop</button>
          </div>
          <div class="pip-now" id="pNow"><span class="muted">Waiting for conversation…</span></div>
          <div class="pip-label">Suggestion</div>
          <div id="pSugg" class="pip-sugg"><div class="muted small">Replies appear here when someone asks you something.</div></div>
          <div class="pip-label">Latest insights</div>
          <div id="pFeed" class="pip-feed"></div>`;
        d.getElementById("pStop").onclick = () => finishMeeting(true);
        w.addEventListener("pagehide", () => { this.win = null; $("pipBtn").classList.remove("active"); });
        $("pipBtn").classList.add("active");
        this.renderAll();
      } catch (e) {
        console.error(e);
        if (auto) toast("Click “⧉ Pop out” to float Gather over your meeting.", "info");
        else toast("Could not open the floating window: " + e.message, "error");
      }
    },
    close() { if (this.win) { this.win.close(); this.win = null; } },
    el(id) { return this.win ? this.win.document.getElementById(id) : null; },

    renderAll() {
      if (!this.win) return;
      this.status();
      this.renderSuggestion();
      this.renderFeed();
      this.renderNow();
    },
    status() {
      if (!this.win) return;
      const s = this.el("pStatus");
      s.textContent = listening ? "● Listening" : "Idle";
      s.classList.toggle("on", listening);
      this.el("pStop").disabled = !listening;
      this.el("pTimer").textContent = current && listening ? fmtClock(Date.now() - current.startedAt) : "00:00";
    },
    turn(m) {
      this.lastTurn = m;
      this.renderNow();
    },
    renderNow() {
      const box = this.el("pNow");
      if (!box || !this.lastTurn) return;
      const m = this.lastTurn;
      box.innerHTML = `<b class="${m.source === "mic" ? "me" : ""}">${esc(m.speaker)}:</b> <span class="${m.final ? "" : "partial"}">${esc(m.text)}</span>`;
    },
    renderSuggestion() {
      const box = this.el("pSugg");
      if (!box) return;
      let s = [...streaming.values()].pop();
      let typing = !!s;
      if (!s && current?.suggestions?.length) s = current.suggestions[0];
      if (!s) return;
      box.innerHTML = `
        <div class="sugg ${typing ? "typing" : ""}">
          <div class="q">${KIND[s.kind] || KIND.response} · <b>${esc(s.speaker)}:</b> “${esc(s.trigger)}”</div>
          <div class="a">${esc(s.suggestion)}</div>
        </div>`;
    },
    renderFeed() {
      const box = this.el("pFeed");
      if (!box) return;
      const ICON = { action_items: "", decisions: "", deadlines: "", concerns: "", key_points: "", commitments: "", follow_ups: "" };
      const TEXT = { action_items: (x) => x.task + (x.owner ? ` — ${x.owner}` : "") + (x.deadline ? ` (${x.deadline})` : ""),
                     decisions: (x) => x.decision, deadlines: (x) => `${x.what} — ${x.when}`,
                     concerns: (x) => x.issue, key_points: (x) => x.point,
                     commitments: (x) => `${x.who || "Someone"}: ${x.commitment}`, follow_ups: (x) => x.item };
      const all = [];
      for (const cat of CATS) for (const it of current?.state?.[cat] || []) all.push({ cat, it });
      all.sort((a, b) => (b.it.updated || 0) - (a.it.updated || 0));
      box.innerHTML = all.length ? all.slice(0, 7).map(({ cat, it }) =>
        `<div class="pip-item ${it.done ? "done" : ""}"><span>${ICON[cat]}</span><div>${esc(TEXT[cat](it))}</div></div>`).join("")
        : `<div class="muted small">Action items, decisions and deadlines will appear here.</div>`;
    },
    // throttle so streaming deltas don't re-render too often
    soon(fn) { if (!this.win) return; clearTimeout(this.renderTimer); this.renderTimer = setTimeout(() => fn.call(this), 40); },
  };
  $("pipBtn").onclick = () => Pip.open();
  setInterval(() => Pip.status(), 1000);

  // =====================================================================
  // Accounts (demo login: stored in this browser, passwords SHA-256 hashed)
  // Every user's meetings, tasks and settings live under their own key prefix.
  // =====================================================================
  const Auth = {
    current: null,
    users() { try { return JSON.parse(localStorage.getItem("aether.users") || "[]"); } catch { return []; } },
    saveUsers(list) { localStorage.setItem("aether.users", JSON.stringify(list)); },
    async hash(email, pw) {
      const data = new TextEncoder().encode("aether|" + email.trim().toLowerCase() + "|" + pw);
      if (window.crypto?.subtle) {
        const buf = await crypto.subtle.digest("SHA-256", data);
        return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
      }
      let h = 0; for (const b of data) h = (h * 31 + b) | 0; return "x" + h; // non-secure context fallback
    },
    async signup(name, email, pw) {
      email = email.trim().toLowerCase();
      const users = this.users();
      if (users.some((u) => u.email === email)) throw new Error("An account with this email already exists. Sign in instead.");
      const user = { id: "u" + Date.now().toString(36), name: name.trim(), email, hash: await this.hash(email, pw), created: Date.now() };
      if (window.AETHER_DEMO && email === window.AETHER_DEMO.email) throw new Error("That email is reserved for the demo account. Use Sign in.");
      const first = users.filter((u) => !u.demo).length === 0;
      users.push(user);
      this.saveUsers(users);
      if (first) migrateLegacy(user.id); // meetings recorded before accounts existed go to the first account
      this.login(user);
    },
    async signin(email, pw) {
      email = email.trim().toLowerCase();
      const D = window.AETHER_DEMO;
      if (D && (email === D.email || email === "demo@aether.app")) {
        if (pw !== D.password) throw new Error("Incorrect password for the demo account.");
        return this.loginDemo();
      }
      const user = this.users().find((u) => u.email === email);
      if (!user) throw new Error("No account found for this email. Create one first.");
      if (user.hash !== (await this.hash(email, pw))) throw new Error("Incorrect password.");
      this.login(user);
    },
    loginDemo() {
      const D = window.AETHER_DEMO;
      const users = this.users();
      let u = users.find((x) => x.demo) || users.find((x) => x.email === D.email);
      if (!u) {
        u = { id: "udemo", name: D.name, email: D.email, hash: "demo", demo: true, created: Date.now() };
        users.push(u);
        this.saveUsers(users);
      }
      if (u.email !== D.email) { u.email = D.email; this.saveUsers(users); }
      seedDemo(u.id);
      this.login(u);
    },
    login(user) {
      this.current = user;
      localStorage.setItem("aether.session", user.id);
      onLogin();
    },
    restore() {
      const id = localStorage.getItem("aether.session");
      this.current = this.users().find((u) => u.id === id) || null;
    },
    update(patch) {
      const users = this.users();
      const u = users.find((x) => x.id === this.current?.id);
      if (!u) return;
      Object.assign(u, patch);
      this.saveUsers(users);
      this.current = u;
    },
    logout() {
      if (listening) finishMeeting(true);
      this.current = null;
      localStorage.removeItem("aether.session");
      current = null;
      onLogout();
    },
  };
  const K = (key) => `aether.u.${Auth.current ? Auth.current.id : "anon"}.${key}`;

  // wipe and rebuild the demo account so every demo starts fresh, with dates relative to today
  function seedDemo(uid) {
    const pre = `aether.u.${uid}.`;
    Object.keys(localStorage).filter((k) => k.startsWith(pre)).forEach((k) => localStorage.removeItem(k));
    const { meetings, tasks } = window.AETHER_DEMO.build(Date.now());
    for (const m of meetings) localStorage.setItem(pre + "m." + m.id, JSON.stringify(m));
    localStorage.setItem(pre + "index", JSON.stringify(meetings.map((m) => m.id)));
    localStorage.setItem(pre + "tasks", JSON.stringify(tasks));
  }

  function migrateLegacy(uid) {
    const pre = `aether.u.${uid}.`;
    const move = (from, to) => { const v = localStorage.getItem(from); if (v !== null) { localStorage.setItem(to, v); localStorage.removeItem(from); } };
    let ids = [];
    try { ids = JSON.parse(localStorage.getItem("aether.index") || "[]"); } catch {}
    for (const id of ids) move("aether.m." + id, pre + "m." + id);
    move("aether.index", pre + "index");
    move("aether.tasks", pre + "tasks");
    localStorage.removeItem("aether.profile");
  }

  // ---------- settings ----------
  const WIDGETS = {
    banner: "Due & overdue warning banner",
    stats: "Task counters",
    progress: "Progress bar",
    todo: "To-do list",
    deadlines: "Upcoming deadlines",
    done: "Completed tasks",
    recent: "Recent meetings",
  };
  const Settings = {
    defaults: { widgets: Object.fromEntries(Object.keys(WIDGETS).map((k) => [k, true])), filter: "mine", capture: true, pip: true },
    get() {
      let s = {};
      try { s = JSON.parse(localStorage.getItem(K("settings")) || "{}"); } catch {}
      return { ...this.defaults, ...s, widgets: { ...this.defaults.widgets, ...(s.widgets || {}) } };
    },
    set(patch) { localStorage.setItem(K("settings"), JSON.stringify({ ...this.get(), ...patch })); },
  };

  function userInitials(name) {
    const parts = String(name || "?").trim().split(/\s+/);
    return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  }
  function renderAccountUI() {
    const u = Auth.current;
    document.body.classList.toggle("logged-out", !u);
    if (!u) return;
    $("avatarBtn").textContent = userInitials(u.name);
    $("menuName").textContent = u.name;
    $("menuEmail").textContent = u.email;
  }
  function onLogin() {
    taskFilter = Settings.get().filter;
    document.querySelectorAll("#taskFilter .tab").forEach((x) => x.classList.toggle("active", x.dataset.filter === taskFilter));
    renderAccountUI();
    resetLiveView();
    location.hash = "#/";
    onRoute();
  }
  function onLogout() {
    renderAccountUI();
    resetLiveView();
    $("userMenu").hidden = true;
    location.hash = "#/login";
    onRoute();
  }

  // ---------- login screen ----------
  let authMode = "signin";
  document.querySelectorAll("#authSeg .seg-btn").forEach((b) => (b.onclick = () => {
    authMode = b.dataset.mode;
    document.querySelectorAll("#authSeg .seg-btn").forEach((x) => x.classList.toggle("active", x === b));
    $("nameRow").hidden = authMode !== "signup";
    $("authName").required = authMode === "signup";
    $("authSubmit").textContent = authMode === "signup" ? "Create account" : "Sign in";
    $("authPass").autocomplete = authMode === "signup" ? "new-password" : "current-password";
    $("authError").hidden = true;
  }));
  $("authForm").onsubmit = async (e) => {
    e.preventDefault();
    $("authError").hidden = true;
    $("authSubmit").disabled = true;
    try {
      if (authMode === "signup") await Auth.signup($("authName").value, $("authEmail").value, $("authPass").value);
      else await Auth.signin($("authEmail").value, $("authPass").value);
      $("authPass").value = "";
    } catch (err) {
      $("authError").textContent = err.message;
      $("authError").hidden = false;
    } finally {
      $("authSubmit").disabled = false;
    }
  };

  $("fillDemo").onclick = () => {
    const D = window.AETHER_DEMO;
    if (!D) return;
    if (authMode !== "signin") document.querySelector('#authSeg .seg-btn[data-mode="signin"]').click();
    $("authEmail").value = D.email;
    $("authPass").value = D.password;
  };

  // ---------- profile menu ----------
  $("avatarBtn").onclick = (e) => { e.stopPropagation(); $("userMenu").hidden = !$("userMenu").hidden; };
  document.addEventListener("click", (e) => { if (!e.target.closest(".user-menu")) $("userMenu").hidden = true; });
  $("menuSettings").onclick = () => ($("userMenu").hidden = true);
  $("logoutBtn").onclick = () => Auth.logout();
  $("logoutBtn2").onclick = () => Auth.logout();

  // ---------- settings page ----------
  function renderSettings() {
    const u = Auth.current, st = Settings.get();
    $("setName").value = u.name;
    $("setEmail").value = u.email;
    $("widgetToggles").innerHTML = Object.entries(WIDGETS).map(([k, label]) =>
      `<label class="toggle"><input type="checkbox" data-widget-toggle="${k}" ${st.widgets[k] ? "checked" : ""} /><span>${esc(label)}</span></label>`).join("");
    $("setFilter").value = st.filter;
    $("setCapture").checked = st.capture;
    $("setPip").checked = st.pip;
    updateRemindBtn();
  }
  $("widgetToggles").addEventListener("change", (e) => {
    const k = e.target.dataset.widgetToggle;
    if (!k) return;
    const st = Settings.get();
    st.widgets[k] = e.target.checked;
    Settings.set({ widgets: st.widgets });
    toast("Dashboard updated");
  });
  $("setFilter").onchange = (e) => { Settings.set({ filter: e.target.value }); taskFilter = e.target.value;
    document.querySelectorAll("#taskFilter .tab").forEach((x) => x.classList.toggle("active", x.dataset.filter === taskFilter)); toast("Saved"); };
  $("setCapture").onchange = (e) => { Settings.set({ capture: e.target.checked }); toast("Saved"); };
  $("setPip").onchange = (e) => { Settings.set({ pip: e.target.checked }); toast("Saved"); };
  $("saveProfile").onclick = () => {
    const name = $("setName").value.trim();
    if (!name) return toast("Name can't be empty", "warn");
    Auth.update({ name });
    renderAccountUI();
    toast("Profile saved");
  };

  // =====================================================================
  // Router
  // =====================================================================
  const route = { view: "home", id: null };
  function onRoute() {
    const h = location.hash || "#/";
    const mm = h.match(/^#\/meeting\/(.+)$/);
    route.view = mm ? "meeting" : h === "#/live" ? "live" : h === "#/meetings" ? "meetings" : h === "#/settings" ? "settings" : h === "#/team" ? "team" : "home";
    if (!Auth.current) route.view = "login";
    else if (h === "#/login") { location.hash = "#/"; return; }
    route.id = mm ? decodeURIComponent(mm[1]) : null;
    if (route.view === "meeting" && listening && current && current.id === route.id) { location.hash = "#/live"; return; }
    for (const v of ["login", "home", "meetings", "settings", "live", "meeting", "team"]) { const el = $("view-" + v); if (el) el.hidden = v !== route.view; }
    if (route.view === "login") return;
    document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === route.view));
    if (route.view === "home") { renderHome(); checkReminders(); }
    if (route.view === "meetings") renderMeetings();
    if (route.view === "settings") renderSettings();
    if (route.view === "meeting") renderMeetingPage(route.id);
    document.dispatchEvent(new CustomEvent("aether:route", { detail: { view: route.view, id: route.id } }));
    if (route.view === "live" && !listening && !$("transcript").children.length) resetLiveView();
  }
  window.addEventListener("hashchange", onRoute);

  document.querySelectorAll("#view-live .tab").forEach((b) => (b.onclick = () => {
    document.querySelectorAll("#view-live .tab").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll("#view-live .tabbody").forEach((x) => (x.hidden = x.id !== b.dataset.tab));
  }));

  window.addEventListener("beforeunload", (e) => {
    if (current) Store.save(current);
    if (listening) { e.preventDefault(); e.returnValue = ""; }
  });

  // =====================================================================
  // Helpers
  // =====================================================================
  function fmtClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0"), ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }
  function fmtDuration(ms) {
    const min = Math.round((ms || 0) / 60000);
    if (min < 1) return ms > 0 ? "<1m" : "0m";
    return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
  }
  const fmtDate = (t) => new Date(t).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  function toast(msg, level = "info") {
    const box = $("toasts");
    if ([...box.children].some((t) => t.textContent === msg)) return;
    const el = document.createElement("div");
    el.className = "toast " + level;
    el.textContent = msg;
    box.appendChild(el);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => el.remove(), level === "error" ? 8000 : 4500);
  }

  function md(src) {
    const lines = String(src || "").split(/\r?\n/);
    let html = "", inList = false;
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\*(.+?)\*/g, "<i>$1</i>").replace(/`(.+?)`/g, "<code>$1</code>");
    for (const line of lines) {
      const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
      if (li) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
      if (inList) { html += "</ul>"; inList = false; }
      const h = line.match(/^(#{1,4})\s+(.*)/);
      if (h) html += h[1].length === 1 ? `<h1>${inline(h[2])}</h1>` : `<h2>${inline(h[2])}</h2>`;
      else if (line.trim()) html += `<p>${inline(line)}</p>`;
    }
    if (inList) html += "</ul>";
    return html;
  }

  // =====================================================================
  if (!Pip.supported()) { $("optPipRow").hidden = true; $("optPip").checked = false; $("pipBtn").hidden = true; $("setPipRow").hidden = true; }
  Auth.restore();
  renderAccountUI();
  if (Auth.current) {
    taskFilter = Settings.get().filter;
    document.querySelectorAll("#taskFilter .tab").forEach((x) => x.classList.toggle("active", x.dataset.filter === taskFilter));
  }
  // ---------------------------------------------------------------------
  // Public integration API for frontend/agent.js (keep this block stable)
  // ---------------------------------------------------------------------
  window.AETHER = {
    get user() { return Auth.current; },
    get route() { return { ...route }; },
    Store, Manual, Profile, findTaskTarget, agentContext, todayString, toast, esc,
    collectTasks, setTaskDone, setTaskDue, dueLabel, dueClass, isoDate, fromIso, startOfDay, isMineOwner, fmtDate, fmtDuration,
    rerender() {
      if (route.view === "home") renderHome();
      if (route.view === "meeting" && route.id) renderMeetingPage(route.id);
    },
  };

  connect();
  onRoute();
})();
