// Gather: user-started meeting screen recording (self-contained; public window.AETHER API + events only).
// - Records ONLY the tab/window/screen the user chose in the browser's share dialog, plus the mic and the
//   shared audio when the browser actually provides it. Nothing is captured in the background.
// - Video + snapshots are stored in IndexedDB (localStorage cannot hold video); meeting data stays in localStorage.
// - Timestamps (seconds + mm:ss) on transcript lines and tasks; click to jump in the recording.
// - Screen details are entered/confirmed by the user per snapshot (no silent inference).
(() => {
  const A = window.AETHER;
  if (!A) return;
  const $ = (id) => document.getElementById(id);
  const esc = A.esc;
  const SUPPORTED = !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && window.indexedDB);
  const SNAP_EVERY_MS = 30000, SNAP_WIDTH = 480, MAX_SNAPS = 60;

  // ---------------------------------------------------------------- IndexedDB
  const DB_NAME = "gather-recordings", STORE = "recordings";
  function db() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idb(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => res(req && req.result);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error("Storage transaction aborted"));
    });
  }
  const recKey = (meetingId) => `${A.user ? A.user.id : "anon"}:${meetingId}`;
  const getRec = (id) => idb("readonly", (s) => s.get(recKey(id))).catch(() => null);
  const putRec = (rec) => idb("readwrite", (s) => s.put(rec));
  const delRec = (id) => idb("readwrite", (s) => s.delete(recKey(id))).catch(() => {});

  // ---------------------------------------------------------------- recording metadata (separate key, never overwritten by app.js)
  const metaKey = () => `aether.u.${A.user ? A.user.id : "anon"}.recmeta`;
  const allMeta = () => { try { return JSON.parse(localStorage.getItem(metaKey()) || "{}"); } catch { return {}; } };
  const recMeta = (id) => allMeta()[id] || null;
  function setRecMeta(id, patch) {
    const all = allMeta();
    if (patch === null) delete all[id]; else all[id] = { ...(all[id] || {}), ...patch };
    try { localStorage.setItem(metaKey(), JSON.stringify(all)); } catch {}
  }

  // ---------------------------------------------------------------- time helpers
  const mmss = (sec) => { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : String(m).padStart(2, "0")) + ":" + String(s).padStart(2, "0"); };
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  // seconds from the recording start (or meeting start if no recording) for a transcript turn
  function turnSec(m, turn) { const meta = recMeta(m.id); const base = (meta && meta.start) || m.startedAt; return turn && turn.t ? Math.max(0, (turn.t - base) / 1000) : null; }
  function secForQuote(m, quote) {
    if (!m || !quote || !m.turns) return null;
    const w = norm(quote).split(" ").slice(0, 6).join(" ");
    if (!w) return null;
    const t = m.turns.find((x) => norm(x.text).includes(w)) || m.turns.find((x) => norm(x.text).includes(w.split(" ").slice(0, 3).join(" ")));
    return t ? turnSec(m, t) : null;
  }
  // public helper for other modules (task manager etc.)
  window.GatherRec = {
    timeFor(meetingId, quote) { const m = A.Store.get(meetingId); const s = secForQuote(m, quote); return s === null ? null : { sec: Math.round(s), label: mmss(s), hasVideo: !!(recMeta(meetingId) && !recMeta(meetingId).notStored && recMeta(meetingId).stored) }; },
    jump(meetingId, sec) { sessionStorage.setItem("gather.seek", JSON.stringify({ id: meetingId, sec })); if (location.hash !== "#/meeting/" + meetingId) location.hash = "#/meeting/" + meetingId; else seekNow(); },
    mmss,
  };

  // ---------------------------------------------------------------- recorder
  let rec = null; // { meetingId, recorder, chunks, start, timer, snapTimer, video, canvas, snaps, audio, ctx, hasVideo, mime }
  function pickMime() {
    for (const m of ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4", "audio/webm;codecs=opus", "audio/webm"])
      if (MediaRecorder.isTypeSupported(m)) return m;
    return "";
  }
  function startRecording({ meetingId, streams }) {
    if (!SUPPORTED) { A.toast("Recording isn't supported in this browser. Use Chrome or Edge.", "warn"); return; }
    const display = streams.find((s) => s.getVideoTracks().length);
    const mic = streams.find((s) => !s.getVideoTracks().length && s.getAudioTracks().length);
    if (!display && !mic) { A.toast("Nothing to record: no screen or microphone was shared.", "warn"); return; }
    // mix mic + shared audio into one track (only what the browser actually gave us)
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const audioParts = [];
    if (mic) { ctx.createMediaStreamSource(new MediaStream(mic.getAudioTracks())).connect(dest); audioParts.push("your microphone"); }
    if (display && display.getAudioTracks().length) { ctx.createMediaStreamSource(new MediaStream(display.getAudioTracks())).connect(dest); audioParts.push("shared audio"); }
    const tracks = [...(display ? display.getVideoTracks() : []), ...(audioParts.length ? dest.stream.getAudioTracks() : [])];
    const mime = pickMime();
    let recorder;
    try { recorder = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime, videoBitsPerSecond: 1_200_000, audioBitsPerSecond: 96_000 } : undefined); }
    catch (e) { ctx.close(); A.toast("Couldn't start recording: " + e.message, "error"); return; }
    rec = { meetingId, recorder, chunks: [], start: Date.now(), ctx, hasVideo: !!display, mime: recorder.mimeType || mime, snaps: [],
            audio: audioParts.length ? audioParts.join(" + ") : "none" };
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec && rec.chunks.push(e.data); };
    recorder.onstop = () => finalize();
    recorder.start(1000);
    // live preview + snapshots from the shared surface
    if (display) {
      const v = document.createElement("video");
      v.muted = true; v.playsInline = true; v.srcObject = new MediaStream(display.getVideoTracks()); v.play().catch(() => {});
      rec.video = v;
      rec.snapTimer = setInterval(snap, SNAP_EVERY_MS);
      setTimeout(snap, 3000);
      display.getVideoTracks()[0].addEventListener("ended", () => { if (rec && rec.meetingId === meetingId) { A.toast("Screen sharing ended, so the recording was stopped and saved."); stopRecording(); } });
    }
    const m = A.Store.get(meetingId);
    setRecMeta(meetingId, { start: rec.start, recording: true });
    showIndicator();
    if (!display) A.toast("Recording audio only (no screen was shared).", "warn");
    else if (!display.getAudioTracks().length) A.toast("Recording the screen without shared audio (the browser didn't provide it). Your mic is included.", "warn");
  }
  function snap() {
    if (!rec || !rec.video || rec.snaps.length >= MAX_SNAPS || !rec.video.videoWidth) return;
    const c = rec.canvas || (rec.canvas = document.createElement("canvas"));
    const w = SNAP_WIDTH, h = Math.round((rec.video.videoHeight / rec.video.videoWidth) * w);
    c.width = w; c.height = h;
    c.getContext("2d").drawImage(rec.video, 0, 0, w, h);
    rec.snaps.push({ sec: Math.round((Date.now() - rec.start) / 1000), img: c.toDataURL("image/jpeg", 0.6), details: "" });
  }
  function stopRecording() {
    if (!rec || rec.stopping) return;
    rec.stopping = true;
    snap();
    clearInterval(rec.snapTimer); clearInterval(rec.timer);
    try { if (rec.recorder.state !== "inactive") rec.recorder.stop(); else finalize(); } catch { finalize(); }
  }
  async function finalize() {
    const r = rec; rec = null;
    hideIndicator();
    if (!r) return;
    try { r.ctx.close(); } catch {}
    if (r.video) { r.video.srcObject = null; }
    const blob = new Blob(r.chunks, { type: (r.mime || "video/webm").split(";")[0] });
    const duration = Math.round((Date.now() - r.start) / 1000);
    // wait briefly: the meeting is saved/removed by app.js right after stopping
    await new Promise((res) => setTimeout(res, 400));
    const m = A.Store.get(r.meetingId);
    if (!m) return; // meeting had no speech and was discarded
    const record = { id: recKey(r.meetingId), blob, mime: blob.type, size: blob.size, duration, start: r.start, snaps: r.snaps, audio: r.audio, hasVideo: r.hasVideo };
    try {
      await putRec(record);
      setRecMeta(r.meetingId, { start: r.start, stored: true, size: blob.size, duration, audio: r.audio, hasVideo: r.hasVideo, snaps: r.snaps.length, savedAt: Date.now() });
      A.toast(`Recording saved (${(blob.size / 1048576).toFixed(1)} MB, ${mmss(duration)}).`);
    } catch (e) {
      // storage full / unavailable: keep the meeting, offer the file right away
      setRecMeta(r.meetingId, { start: r.start, notStored: true, size: blob.size, duration, audio: r.audio, hasVideo: r.hasVideo, savedAt: Date.now() });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `${(m.title || "meeting").replace(/[^\w\- ]+/g, "")}.webm`;
      document.body.appendChild(a); a.click(); a.remove();
      A.toast("Browser storage is full, so the recording couldn't be kept here. It was downloaded instead; the transcript and tasks are saved.", "error");
    }
    if (A.route.view === "meeting" && A.route.id === r.meetingId) decorateMeeting();
  }

  // ---------------------------------------------------------------- live indicator + preview
  function showIndicator() {
    let el = $("recBar");
    if (!el) {
      el = document.createElement("div"); el.id = "recBar"; el.className = "rec-bar";
      el.innerHTML = `<video id="recPreview" muted playsinline></video><div class="rec-info"><b><i class="live-dot"></i> REC <span id="recTime">00:00</span></b>
        <span id="recWhat"></span></div><button class="btn danger sm" id="recStop">Stop recording</button>`;
      document.body.appendChild(el);
      $("recStop").onclick = () => stopRecording();
    }
    el.hidden = false;
    const pv = $("recPreview");
    if (rec.video) { pv.srcObject = rec.video.srcObject; pv.play().catch(() => {}); pv.hidden = false; } else pv.hidden = true;
    $("recWhat").textContent = `${rec.hasVideo ? "Shared screen" : "No screen"} · audio: ${rec.audio}`;
    rec.timer = setInterval(() => { if (rec) $("recTime").textContent = mmss((Date.now() - rec.start) / 1000); }, 500);
  }
  function hideIndicator() { const el = $("recBar"); if (el) { el.hidden = true; const pv = $("recPreview"); if (pv) pv.srcObject = null; } }

  document.addEventListener("aether:capture-started", (e) => { if (e.detail.record) startRecording(e.detail); });
  document.addEventListener("aether:capture-stopping", () => stopRecording());

  // ---------------------------------------------------------------- meeting page: player, timestamps, snapshots
  let playerURL = null;
  function seekNow() {
    const s = JSON.parse(sessionStorage.getItem("gather.seek") || "null");
    const v = $("recPlayer");
    if (!s || !v || A.route.id !== s.id) return;
    sessionStorage.removeItem("gather.seek");
    const go = () => { v.currentTime = Math.max(0, s.sec - 1); v.play().catch(() => {}); v.scrollIntoView({ behavior: "smooth", block: "center" }); };
    v.dataset.ready === "1" ? go() : v.addEventListener("gather-ready", go, { once: true });
  }
  let decorating = null;
  async function decorateMeeting() {
    if (decorating) { decorating.again = true; return; }
    decorating = { again: false };
    try { await decorateMeetingNow(); } finally {
      const again = decorating.again; decorating = null;
      if (again) decorateMeeting();
    }
  }
  async function decorateMeetingNow() {
    const id = A.route.id;
    const m = A.Store.get(id);
    if (!m) return;
    // timestamps on transcript lines + editable speaker labels
    const lines = document.querySelectorAll("#mTranscript .turn");
    lines.forEach((el, i) => {
      const t = m.turns[i]; if (!t || el.querySelector(".ts")) return;
      const sec = turnSec(m, t);
      if (sec === null) return;
      const ts = document.createElement("button");
      ts.className = "ts"; ts.type = "button"; ts.title = `${Math.round(sec)} s`; ts.textContent = mmss(sec);
      ts.onclick = () => window.GatherRec.jump(id, sec);
      el.querySelector(".who")?.prepend(ts);
      const who = el.querySelector(".who");
      if (who && !who.dataset.editable) {
        who.dataset.editable = "1"; who.title = "Click the name to rename this speaker";
        who.addEventListener("click", (ev) => { if (ev.target.classList.contains("ts")) return; renameSpeaker(id, t.speaker); });
      }
    });
    // timestamps next to evidence quotes (tasks, decisions, commitments…)
    document.querySelectorAll("#view-meeting .evidence").forEach((ev) => {
      if (ev.querySelector(".ts")) return;
      const sec = secForQuote(m, ev.dataset.quote);
      if (sec === null) return;
      const b = document.createElement("button"); b.className = "ts"; b.type = "button"; b.textContent = "▶ " + mmss(sec); b.title = `${Math.round(sec)} s into the meeting`;
      b.onclick = (e) => { e.stopPropagation(); window.GatherRec.jump(id, sec); };
      ev.appendChild(b);
    });
    // recording panel
    const col = document.querySelector("#view-meeting .detail-grid .col-flow");
    let panel = $("recPanel");
    const meta = recMeta(id);
    if (!meta || (!meta.stored && !meta.notStored)) { panel?.remove(); return; }
    if (!panel) { panel = document.createElement("div"); panel.className = "panel"; panel.id = "recPanel"; col.prepend(panel); }
    if (meta.notStored) {
      panel.innerHTML = `<div class="panel-head"><h2>Recording</h2></div><p class="muted">This recording (${(meta.size / 1048576).toFixed(1)} MB) was too large for browser storage and was downloaded to your computer instead.</p>`;
      return;
    }
    if (panel.dataset.for === id && $("recPlayer")) { seekNow(); return; }
    const r = await getRec(id);
    if (!r || !r.blob) { panel.innerHTML = `<div class="panel-head"><h2>Recording</h2></div><p class="muted">The recording isn't available in this browser any more (browser data may have been cleared).</p>`; return; }
    if (playerURL) URL.revokeObjectURL(playerURL);
    playerURL = URL.createObjectURL(r.blob);
    panel.innerHTML = `<div class="panel-head"><h2>Recording</h2><span class="count">${mmss(r.duration)}</span></div>
      ${r.hasVideo ? `<video id="recPlayer" class="rec-player" controls preload="metadata" src="${playerURL}"></video>` : `<audio id="recPlayer" controls preload="metadata" src="${playerURL}" style="width:100%"></audio>`}
      <div class="meta" style="padding-left:0;margin-top:8px">${(r.size / 1048576).toFixed(1)} MB · ${r.hasVideo ? "screen" : "no screen"} · audio: ${esc(r.audio)} · stored only in this browser</div>
      <div class="row"><a class="btn ghost sm" href="${playerURL}" download="${esc((m.title || "meeting").replace(/[^\w\- ]+/g, ""))}.${r.mime.includes("mp4") ? "mp4" : "webm"}">Download</a>
        <button class="btn danger sm" id="recDelete">Delete recording</button></div>
      ${r.snaps && r.snaps.length ? `<div class="panel-head" style="margin-top:20px"><h2>Screen details</h2><span class="count">${r.snaps.length}</span></div>
        <p class="muted small">Snapshots of the shared screen. Names or details are only what <b>you</b> enter here (user-confirmed); Gather doesn't guess from images.</p>
        <div class="snap-grid">${r.snaps.map((s, i) => `<div class="snap"><img src="${s.img}" alt="Screen at ${mmss(s.sec)}" data-snapjump="${s.sec}" />
          <button class="ts" data-snapjump="${s.sec}">${mmss(s.sec)}</button>
          <input data-snapedit="${i}" value="${esc(s.details || "")}" placeholder="Names / details you see…" />
          ${s.details ? `<span class="confirmed-label">User-confirmed</span>` : ""}</div>`).join("")}</div>` : ""}`;
    panel.dataset.for = id;
    fixDuration($("recPlayer"));
    panel.querySelectorAll("[data-snapjump]").forEach((b) => (b.onclick = () => window.GatherRec.jump(id, +b.dataset.snapjump)));
    panel.querySelectorAll("[data-snapedit]").forEach((inp) => (inp.onchange = async () => {
      const cur = await getRec(id); if (!cur) return;
      cur.snaps[+inp.dataset.snapedit].details = inp.value.trim();
      try { await putRec(cur); A.toast("Screen details saved (user-confirmed)."); const pp = $("recPanel"); if (pp) pp.dataset.for = ""; decorateMeeting(); } catch { A.toast("Couldn't save: browser storage is full.", "error"); }
    }));
    $("recDelete").onclick = async () => {
      if (!confirm("Delete this recording? The transcript and tasks stay.")) return;
      await delRec(id); setRecMeta(id, { stored: false, deleted: true });
      A.toast("Recording deleted."); const pp = $("recPanel"); if (pp) pp.dataset.for = ""; decorateMeeting();
    };
    seekNow();
  }
  // Chrome's MediaRecorder WebM has no duration: seek far once so the player computes it (enables the scrubber)
  function fixDuration(v) {
    if (!v) return;
    const run = () => {
      if (v.duration !== Infinity && !isNaN(v.duration)) { v.dataset.ready = "1"; v.dispatchEvent(new Event("gather-ready")); return; }
      const back = () => { v.removeEventListener("timeupdate", back); v.currentTime = 0; v.dataset.ready = "1"; v.dispatchEvent(new Event("gather-ready")); };
      v.addEventListener("timeupdate", back);
      v.currentTime = 1e9;
    };
    v.readyState >= 1 ? run() : v.addEventListener("loadedmetadata", run, { once: true });
  }
  function renameSpeaker(meetingId, oldName) {
    const name = (prompt(`Rename “${oldName}” in this meeting to:`, oldName) || "").trim();
    if (!name || name === oldName) return;
    const m = A.Store.get(meetingId); if (!m) return;
    m.turns.forEach((t) => { if (t.speaker === oldName) t.speaker = name; });
    for (const cat of Object.keys(m.state || {})) for (const it of m.state[cat]) {
      for (const f of ["owner", "assigned_by", "who", "to_whom", "decided_by"]) if (it[f] === oldName) it[f] = name;
      if (it.evidence && it.evidence.speaker === oldName) it.evidence.speaker = name;
    }
    A.Store.save(m);
    A.toast(`Renamed “${oldName}” to “${name}”.`);
    location.hash = "#/meetings"; setTimeout(() => (location.hash = "#/meeting/" + meetingId), 0); // re-render with new names
  }

  // ---------------------------------------------------------------- To-do list: timestamp chips
  function decorateTodos() {
    document.querySelectorAll("#todoList .item.task, #openActions .item").forEach((row) => {
      if (row.querySelector(".ts")) return;
      const ref = row.querySelector("[data-ref]")?.dataset.ref || "";
      const [kind, mid] = ref.split(":");
      if (kind !== "m") return;
      const t = A.findTaskTarget(ref);
      const q = t && t.obj.evidence && t.obj.evidence.quote;
      const info = q && window.GatherRec.timeFor(mid, q);
      if (!info) return;
      const b = document.createElement("button"); b.className = "ts"; b.type = "button";
      b.textContent = (info.hasVideo ? "▶ " : "") + info.label; b.title = info.hasVideo ? "Jump to this moment in the recording" : `${info.sec} s into the meeting`;
      b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); window.GatherRec.jump(mid, info.sec); };
      row.querySelector(".sub")?.appendChild(b);
    });
  }
  const todo = $("todoList");
  if (todo) new MutationObserver(() => decorateTodos()).observe(todo, { childList: true });

  // ---------------------------------------------------------------- task manager panel: timestamp line
  new MutationObserver(() => {
    const d = $("tmDrawer"); const q = d && d.querySelector(".tm-quote");
    if (!q || q.querySelector(".ts")) return;
    const link = d.querySelector('.tm-sec a.from[href^="#/meeting/"]'); if (!link) return;
    const mid = link.getAttribute("href").replace("#/meeting/", "");
    const quote = q.childNodes[0] && q.childNodes[0].textContent.replace(/[“”]/g, "");
    const info = window.GatherRec.timeFor(mid, quote);
    if (!info) return;
    const b = document.createElement("button"); b.className = "ts"; b.type = "button";
    b.textContent = (info.hasVideo ? "▶ " : "") + info.label + (info.hasVideo ? " in the recording" : " into the meeting");
    b.onclick = () => window.GatherRec.jump(mid, info.sec);
    q.appendChild(b);
  }).observe(document.body, { childList: true, subtree: false });
  document.addEventListener("click", () => setTimeout(() => {
    const d = $("tmDrawer"); if (d && !d.dataset.obs) { d.dataset.obs = "1"; new MutationObserver(() => document.body.dispatchEvent(new Event("gather-drawer"))).observe(d, { childList: true }); }
  }, 0));
  document.body.addEventListener("gather-drawer", () => {
    const d = $("tmDrawer"); const q = d && d.querySelector(".tm-quote");
    if (!q || q.querySelector(".ts")) return;
    const link = d.querySelector('.tm-sec a.from[href^="#/meeting/"]'); if (!link) return;
    const mid = link.getAttribute("href").replace("#/meeting/", "");
    const info = window.GatherRec.timeFor(mid, q.childNodes[0] && q.childNodes[0].textContent.replace(/[“”]/g, ""));
    if (!info) return;
    const b = document.createElement("button"); b.className = "ts"; b.type = "button";
    b.textContent = (info.hasVideo ? "▶ " : "") + info.label + (info.hasVideo ? " in the recording" : " into the meeting");
    b.onclick = () => window.GatherRec.jump(mid, info.sec);
    q.appendChild(b);
  });

  // ---------------------------------------------------------------- start dialog: support + routing
  function syncStartOption() {
    const row = $("optRecordRow"); if (!row) return;
    if (!SUPPORTED) {
      $("optRecord").checked = false; $("optRecord").disabled = true;
      row.querySelector("small").textContent = "Not available in this browser (needs MediaRecorder, screen sharing and IndexedDB). Use a recent Chrome or Edge.";
    }
  }
  syncStartOption();
  document.addEventListener("aether:route", (e) => {
    if (e.detail.view === "meeting") setTimeout(decorateMeeting, 0);
    if (e.detail.view === "home") setTimeout(decorateTodos, 50);
  });
  // re-decorate when the meeting page re-renders (summary arrives, items change)
  const mt = $("mTranscript");
  if (mt) new MutationObserver(() => { if (A.route.view === "meeting") decorateMeeting(); }).observe(mt, { childList: true });
  setTimeout(() => { if (A.route.view === "meeting") decorateMeeting(); if (A.route.view === "home") decorateTodos(); }, 0);
  // tidy recordings whose meeting was deleted
  setTimeout(async () => {
    try {
      if (!A.user) return;
      const keys = await idb("readonly", (s) => s.getAllKeys());
      const pre = A.user.id + ":";
      for (const k of keys || []) if (String(k).startsWith(pre) && !A.Store.get(String(k).slice(pre.length))) { await idb("readwrite", (s) => s.delete(k)); setRecMeta(String(k).slice(pre.length), null); }
    } catch {}
  }, 3000);

  // ---------------------------------------------------------------- styles
  const css = document.createElement("style");
  css.textContent = `
    .rec-bar { position: fixed; left: 24px; bottom: 24px; z-index: 58; display: flex; align-items: center; gap: 14px; padding: 10px 14px 10px 10px;
      background: #15120f; border: 1px solid rgba(232,154,140,.45); box-shadow: 0 20px 60px rgba(0,0,0,.6); }
    .rec-bar video { width: 160px; height: 90px; object-fit: cover; background: #000; border: 1px solid var(--line); }
    .rec-info { display: flex; flex-direction: column; gap: 4px; }
    .rec-info b { font: 600 11px Inter, sans-serif; letter-spacing: .2em; color: #f0b3a6; display: flex; align-items: center; gap: 8px; }
    .rec-info span#recWhat { font: 600 9px Inter, sans-serif; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
    .ts { background: none; border: 1px solid rgba(216,183,124,.4); color: var(--gold, #d8b77c); font: 600 9px Inter, sans-serif; letter-spacing: .12em;
      padding: 1px 6px; margin-right: 8px; cursor: pointer; border-radius: 2px; vertical-align: middle; }
    .ts:hover { background: rgba(216,183,124,.12); }
    .evidence .ts { margin: 6px 0 0; display: inline-block; font-style: normal; }
    .turn .who[data-editable] { cursor: pointer; }
    .rec-player { width: 100%; max-height: 360px; background: #000; border: 1px solid var(--line); }
    .snap-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; margin-top: 10px; }
    .snap img { width: 100%; display: block; border: 1px solid var(--line); cursor: pointer; }
    .snap .ts { margin-top: 6px; }
    .snap input { width: 100%; margin-top: 6px; background: transparent; border: none; border-bottom: 1px solid rgba(244,237,225,.22); color: var(--text); font: 12px Inter, sans-serif; padding: 4px 1px; }
    .confirmed-label { display: inline-block; margin-top: 4px; font: 600 8.5px Inter, sans-serif; letter-spacing: .16em; text-transform: uppercase; color: var(--good, #9fd8b8); }
  `;
  document.head.appendChild(css);
})();
