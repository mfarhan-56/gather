// Gather: PS-05 features (self-contained; uses only the public window.AETHER API + events from app.js)
//  - Upload a transcript (.txt/.vtt/.srt / pasted) or an audio recording -> full analysis -> saved meeting
//  - Evidence trail: click a quote to jump to it in the transcript
//  - Cross-meeting tracking: a new meeting suggests updates to earlier commitments (you confirm)
//  - Team view: everyone's commitments across meetings, built from real meeting data
(() => {
  const A = window.AETHER;
  if (!A) return;
  const $ = (id) => document.getElementById(id);
  const esc = A.esc;
  const STATUS_LABEL = { done: "Done", in_progress: "In progress", delayed: "Delayed", blocked: "Blocked", cancelled: "Cancelled" };

  async function postJSON(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
    return d;
  }
  const userName = () => (A.Profile.get().name || "");

  // ================================================================ styles (theme-consistent)
  const css = document.createElement("style");
  css.textContent = `
    .evidence { margin-top: 7px; padding-left: 10px; border-left: 1px solid rgba(216,183,124,.45); color: rgba(239,232,220,.62);
      font: italic 400 15px/1.45 var(--serif, Georgia, serif); cursor: pointer; }
    .evidence span { display: block; font: 600 9px Inter, sans-serif; font-style: normal; letter-spacing: .18em; text-transform: uppercase; color: rgba(239,232,220,.4); margin-top: 3px; }
    .evidence:hover { color: var(--ivory, #f4ede1); border-left-color: var(--gold, #d8b77c); }
    .depends { margin-top: 6px; font: 600 9.5px Inter, sans-serif; letter-spacing: .14em; text-transform: uppercase; color: #e8b58c; }
    .tag.prio-high { color: #f0a597 !important; border-color: rgba(240,165,151,.35) !important; }
    .tag.prio-medium { color: var(--gold, #d8b77c) !important; border-color: rgba(216,183,124,.3) !important; }
    .tag.prio-low { color: rgba(239,232,220,.5) !important; }
    .tag.waits { color: #e8b58c !important; }
    .tag.progress { color: #cfe3e6 !important; }
    .turn.found { background: rgba(216,183,124,.10); box-shadow: inset 2px 0 0 var(--gold, #d8b77c); transition: background .4s; }
    .cross-item { padding: 14px 2px; border-bottom: 1px solid var(--line); }
    .cross-item .what { font: 500 19px/1.3 var(--serif, Georgia, serif); color: var(--ivory, #f4ede1); }
    .cross-item .meta2 { font: 600 9.5px Inter, sans-serif; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); margin: 5px 0; }
    .cross-item .meta2 b { color: var(--gold, #d8b77c); font-weight: 600; }
    .cross-item .row { margin-top: 10px; }
    .cross-done { font: italic 400 15px var(--serif, Georgia, serif); color: var(--good, #9fd8b8); margin-top: 8px; }
    .cross-dismissed { color: var(--muted); }
    #crossNotice a { color: var(--gold, #d8b77c); }
    .upload-drop { border: 1px dashed rgba(216,183,124,.4); padding: 18px; text-align: center; color: var(--muted); margin: 6px 0 14px; cursor: pointer;
      font: italic 400 16px var(--serif, Georgia, serif); }
    .upload-drop.over, .upload-drop:hover { border-color: var(--gold, #d8b77c); color: var(--ivory, #f4ede1); }
    .upload-text { width: 100%; min-height: 150px; resize: vertical; background: rgba(244,237,225,.03); border: 1px solid var(--line); color: var(--text);
      font: 13px/1.6 Inter, sans-serif; padding: 12px; border-radius: 2px; }
    .upload-progress { margin-top: 12px; font: italic 400 16px var(--serif, Georgia, serif); color: var(--accent-2); display: flex; gap: 10px; align-items: center; }
    .team-stats { display: grid; grid-template-columns: repeat(4, 1fr); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); margin-bottom: 26px; }
    .team-stats div { padding: 18px 16px; border-left: 1px solid var(--line); }
    .team-stats div:first-child { border-left: none; padding-left: 0; }
    .team-stats b { display: block; font: 500 42px/1 var(--serif, Georgia, serif); color: var(--ivory, #f4ede1); }
    .team-stats span { display: block; margin-top: 8px; font: 600 9.5px Inter, sans-serif; letter-spacing: .22em; text-transform: uppercase; color: var(--muted); }
    .team-stats .bad b { color: var(--bad); }
    .member { display: grid; grid-template-columns: 300px 1fr; gap: 34px; padding: 26px 0; border-bottom: 1px solid var(--line); }
    .member h3 { font: 500 30px/1.1 var(--serif, Georgia, serif); color: var(--ivory, #f4ede1); margin: 0 0 6px; }
    .member .state { font: 600 9.5px Inter, sans-serif; letter-spacing: .24em; text-transform: uppercase; }
    .member .state.ok { color: var(--good); } .member .state.risk { color: var(--bad); } .member .state.heavy { color: #e8b58c; } .member .state.idle { color: var(--muted); }
    .member .nums { margin: 14px 0 12px; font: 600 9.5px Inter, sans-serif; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); line-height: 2; }
    .member .nums b { color: var(--ivory, #f4ede1); font: 500 18px var(--serif, Georgia, serif); letter-spacing: 0; margin-right: 4px; }
    .member .bar { height: 2px; background: var(--line); }
    .member .bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--gold, #d8b77c), var(--ivory, #f4ede1)); }
    .member .tasks .item { padding: 10px 0; }
    .member .more { font: italic 400 15px var(--serif, Georgia, serif); color: var(--muted); margin-top: 8px; }
    @media (max-width: 1000px) { .member { grid-template-columns: 1fr; } .team-stats { grid-template-columns: repeat(2, 1fr); } }
  `;
  document.head.appendChild(css);

  // ================================================================ evidence trail
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  document.addEventListener("click", (e) => {
    const ev = e.target.closest(".evidence");
    if (!ev) return;
    const box = $("mTranscript");
    if (!box || $("view-meeting").hidden) return A.toast("Open the meeting page to see this in the transcript.");
    const words = norm(ev.dataset.quote).split(" ").slice(0, 7).join(" ");
    const turns = [...box.querySelectorAll(".turn")];
    const hit = turns.find((t) => norm(t.textContent).includes(words)) ||
      turns.find((t) => norm(t.textContent).includes(words.split(" ").slice(0, 4).join(" ")));
    if (!hit) return A.toast("Couldn't locate that exact line in the transcript.");
    turns.forEach((t) => t.classList.remove("found"));
    hit.classList.add("found");
    hit.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  // ================================================================ cross-meeting tracking
  function openItemsExcept(meetingId) {
    return A.collectTasks().filter((t) => !t.done && t.meetingId !== meetingId).slice(0, 40).map((t) => ({
      ref: t.ref, task: t.text, owner: t.owner || (t.manual ? "You" : null),
      due: t.due ? A.isoDate(t.due) : null, meeting: t.meetingTitle || "personal task",
    }));
  }
  async function runCrosscheck(meetingId) {
    const m = A.Store.get(meetingId);
    if (!m || !m.turns?.length || m.crossChecked) return;
    const items = openItemsExcept(meetingId);
    if (!items.length) return;
    try {
      const { updates } = await postJSON("/api/crosscheck", { turns: m.turns.slice(-400), open_items: items, today: A.todayString(), user_name: userName() });
      const fresh = A.Store.get(meetingId);
      if (!fresh) return;
      fresh.crossChecked = true;
      fresh.crossUpdates = (updates || []).map((u) => ({ ...u, state: "pending" }));
      A.Store.save(fresh);
      if (fresh.crossUpdates.length) A.toast(`Gather found ${fresh.crossUpdates.length} update${fresh.crossUpdates.length > 1 ? "s" : ""} to earlier commitments. Review them on the meeting page.`);
      renderCrossPanel();
      renderCrossNotice();
    } catch (e) {
      console.warn("crosscheck failed", e);
    }
  }
  document.addEventListener("aether:summary-ready", (e) => runCrosscheck(e.detail.id));

  function meetingTitleFor(ref) {
    const [kind, mid] = ref.split(":");
    if (kind !== "m") return "Personal task";
    const m = A.Store.get(mid);
    return m ? m.title : "Earlier meeting";
  }
  function applyUpdate(u) {
    const t = A.findTaskTarget(u.ref);
    if (!t) return false;
    if (u.status === "done" || u.status === "cancelled") A.setTaskDone(u.ref, true);
    if (u.status === "delayed" && u.new_due_date) A.setTaskDue(u.ref, u.new_due_date);
    const again = A.findTaskTarget(u.ref);
    if (again) {
      again.obj.progress = u.status === "done" ? null : u.status;
      again.obj.progressNote = u.note || null;
      again.save();
    }
    return true;
  }
  function renderCrossPanel() {
    const r = A.route;
    if (r.view !== "meeting" || !r.id) return;
    const m = A.Store.get(r.id);
    const col = document.querySelector("#view-meeting .detail-grid .col-flow");
    if (!col) return;
    let panel = $("crossPanel");
    const ups = (m && m.crossUpdates) || [];
    if (!ups.length) { panel?.remove(); return; }
    if (!panel) { panel = document.createElement("div"); panel.className = "panel"; panel.id = "crossPanel"; col.prepend(panel); }
    panel.innerHTML = `<div class="panel-head"><h2>Updates to earlier commitments</h2><span class="count">${ups.filter((u) => u.state === "pending").length}</span></div>
      <p class="muted small" style="margin:0 0 6px">Gather noticed this meeting changes tasks from earlier meetings. Confirm to apply.</p>` +
      ups.map((u, i) => {
        const t = A.findTaskTarget(u.ref);
        const name = t ? (t.obj.task || t.obj.text) : "(task no longer exists)";
        const c = typeof u.confidence === "number" ? Math.round(u.confidence * 100) : null;
        return `<div class="cross-item">
          <div class="what">${esc(name)}</div>
          <div class="meta2">From ${esc(meetingTitleFor(u.ref))} · Now <b>${esc(STATUS_LABEL[u.status] || u.status)}</b>${u.new_due_date ? ` · New date <b>${esc(u.new_due_date)}</b>` : ""}${c !== null ? ` · ${c}% sure` : ""}</div>
          ${u.note ? `<div class="muted small">${esc(u.note)}</div>` : ""}
          ${u.evidence?.quote ? `<div class="evidence" data-quote="${esc(u.evidence.quote)}">“${esc(u.evidence.quote)}”<span>${esc(u.evidence.speaker || "")}</span></div>` : ""}
          ${u.state === "pending" && t ? `<div class="row"><button class="btn primary sm" data-cross-ok="${i}">Confirm</button><button class="btn ghost sm" data-cross-no="${i}">Dismiss</button></div>`
            : u.state === "confirmed" ? `<div class="cross-done">Applied to the task.</div>` : u.state === "dismissed" ? `<div class="cross-done cross-dismissed">Dismissed.</div>` : ""}
        </div>`;
      }).join("");
    panel.querySelectorAll("[data-cross-ok],[data-cross-no]").forEach((b) => (b.onclick = () => {
      const fresh = A.Store.get(r.id);
      const i = +(b.dataset.crossOk ?? b.dataset.crossNo);
      const u = fresh.crossUpdates[i];
      if (!u) return;
      if (b.dataset.crossOk !== undefined) { if (applyUpdate(u)) { u.state = "confirmed"; A.toast("Task updated."); } }
      else u.state = "dismissed";
      A.Store.save(fresh);
      A.rerender();
      renderCrossPanel();
    }));
  }
  function renderCrossNotice() {
    const host = document.querySelector("#view-home .station-copy");
    if (!host) return;
    let pending = [];
    for (const m of A.Store.list()) for (const u of m.crossUpdates || []) if (u.state === "pending" && A.findTaskTarget(u.ref)) pending.push(m);
    let el = $("crossNotice");
    if (!pending.length) { el?.remove(); return; }
    if (!el) { el = document.createElement("div"); el.className = "banner"; el.id = "crossNotice"; host.appendChild(el); }
    const m = pending[0];
    el.innerHTML = `${pending.length} suggested update${pending.length > 1 ? "s" : ""} to earlier commitments from “${esc(m.title)}”. <a href="#/meeting/${esc(m.id)}">Review</a>`;
  }

  // ================================================================ upload (transcript or recording)
  const AUDIO_EXT = /\.(mp3|wav|m4a|mp4|aac|ogg|oga|webm|flac|mov|wma)$/i;
  function ensureUploadUI() {
    const hero = document.querySelector("#view-meetings .hero");
    if (hero && !$("uploadBtn")) {
      const b = document.createElement("button");
      b.className = "btn primary"; b.id = "uploadBtn"; b.type = "button"; b.textContent = "Upload transcript or recording";
      b.onclick = openUpload;
      hero.appendChild(b);
    }
    if ($("uploadModal")) return;
    const modal = document.createElement("div");
    modal.className = "modal"; modal.id = "uploadModal"; modal.hidden = true;
    modal.innerHTML = `
      <div class="modal-card wide">
        <div class="modal-top"><h3>Add a past meeting</h3><button class="btn ghost sm" id="upClose">✕</button></div>
        <p class="muted small">Upload a transcript (.txt, .vtt, .srt), a recording (mp3, wav, m4a, mp4…), or paste the conversation. Gather will extract decisions, commitments, owners and deadlines, and check them against your earlier meetings.</p>
        <label class="field">Meeting name (optional)<input id="upTitle" maxlength="80" placeholder="Gather names it if empty" /></label>
        <label class="field">When was it?<input id="upDate" type="datetime-local" /></label>
        <div class="upload-drop" id="upDrop">Drop a file here, or click to choose<input type="file" id="upFile" hidden accept=".txt,.vtt,.srt,.md,audio/*,video/*" /></div>
        <textarea class="upload-text" id="upText" placeholder="…or paste the transcript. Lines like “Priya: Can we ship Friday?” work best."></textarea>
        <div class="upload-progress" id="upProgress" hidden><div class="spinner"></div><span id="upStatus"></span></div>
        <div class="modal-actions"><button class="btn ghost" id="upCancel">Cancel</button><button class="btn primary" id="upGo">Analyze meeting</button></div>
      </div>`;
    document.body.appendChild(modal);
    let file = null;
    const drop = $("upDrop"), input = $("upFile");
    const setFile = (f) => { file = f; drop.textContent = f ? `Selected: ${f.name}` : "Drop a file here, or click to choose"; drop.appendChild(input); };
    drop.onclick = (e) => { if (e.target !== input) input.click(); };
    input.onchange = () => setFile(input.files[0] || null);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); setFile(e.dataTransfer.files[0] || null); };
    const close = () => { if (!busy) modal.hidden = true; };
    $("upClose").onclick = close; $("upCancel").onclick = close;
    let busy = false;
    const status = (t) => { $("upProgress").hidden = !t; $("upStatus").textContent = t || ""; };

    $("upGo").onclick = async () => {
      if (busy) return;
      const pasted = $("upText").value.trim();
      if (!file && !pasted) return A.toast("Choose a file or paste a transcript.", "warn");
      busy = true; $("upGo").disabled = true;
      try {
        let turns = null, text = null, durationMs = 0;
        if (file && (AUDIO_EXT.test(file.name) || /^(audio|video)\//.test(file.type))) {
          if (file.size > 150 * 1024 * 1024) throw new Error("Recording is too large (max 150 MB).");
          status("Uploading recording…");
          const r = await fetch("/api/audio/start", { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || "Upload failed");
          status("Transcribing with speaker detection… (about a quarter of the recording's length)");
          for (let i = 0; i < 400; i++) {
            await new Promise((res) => setTimeout(res, 3000));
            const s = await (await fetch("/api/audio/status/" + encodeURIComponent(d.id))).json();
            if (s.status === "error") throw new Error(s.error || "Transcription failed");
            if (s.status === "completed") { turns = s.turns; durationMs = Math.round((s.duration || 0) * 1000); break; }
          }
          if (!turns || !turns.length) throw new Error("No speech was found in the recording.");
        } else if (file) {
          text = await file.text();
        } else {
          text = pasted;
        }
        status("Understanding the conversation: decisions, commitments, owners, deadlines…");
        const res = await postJSON("/api/transcript/analyze", { text, turns, user_name: userName(), today: A.todayString() });
        const when = $("upDate").value ? new Date($("upDate").value).getTime() : Date.now();
        const estMs = durationMs || Math.max(60000, res.turns.length * 20000);
        const chosen = $("upTitle").value.trim();
        const id = "m" + Date.now().toString(36);
        const meeting = {
          id, title: chosen || res.title || (file ? file.name.replace(/\.[^.]+$/, "") : "Uploaded meeting"), titleAuto: !chosen && !res.title,
          startedAt: when, endedAt: when + estMs, duration: estMs, source: file ? "upload:" + file.name : "upload:pasted",
          turns: res.turns.map((t, i) => ({ ...t, t: when + (estMs / Math.max(1, res.turns.length)) * i })),
          state: res.state, suggestions: [], liveSummary: res.live_summary || "", summary: res.summary || null, summaryError: null,
        };
        A.Store.save(meeting);
        if (!res.complete) A.toast("Part of the transcript couldn't be analysed (AI limit). You can re-run the summary later.", "warn");
        status("Checking earlier commitments…");
        await runCrosscheck(id);
        status("");
        modal.hidden = true;
        $("upText").value = ""; $("upTitle").value = ""; setFile(null);
        location.hash = "#/meeting/" + id;
        A.toast("Meeting analysed and saved.");
      } catch (e) {
        status("");
        A.toast(e.message || String(e), "error");
      } finally {
        busy = false; $("upGo").disabled = false;
      }
    };
  }
  function openUpload() {
    ensureUploadUI();
    const d = new Date(); d.setSeconds(0, 0);
    const p = (n) => String(n).padStart(2, "0");
    $("upDate").value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    $("uploadModal").hidden = false;
  }

  // ================================================================ team view (real meeting data)
  function renderTeam() {
    const tasks = A.collectTasks().filter((t) => !t.manual && t.owner);
    const today = A.startOfDay(), week = new Date(today.getTime() + 7 * 86400000);
    const me = userName();
    const people = new Map();
    const keyOf = (o) => (A.isMineOwner(o) ? "__you" : String(o).trim().toLowerCase());
    const person = (o) => {
      const k = keyOf(o);
      if (!people.has(k)) people.set(k, { name: k === "__you" ? (me ? `${me} (you)` : "You") : String(o).trim(), tasks: [], commitments: 0, lastMeeting: 0 });
      return people.get(k);
    };
    for (const t of tasks) { const p = person(t.owner); p.tasks.push(t); p.lastMeeting = Math.max(p.lastMeeting, t.meetingDate || 0); }
    for (const m of A.Store.list()) for (const c of m.state?.commitments || []) if (c.who && !/^someone$/i.test(c.who)) { const p = person(c.who); p.commitments++; p.lastMeeting = Math.max(p.lastMeeting, m.startedAt); }

    const list = [...people.values()].map((p) => {
      const open = p.tasks.filter((t) => !t.done);
      const overdue = open.filter((t) => t.due && t.due < today);
      const soon = open.filter((t) => t.due && t.due >= today && t.due < week);
      const done = p.tasks.filter((t) => t.done);
      const blocked = open.filter((t) => t.dependsOn || t.progress === "blocked");
      const state = overdue.length ? ["risk", "At risk"] : open.length >= 6 ? ["heavy", "Heavy load"] : open.length ? ["ok", "On track"] : ["idle", "No open tasks"];
      return { ...p, open, overdue, soon, done, blocked, state };
    }).sort((a, b) => (b.overdue.length - a.overdue.length) || (b.open.length - a.open.length));

    const tot = (f) => list.reduce((s, p) => s + p[f].length, 0);
    $("teamStats").innerHTML = `
      <div><b>${list.length}</b><span>People</span></div>
      <div><b>${tot("open")}</b><span>Open tasks</span></div>
      <div class="${tot("overdue") ? "bad" : ""}"><b>${tot("overdue")}</b><span>Overdue</span></div>
      <div><b>${tot("blocked")}</b><span>Waiting on something</span></div>`;
    $("teamLine").textContent = list.length
      ? `${list.length} people have commitments across ${A.Store.list().length} meetings. ${list.filter((p) => p.state[0] === "risk").length} need attention.`
      : "No commitments yet. People appear here as soon as your meetings assign them tasks.";
    const PR = { high: 0, medium: 1, low: 2 };
    $("teamList").innerHTML = list.length ? list.map((p) => {
      const total = p.open.length + p.done.length;
      const pct = total ? Math.round((p.done.length / total) * 100) : 0;
      const top = p.open.slice().sort((a, b) => (PR[a.priority] ?? 1) - (PR[b.priority] ?? 1) || (a.due || 9e15) - (b.due || 9e15)).slice(0, 5);
      return `<div class="member">
        <div>
          <h3>${esc(p.name)}</h3>
          <div class="state ${p.state[0]}">${p.state[1]}</div>
          <div class="nums"><b>${p.open.length}</b> open · <b>${p.overdue.length}</b> overdue<br><b>${p.soon.length}</b> due this week · <b>${p.done.length}</b> done<br><b>${p.commitments}</b> commitments made</div>
          <div class="bar"><i style="width:${pct}%"></i></div>
          <div class="muted small" style="margin-top:8px">${pct}% complete${p.lastMeeting ? ` · last seen ${esc(A.fmtDate(p.lastMeeting))}` : ""}</div>
        </div>
        <div class="tasks">${top.length ? top.map((t) => `
          <div class="item"><div class="body"><div class="main">${esc(t.text)}</div>
            <div class="sub">${t.due ? `<span class="tag due ${A.dueClass(t.due)}">${esc(A.dueLabel(t.due))}</span>` : ""}${t.priority ? `<span class="tag prio prio-${esc(t.priority)}">${esc(t.priority)}</span>` : ""}${t.dependsOn ? `<span class="tag waits">Waits on ${esc(t.dependsOn)}</span>` : ""}${t.progress ? `<span class="tag progress">${esc(t.progress.replace("_", " "))}</span>` : ""}<a class="from" href="#/meeting/${esc(t.meetingId)}">${esc(t.meetingTitle)}</a>${t.assignedBy ? `<span class="tag">from ${esc(t.assignedBy)}</span>` : ""}</div>
          </div></div>`).join("") : `<div class="empty small">Nothing open.</div>`}
          ${p.open.length > top.length ? `<div class="more">and ${p.open.length - top.length} more open tasks</div>` : ""}
        </div>
      </div>`;
    }).join("") : `<div class="empty">No team commitments yet.</div>`;
  }

  // ================================================================ wiring
  document.addEventListener("aether:route", (e) => {
    const v = e.detail.view;
    if (v === "meetings") ensureUploadUI();
    if (v === "meeting") setTimeout(renderCrossPanel, 0);
    if (v === "home") setTimeout(renderCrossNotice, 0);
    if (v === "team") renderTeam();
  });
  ensureUploadUI();
  setTimeout(() => {
    const v = A.route.view;
    if (v === "meeting") renderCrossPanel();
    if (v === "home") renderCrossNotice();
    if (v === "team") renderTeam();
  }, 0);
})();
