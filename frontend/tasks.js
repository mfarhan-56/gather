// Gather Task Manager (#/tasks). Self-contained; uses only the public window.AETHER API.
// Same task data as the dashboard / team / meeting pages: a change here shows everywhere.
//  Board (Needs review / To do / In progress / Blocked / Done, drag & drop) · List (group, bulk actions) · Timeline
//  Detail panel: source + evidence, dependencies (waits on / blocks), subtasks (+ agent breakdown), notes,
//  linked items, activity history · Filters & search · Natural-language quick add · Send to GitHub / Notion
(() => {
  const A = window.AETHER;
  const view = document.getElementById("view-tasks");
  if (!A || !view) return;
  const esc = A.esc;
  const $ = (id) => document.getElementById(id);

  const STAGES = [["review", "Needs review"], ["todo", "To do"], ["in_progress", "In progress"], ["blocked", "Blocked"], ["done", "Done"]];
  const STAGE_LABEL = Object.fromEntries([...STAGES, ["cancelled", "Cancelled"]]);
  const PR = { high: 0, medium: 1, low: 2 };
  const ui = { mode: "board", scope: "all", person: "", meeting: "", priority: "", q: "", group: "none", cancelled: false, selected: new Set(), open: null };

  // ---------------------------------------------------------------- task model helpers
  function reviewReasons(t) {
    if (t.manual || t.reviewed || t.done || t.cancelled) return [];
    const r = [];
    if (t.status === "proposed") r.push("only suggested, not clearly agreed");
    if (t.unassigned) r.push("no owner was named");
    if (t.confidence !== null && t.confidence < 0.7) r.push(`low confidence (${Math.round(t.confidence * 100)}%)`);
    return r;
  }
  function stageOf(t) {
    if (t.cancelled) return "cancelled";
    if (t.done) return "done";
    if (reviewReasons(t).length) return "review";
    if (t.wf && t.wf !== "done" && t.wf !== "review") return t.wf;
    if (t.progress === "blocked") return "blocked";
    if (t.progress === "in_progress") return "in_progress";
    return "todo";
  }
  function mutate(ref, fn, activity) {
    const t = A.findTaskTarget(ref);
    if (!t) return false;
    fn(t.obj);
    if (activity) t.obj.activity = [...(t.obj.activity || []), { at: Date.now(), text: activity }];
    t.save();
    return true;
  }
  function setStage(ref, stage) {
    const t = A.findTaskTarget(ref);
    if (!t) return;
    const wasDone = !!t.obj.done;
    if (stage === "done" || stage === "cancelled") { if (!wasDone) A.setTaskDone(ref, true); }
    else if (wasDone) A.setTaskDone(ref, false);
    mutate(ref, (o) => {
      o.cancelled = stage === "cancelled";
      o.wf = stage;
      o.reviewed = true;
      o.progress = stage === "blocked" ? "blocked" : stage === "in_progress" ? "in_progress" : null;
      if (stage !== "done" && stage !== "cancelled") o.done = false;
    }, `Status changed to ${STAGE_LABEL[stage]}`);
  }
  const titleOf = (o) => o.task || o.text || "";
  // finished tasks show their date plainly (never "overdue")
  const dueTag = (t) => !t.due ? "" : (t.done || t.cancelled)
    ? `<span class="tag">${esc(t.due.toLocaleDateString([], { month: "short", day: "numeric" }))}</span>`
    : `<span class="tag due ${A.dueClass(t.due)}">${esc(A.dueLabel(t.due))}</span>`;
  const words = (s) => new Set(String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3));
  function similar(a, b) {
    const A1 = words(a), B1 = words(b);
    if (!A1.size || !B1.size) return 0;
    let hit = 0; A1.forEach((w) => { if (B1.has(w)) hit++; });
    return hit / Math.min(A1.size, B1.size);
  }
  function linkedTask(dependsText, all, selfRef) {
    if (!dependsText) return null;
    let best = null, score = 0;
    for (const t of all) if (t.ref !== selfRef) { const s = similar(dependsText, t.text); if (s > score) { score = s; best = t; } }
    return score >= 0.5 ? best : null;
  }

  // ---------------------------------------------------------------- data + filters
  function allTasks() { return A.collectTasks(); }
  function filtered() {
    const q = ui.q.trim().toLowerCase();
    return allTasks().filter((t) => {
      if (!ui.cancelled && t.cancelled) return false;
      if (ui.scope === "mine" && !t.mine) return false;
      if (ui.scope === "waiting" && !t.waiting) return false;
      if (ui.person && (t.owner || (t.manual ? "You" : "")).toLowerCase() !== ui.person) return false;
      if (ui.meeting && (t.meetingId || "__personal") !== ui.meeting) return false;
      if (ui.priority && (t.priority || "none") !== ui.priority) return false;
      if (q && !(`${t.text} ${t.owner || ""} ${t.meetingTitle || ""} ${t.assignedBy || ""} ${t.dependsOn || ""}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }
  const sortTasks = (list) => list.sort((a, b) => ((PR[a.priority] ?? 1) - (PR[b.priority] ?? 1)) || ((a.due || 9e15) - (b.due || 9e15)));

  // ---------------------------------------------------------------- page shell
  function shell() {
    if ($("tmBody")) return;
    const people = new Set(), meetings = new Map();
    view.innerHTML = `
      <div class="hero">
        <div><h2>Tasks</h2><p class="muted" id="tmLine">Every commitment from every meeting, in one place.</p></div>
        <div class="tabs" id="tmModes">
          <button class="tab" data-mode="board">Board</button>
          <button class="tab" data-mode="list">List</button>
          <button class="tab" data-mode="timeline">Timeline</button>
        </div>
      </div>
      <form class="tm-quick" id="tmQuick" autocomplete="off">
        <input id="tmQuickText" maxlength="240" placeholder="Add a task, e.g. “Send the deck to the board by Wednesday, high, for Priya”" />
        <button class="btn primary sm" type="submit">Add</button>
        <div class="tm-parse" id="tmParse"></div>
      </form>
      <div class="tm-filters">
        <div class="tabs" id="tmScope">
          <button class="tab" data-scope="all">Everyone</button>
          <button class="tab" data-scope="mine">Mine</button>
          <button class="tab" data-scope="waiting">Waiting on others</button>
        </div>
        <select id="tmPerson"></select>
        <select id="tmMeeting"></select>
        <select id="tmPriority">
          <option value="">Any priority</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option><option value="none">No priority</option>
        </select>
        <input id="tmSearch" placeholder="Search tasks…" />
        <label class="tm-check"><input type="checkbox" id="tmCancelled" /> Show cancelled</label>
      </div>
      <div class="tm-bulk" id="tmBulk" hidden></div>
      <div id="tmBody"></div>`;
    view.querySelectorAll("#tmModes .tab").forEach((b) => (b.onclick = () => { ui.mode = b.dataset.mode; ui.selected.clear(); render(); }));
    view.querySelectorAll("#tmScope .tab").forEach((b) => (b.onclick = () => { ui.scope = b.dataset.scope; render(); }));
    $("tmPerson").onchange = (e) => { ui.person = e.target.value; render(); };
    $("tmMeeting").onchange = (e) => { ui.meeting = e.target.value; render(); };
    $("tmPriority").onchange = (e) => { ui.priority = e.target.value; render(); };
    $("tmSearch").oninput = (e) => { ui.q = e.target.value; render(); };
    $("tmCancelled").onchange = (e) => { ui.cancelled = e.target.checked; render(); };
    $("tmQuickText").oninput = () => showParse();
    $("tmQuick").onsubmit = (e) => { e.preventDefault(); quickAdd(); };
  }

  function fillFilterOptions(tasks) {
    const people = [...new Set(tasks.map((t) => t.owner || (t.manual ? "You" : "")).filter(Boolean))].sort();
    const meetings = new Map();
    tasks.forEach((t) => meetings.set(t.meetingId || "__personal", t.meetingTitle || "Personal tasks"));
    const ps = $("tmPerson"), ms = $("tmMeeting");
    ps.innerHTML = `<option value="">Any person</option>` + people.map((p) => `<option value="${esc(p.toLowerCase())}">${esc(p)}</option>`).join("");
    ps.value = ui.person;
    ms.innerHTML = `<option value="">Any meeting</option>` + [...meetings].map(([id, title]) => `<option value="${esc(id)}">${esc(title)}</option>`).join("");
    ms.value = ui.meeting;
  }

  // ---------------------------------------------------------------- render
  function render() {
    if (view.hidden) return;
    shell();
    const all = allTasks();
    fillFilterOptions(all);
    view.querySelectorAll("#tmModes .tab").forEach((b) => b.classList.toggle("active", b.dataset.mode === ui.mode));
    view.querySelectorAll("#tmScope .tab").forEach((b) => b.classList.toggle("active", b.dataset.scope === ui.scope));
    const list = filtered();
    const open = all.filter((t) => !t.done && !t.cancelled);
    const review = all.filter((t) => stageOf(t) === "review").length;
    const overdue = open.filter((t) => t.due && t.due < A.startOfDay()).length;
    $("tmLine").textContent = `${open.length} open · ${overdue} overdue · ${review} need your review · ${all.filter((t) => t.done && !t.cancelled).length} done`;
    if (ui.mode === "board") renderBoard(list);
    else if (ui.mode === "list") renderList(list);
    else renderTimeline(list);
    renderBulk();
    if (ui.open) renderDrawer(ui.open);
  }

  function card(t) {
    const st = stageOf(t);
    const subs = (A.findTaskTarget(t.ref)?.obj.subtasks) || [];
    const subDone = subs.filter((s) => s.done).length;
    return `<div class="tm-card prio-line-${esc(t.priority || "none")}" draggable="true" data-ref="${esc(t.ref)}">
      <div class="tm-card-title">${esc(t.text)}</div>
      <div class="sub">
        ${dueTag(t)}
        ${t.priority && !t.done ? `<span class="tag prio prio-${esc(t.priority)}">${esc(t.priority)}</span>` : ""}
        <span class="tag ${t.mine ? "me" : ""}">${esc(t.owner || (t.manual ? "You" : "Unassigned"))}</span>
      </div>
      ${t.dependsOn && st !== "done" ? `<div class="depends">Waits on: ${esc(t.dependsOn)}</div>` : ""}
      ${st === "review" ? `<div class="tm-why">${esc(reviewReasons(t).join(" · "))}</div>` : ""}
      <div class="tm-card-foot">${t.manual ? "Personal" : esc(t.meetingTitle || "")}${subs.length ? ` · ${subDone}/${subs.length} steps` : ""}</div>
    </div>`;
  }

  function renderBoard(list) {
    const cols = STAGES.map(([key, label]) => {
      const items = sortTasks(list.filter((t) => stageOf(t) === key));
      return `<div class="tm-col" data-stage="${key}">
        <div class="tm-col-head"><span>${label}</span><b>${items.length}</b></div>
        <div class="tm-col-body">${items.map(card).join("") || `<div class="tm-empty">${key === "review" ? "Nothing needs review" : "Drop tasks here"}</div>`}</div>
      </div>`;
    }).join("");
    $("tmBody").innerHTML = `<div class="tm-board">${cols}</div>${ui.cancelled ? cancelledStrip(list) : ""}`;
    $("tmBody").querySelectorAll(".tm-card").forEach((c) => {
      c.onclick = () => openDrawer(c.dataset.ref);
      c.ondragstart = (e) => { e.dataTransfer.setData("text/plain", c.dataset.ref); c.classList.add("dragging"); };
      c.ondragend = () => c.classList.remove("dragging");
    });
    $("tmBody").querySelectorAll(".tm-col").forEach((col) => {
      col.ondragover = (e) => { e.preventDefault(); col.classList.add("over"); };
      col.ondragleave = () => col.classList.remove("over");
      col.ondrop = (e) => {
        e.preventDefault(); col.classList.remove("over");
        const ref = e.dataTransfer.getData("text/plain");
        if (!ref) return;
        if (col.dataset.stage === "review") return A.toast("Tasks enter review automatically when Gather is unsure.");
        setStage(ref, col.dataset.stage);
        A.toast(`Moved to ${STAGE_LABEL[col.dataset.stage]}`);
        render();
      };
    });
  }
  function cancelledStrip(list) {
    const items = list.filter((t) => t.cancelled);
    return items.length ? `<div class="tm-cancelled"><div class="group-label">Cancelled <span>${items.length}</span></div>${items.map((t) => `<div class="tm-mini" data-open="${esc(t.ref)}">${esc(t.text)}</div>`).join("")}</div>` : "";
  }

  function renderList(list) {
    const groupKey = { none: () => "All tasks", owner: (t) => t.owner || (t.manual ? "You" : "Unassigned"), meeting: (t) => t.meetingTitle || "Personal tasks",
      priority: (t) => (t.priority ? t.priority[0].toUpperCase() + t.priority.slice(1) + " priority" : "No priority"), status: (t) => STAGE_LABEL[stageOf(t)] }[ui.group];
    const groups = new Map();
    sortTasks(list).forEach((t) => { const k = groupKey(t); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); });
    const row = (t) => `<tr data-ref="${esc(t.ref)}" class="${ui.selected.has(t.ref) ? "sel" : ""}">
      <td><input type="checkbox" data-sel="${esc(t.ref)}" ${ui.selected.has(t.ref) ? "checked" : ""} /></td>
      <td class="tm-t" data-open="${esc(t.ref)}">${esc(t.text)}${t.dependsOn && !t.done ? `<div class="depends">Waits on: ${esc(t.dependsOn)}</div>` : ""}</td>
      <td><span class="tag tm-stage-${stageOf(t)}">${esc(STAGE_LABEL[stageOf(t)])}</span></td>
      <td>${esc(t.owner || (t.manual ? "You" : "Unassigned"))}</td>
      <td>${dueTag(t) || "—"}</td>
      <td>${t.priority ? `<span class="tag prio prio-${esc(t.priority)}">${esc(t.priority)}</span>` : "—"}</td>
      <td>${t.manual ? "Personal" : `<a class="from" href="#/meeting/${esc(t.meetingId)}">${esc(t.meetingTitle)}</a>`}</td>
      <td>${esc(t.assignedBy || "—")}</td>
    </tr>`;
    $("tmBody").innerHTML = `
      <div class="tm-listbar"><label class="muted small">Group by
        <select id="tmGroup"><option value="none">Nothing</option><option value="status">Status</option><option value="owner">Owner</option><option value="meeting">Meeting</option><option value="priority">Priority</option></select></label>
        <button class="btn ghost sm" id="tmSelAll">Select all</button></div>
      ${[...groups].map(([k, items]) => `
        ${ui.group !== "none" ? `<div class="group-label">${esc(k)} <span>${items.length}</span></div>` : ""}
        <table class="tm-table"><thead><tr><th></th><th>Task</th><th>Status</th><th>Owner</th><th>Due</th><th>Priority</th><th>Source</th><th>Assigned by</th></tr></thead>
        <tbody>${items.map(row).join("")}</tbody></table>`).join("") || `<div class="empty">No tasks match these filters.</div>`}`;
    $("tmGroup").value = ui.group;
    $("tmGroup").onchange = (e) => { ui.group = e.target.value; render(); };
    $("tmSelAll").onclick = () => { list.forEach((t) => ui.selected.add(t.ref)); render(); };
    $("tmBody").querySelectorAll("[data-sel]").forEach((c) => (c.onchange = () => { c.checked ? ui.selected.add(c.dataset.sel) : ui.selected.delete(c.dataset.sel); renderBulk(); c.closest("tr").classList.toggle("sel", c.checked); }));
  }

  function renderTimeline(list) {
    const today = A.startOfDay();
    const open = sortTasks(list.filter((t) => !t.done && !t.cancelled));
    const buckets = [["Overdue", open.filter((t) => t.due && t.due < today)]];
    for (let i = 0; i < 14; i++) {
      const d = new Date(today.getTime() + i * 86400000);
      const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
      buckets.push([label, open.filter((t) => t.due && +A.startOfDay(t.due) === +d)]);
    }
    const horizon = new Date(today.getTime() + 14 * 86400000);
    buckets.push(["Later", open.filter((t) => t.due && t.due >= horizon)], ["No due date", open.filter((t) => !t.due)]);
    $("tmBody").innerHTML = `<div class="tm-timeline">${buckets.filter(([, items]) => items.length).map(([label, items]) => `
      <div class="tm-day"><div class="tm-day-label ${label === "Overdue" ? "bad" : label === "Today" ? "gold" : ""}">${esc(label)} <span>${items.length}</span></div>
        <div>${items.map((t) => `<div class="tm-line" data-open="${esc(t.ref)}"><span class="tm-dot prio-${esc(t.priority || "none")}"></span>
          <span class="tm-line-t">${esc(t.text)}</span><span class="tm-line-m">${esc(t.owner || (t.manual ? "You" : "Unassigned"))} · ${t.manual ? "Personal" : esc(t.meetingTitle || "")}</span></div>`).join("")}</div>
      </div>`).join("") || `<div class="empty">No open tasks match these filters.</div>`}</div>`;
  }

  // ---------------------------------------------------------------- bulk actions
  function renderBulk() {
    const bar = $("tmBulk");
    if (!bar) return;
    const n = ui.mode === "list" ? ui.selected.size : 0;
    bar.hidden = !n;
    if (!n) return;
    bar.innerHTML = `<b>${n} selected</b>
      <select id="tbStage"><option value="">Set status…</option>${[...STAGES.slice(1), ["cancelled", "Cancelled"]].map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
      <select id="tbPrio"><option value="">Set priority…</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select>
      <input type="date" id="tbDue" title="Set due date" />
      <input id="tbOwner" placeholder="Set owner…" />
      <button class="btn ghost sm" id="tbGithub">Create GitHub issues</button>
      <button class="btn ghost sm" id="tbNotion">Send to Notion</button>
      <button class="btn ghost sm" id="tbClear">Clear</button>`;
    const refs = () => [...ui.selected];
    $("tbStage").onchange = (e) => { if (!e.target.value) return; refs().forEach((r) => setStage(r, e.target.value)); A.toast("Status updated"); render(); };
    $("tbPrio").onchange = (e) => { if (!e.target.value) return; refs().forEach((r) => mutate(r, (o) => { o.priority = e.target.value; o.priority_reason = "set by you"; }, `Priority set to ${e.target.value}`)); render(); };
    $("tbDue").onchange = (e) => { refs().forEach((r) => { A.setTaskDue(r, e.target.value); mutate(r, () => {}, `Due date set to ${e.target.value || "none"}`); }); render(); };
    $("tbOwner").onchange = (e) => { const v = e.target.value.trim(); if (!v) return; refs().forEach((r) => mutate(r, (o) => { o.owner = v; o.reviewed = true; }, `Owner set to ${v}`)); render(); };
    $("tbClear").onclick = () => { ui.selected.clear(); render(); };
    $("tbGithub").onclick = () => sendToApp("github", refs());
    $("tbNotion").onclick = () => sendToApp("notion", refs());
  }

  async function composio(path, body) {
    const r = await fetch("/api/composio/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) throw new Error(d.error || "HTTP " + r.status);
    return d;
  }
  function taskBody(t) {
    const o = A.findTaskTarget(t.ref)?.obj || {};
    return [`**Owner:** ${t.owner || "You"}`, t.assignedBy ? `**Assigned by:** ${t.assignedBy}` : "", t.due ? `**Due:** ${A.isoDate(t.due)}` : "",
      t.priority ? `**Priority:** ${t.priority}` : "", t.meetingTitle ? `**Source:** ${t.meetingTitle}` : "",
      o.evidence?.quote ? `> “${o.evidence.quote}” — ${o.evidence.speaker || ""}` : "", t.dependsOn ? `**Waits on:** ${t.dependsOn}` : "",
      "", "_Created by Gather_"].filter(Boolean).join("\n");
  }
  async function sendToApp(app, refs) {
    if (!A.user) return;
    const tasks = allTasks().filter((t) => refs.includes(t.ref));
    if (!tasks.length) return;
    try {
      const what = app === "github" ? "github_repos" : "notion_pages";
      const { options } = await composio("lookup", { user: A.user.id, what });
      if (!options.length) return A.toast(app === "github" ? "No GitHub repositories found." : "No Notion pages shared with Gather. Share a page in Notion first.", "warn");
      const pick = prompt(`${app === "github" ? "Repository" : "Notion parent page"} — type the number:\n` + options.slice(0, 20).map((o, i) => `${i + 1}. ${o.label}`).join("\n"), "1");
      const opt = options[(parseInt(pick, 10) || 0) - 1];
      if (!opt) return;
      if (app === "github") {
        if (!confirm(`Create ${tasks.length} GitHub issue(s) in ${opt.label}?`)) return;
        let ok = 0;
        for (const t of tasks) {
          const r = await composio("execute", { user: A.user.id, action: "github_issue", args: { repo: opt.value, title: t.text, body: taskBody(t) } });
          mutate(t.ref, (o) => { o.actions = [...(o.actions || []), { type: "github_issue", label: `GitHub issue created in ${opt.label}`, link: r.link || null, at: Date.now() }]; }, `GitHub issue created in ${opt.label}`);
          ok++;
        }
        A.toast(`${ok} GitHub issue(s) created`);
      } else {
        if (!confirm(`Create one Notion page with ${tasks.length} task(s) under “${opt.label}”?`)) return;
        const md = tasks.map((t) => `- [${t.done ? "x" : " "}] **${t.text}** — ${t.owner || "You"}${t.due ? `, due ${A.isoDate(t.due)}` : ""}${t.priority ? `, ${t.priority} priority` : ""}${t.meetingTitle ? ` _(from ${t.meetingTitle})_` : ""}`).join("\n");
        const r = await composio("execute", { user: A.user.id, action: "notion_page", args: { parent_id: opt.value, title: `Tasks from Gather — ${new Date().toLocaleDateString()}`, content: md } });
        tasks.forEach((t) => mutate(t.ref, (o) => { o.actions = [...(o.actions || []), { type: "notion_page", label: "Added to a Notion task page", link: r.link || null, at: Date.now() }]; }, "Sent to Notion"));
        A.toast("Notion page created");
      }
      render();
    } catch (e) {
      A.toast(e.message, "error");
    }
  }

  // ---------------------------------------------------------------- quick add (natural language)
  function parseQuick(raw) {
    let text = raw.trim();
    let priority = null, owner = null, due = null;
    const pm = text.match(/(?:,|\s)\s*(high|urgent|asap|critical|medium|low)(?:\s+priority)?\b/i) || text.match(/\s(!+)\s*$/);
    if (pm) { const w = pm[1].toLowerCase(); priority = /^(high|urgent|asap|critical|!+)$/.test(w) ? "high" : w; text = text.replace(pm[0], " "); }
    const om = text.match(/(?:\bfor\s+|@)([A-Z][a-zA-Z'-]+(?:\s[A-Z][a-zA-Z'-]+)?)/);
    if (om) { owner = om[1]; text = text.replace(om[0], " "); }
    const dm = text.match(/\b(?:by|on|due|before)\s+((?:next\s+)?(?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|end of (?:the )?month|[a-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,9}))\b/i)
      || text.match(/\b(today|tomorrow)\b/i);
    if (dm) { const d = A.parseDue(dm[1], Date.now()); if (d) { due = d; text = text.replace(dm[0], " "); } }
    text = text.replace(/\s{2,}/g, " ").replace(/[\s,;.-]+$/g, "").replace(/^[\s,;.-]+/, "").trim();
    return { text, priority, owner, due };
  }
  function showParse() {
    const v = $("tmQuickText").value;
    const p = parseQuick(v);
    $("tmParse").innerHTML = v.trim() ? `<span class="tag">${esc(p.text || "…")}</span>${p.owner ? `<span class="tag">Owner · ${esc(p.owner)}</span>` : `<span class="tag me">Owner · You</span>`}${p.due ? `<span class="tag due">${esc(A.dueLabel(p.due))}</span>` : ""}${p.priority ? `<span class="tag prio prio-${p.priority}">${p.priority}</span>` : ""}` : "";
  }
  function quickAdd() {
    const p = parseQuick($("tmQuickText").value);
    if (!p.text) return A.toast("Type a task first.", "warn");
    const list = A.Manual.all();
    list.push({ id: "t" + Date.now().toString(36), text: p.text, due_date: p.due ? A.isoDate(p.due) : null, owner: p.owner || null, priority: p.priority || null,
      done: false, wf: "todo", created: Date.now(), activity: [{ at: Date.now(), text: "Added in the task manager" }] });
    A.Manual.save(list);
    $("tmQuickText").value = ""; $("tmParse").innerHTML = "";
    A.toast("Task added");
    render();
  }

  // ---------------------------------------------------------------- detail panel
  function openDrawer(ref) { ui.open = ref; renderDrawer(ref); }
  function closeDrawer() { ui.open = null; $("tmDrawer")?.remove(); $("tmShade")?.remove(); }
  function activityFor(t, o) {
    const ev = [];
    if (t.manual) ev.push({ at: o.created || t.created || 0, text: "Added manually" });
    else ev.push({ at: t.meetingDate || 0, text: `Created from “${t.meetingTitle}”${t.assignedBy ? `, assigned by ${t.assignedBy}` : ""}` });
    for (const m of A.Store.list()) for (const u of m.crossUpdates || []) if (u.ref === t.ref)
      ev.push({ at: m.startedAt, text: `${u.state === "confirmed" ? "Updated" : u.state === "dismissed" ? "Dismissed suggestion" : "Suggested update"}: ${STAGE_LABEL[u.status] || u.status} in “${m.title}”${u.note ? ` (${u.note})` : ""}` });
    for (const a of o.actions || []) ev.push({ at: a.at, text: a.label, link: a.link });
    for (const a of o.activity || []) ev.push(a);
    if (o.doneAt && !(o.activity || []).some((a) => /Done/.test(a.text))) ev.push({ at: o.doneAt, text: "Marked done" });
    return ev.filter((e) => e.at).sort((a, b) => a.at - b.at);
  }
  function renderDrawer(ref) {
    const all = allTasks();
    const t = all.find((x) => x.ref === ref);
    const target = A.findTaskTarget(ref);
    if (!t || !target) { closeDrawer(); return; }
    const o = target.obj;
    const st = stageOf(t);
    const reasons = reviewReasons(t);
    const waits = linkedTask(t.dependsOn, all, ref);
    const blocks = all.filter((x) => x.ref !== ref && x.dependsOn && similar(x.dependsOn, t.text) >= 0.5 && !x.done);
    const subs = o.subtasks || [];
    if (!$("tmShade")) { const s = document.createElement("div"); s.id = "tmShade"; s.className = "tm-shade"; s.onclick = closeDrawer; document.body.appendChild(s); }
    let d = $("tmDrawer");
    if (!d) { d = document.createElement("aside"); d.id = "tmDrawer"; d.className = "tm-drawer"; document.body.appendChild(d); }
    d.innerHTML = `
      <div class="tm-d-top">
        <select id="tdStage">${[...STAGES.filter(([k]) => k !== "review"), ["cancelled", "Cancelled"]].map(([k, l]) => `<option value="${k}" ${st === k ? "selected" : ""}>${l}</option>`).join("")}${st === "review" ? `<option value="review" selected>Needs review</option>` : ""}</select>
        <button class="btn ghost sm" id="tdClose">✕</button>
      </div>
      <textarea class="tm-d-title" id="tdTitle" rows="2">${esc(titleOf(o))}</textarea>
      ${reasons.length ? `<div class="tm-review"><div class="kick">Gather wasn't sure</div><div>${esc(reasons.join(" · "))}</div>
        <div class="row"><button class="btn primary sm" id="tdConfirm">Confirm task</button><button class="btn ghost sm" id="tdReject">Not a task</button></div></div>` : ""}
      <div class="tm-fields">
        <label>Owner<input id="tdOwner" value="${esc(o.owner || "")}" placeholder="${t.manual ? "You" : "Unassigned"}" /></label>
        <label>Due date<input type="date" id="tdDue" value="${t.due ? A.isoDate(t.due) : ""}" /></label>
        <label>Priority<select id="tdPrio"><option value="">None</option>${["high", "medium", "low"].map((p) => `<option value="${p}" ${o.priority === p ? "selected" : ""}>${p[0].toUpperCase() + p.slice(1)}</option>`).join("")}</select></label>
        <label>Assigned by<input value="${esc(o.assigned_by || (t.manual ? "You" : "—"))}" disabled /></label>
      </div>
      ${o.priority_reason ? `<div class="muted small">Priority reason: ${esc(o.priority_reason)}</div>` : ""}

      <div class="tm-sec"><div class="kick">Source</div>
        ${t.manual ? `<div class="muted">Personal task, added by you.</div>` : `
        <div><a class="from" href="#/meeting/${esc(t.meetingId)}">${esc(t.meetingTitle)}</a> <span class="muted small">· ${esc(A.fmtDate(t.meetingDate))}</span></div>
        ${o.evidence?.quote ? `<div class="tm-quote">“${esc(o.evidence.quote)}”<span>${esc(o.evidence.speaker || "")}${typeof o.confidence === "number" ? ` · ${Math.round(o.confidence * 100)}% sure` : ""}${o.status ? ` · ${esc(o.status)}` : ""}</span></div>` : `<div class="muted small">No quote recorded for this task.</div>`}`}
      </div>

      <div class="tm-sec"><div class="kick">Dependencies</div>
        <label class="tm-inline">Waits on<input id="tdDepends" value="${esc(o.depends_on || "")}" placeholder="Nothing" /></label>
        ${waits ? `<div class="tm-link" data-open="${esc(waits.ref)}">Linked task: ${esc(waits.text)} <span class="tag tm-stage-${stageOf(waits)}">${esc(STAGE_LABEL[stageOf(waits)])}</span></div>` : ""}
        ${blocks.length ? `<div class="muted small" style="margin-top:8px">Blocks:</div>${blocks.map((b) => `<div class="tm-link" data-open="${esc(b.ref)}">${esc(b.text)} <span class="muted small">· ${esc(b.owner || "You")}</span></div>`).join("")}` : `<div class="muted small" style="margin-top:6px">Doesn't block other tasks.</div>`}
      </div>

      <div class="tm-sec"><div class="kick">Subtasks ${subs.length ? `<span>${subs.filter((s) => s.done).length}/${subs.length}</span>` : ""}</div>
        ${subs.map((s, i) => `<div class="tm-sub"><input type="checkbox" data-sub="${i}" ${s.done ? "checked" : ""} /><span class="${s.done ? "done" : ""}">${esc(s.text)}</span><button class="tm-x" data-subx="${i}" title="Remove">✕</button></div>`).join("")}
        <form id="tdSubForm" class="tm-subadd"><input id="tdSubText" placeholder="Add a step…" maxlength="160" /><button class="btn ghost sm" type="submit">Add</button></form>
        <button class="btn ghost sm" id="tdBreak">Break down with Gather Agent</button>
      </div>

      <div class="tm-sec"><div class="kick">Notes</div><textarea id="tdNotes" class="tm-notes" placeholder="Add notes…">${esc(o.notes || "")}</textarea></div>

      <div class="tm-sec"><div class="kick">Linked items</div>
        ${(o.actions || []).length ? (o.actions || []).map((a) => `<div class="tm-act">${esc(a.label)}${a.link ? ` <a href="${esc(a.link)}" target="_blank" rel="noopener">Open ↗</a>` : ""}</div>`).join("") : `<div class="muted small">Nothing yet. Use the agent to email, schedule, post or create issues.</div>`}
        <div class="row"><button class="btn primary sm" data-agent="${esc(ref)}">${o.agent ? "Open agent work" : "Do it with Gather Agent"}</button></div>
      </div>

      <div class="tm-sec"><div class="kick">Activity</div>
        ${activityFor(t, o).map((e) => `<div class="tm-ev"><span>${esc(new Date(e.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</span>${esc(e.text)}${e.link ? ` <a href="${esc(e.link)}" target="_blank" rel="noopener">Open ↗</a>` : ""}</div>`).join("")}
      </div>`;

    const save = (fn, text) => { mutate(ref, fn, text); render(); };
    $("tdClose").onclick = closeDrawer;
    $("tdStage").onchange = (e) => { if (e.target.value !== "review") { setStage(ref, e.target.value); render(); } };
    $("tdTitle").onchange = (e) => { const v = e.target.value.trim(); if (v) save((x) => { if ("task" in x) x.task = v; else x.text = v; }, "Title edited"); };
    $("tdOwner").onchange = (e) => save((x) => { x.owner = e.target.value.trim() || null; x.reviewed = true; }, `Owner set to ${e.target.value.trim() || "unassigned"}`);
    $("tdDue").onchange = (e) => { A.setTaskDue(ref, e.target.value); save(() => {}, `Due date set to ${e.target.value || "none"}`); };
    $("tdPrio").onchange = (e) => save((x) => { x.priority = e.target.value || null; x.priority_reason = e.target.value ? "set by you" : null; }, `Priority set to ${e.target.value || "none"}`);
    $("tdDepends").onchange = (e) => save((x) => { x.depends_on = e.target.value.trim() || null; }, e.target.value.trim() ? `Now waits on: ${e.target.value.trim()}` : "Dependency removed");
    $("tdNotes").onchange = (e) => save((x) => { x.notes = e.target.value; }, "Notes updated");
    $("tdConfirm") && ($("tdConfirm").onclick = () => save((x) => { x.reviewed = true; x.status = "confirmed"; x.wf = x.wf || "todo"; }, "Confirmed by you"));
    $("tdReject") && ($("tdReject").onclick = () => { setStage(ref, "cancelled"); mutate(ref, (x) => { x.reviewed = true; }, "Marked as not a task"); render(); });
    d.querySelectorAll("[data-sub]").forEach((c) => (c.onchange = () => save((x) => { x.subtasks[+c.dataset.sub].done = c.checked; }, `${c.checked ? "Completed" : "Reopened"} step: ${subs[+c.dataset.sub].text}`)));
    d.querySelectorAll("[data-subx]").forEach((b) => (b.onclick = () => save((x) => { x.subtasks.splice(+b.dataset.subx, 1); }, "Step removed")));
    $("tdSubForm").onsubmit = (e) => { e.preventDefault(); const v = $("tdSubText").value.trim(); if (v) save((x) => { x.subtasks = [...(x.subtasks || []), { text: v, done: false }]; }, `Step added: ${v}`); };
    $("tdBreak").onclick = async (e) => {
      const b = e.currentTarget; b.disabled = true; b.textContent = "Thinking…";
      try {
        const r = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          task: { task: titleOf(o), owner: o.owner || "You", assigned_by: o.assigned_by || null, deadline: o.deadline || o.due_date || null, meeting: t.meetingTitle || "personal task" },
          context: A.agentContext(), user_name: A.Profile.get().name || "", today: A.todayString() }) });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
        const steps = (data.plan || []).filter(Boolean).slice(0, 8);
        if (!steps.length) throw new Error("The agent didn't return steps. Try again.");
        save((x) => { x.subtasks = [...(x.subtasks || []), ...steps.map((s) => ({ text: String(s), done: false }))]; data.at = Date.now(); x.agent = x.agent || data; }, `Gather Agent added ${steps.length} steps`);
        A.toast(`Added ${steps.length} steps`);
      } catch (err) { A.toast(err.message, "error"); b.disabled = false; b.textContent = "Break down with Gather Agent"; }
    };
  }

  // open from list rows / timeline / links
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-open]");
    if (el && (view.contains(el) || el.closest("#tmDrawer"))) { e.preventDefault(); openDrawer(el.dataset.open); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ui.open) closeDrawer(); });
  // the agent window opens above everything: close the panel when it is launched from here
  document.addEventListener("click", (e) => { if (e.target.closest("#tmDrawer [data-agent]")) setTimeout(closeDrawer, 0); });

  // ---------------------------------------------------------------- styles (Gather theme)
  const css = document.createElement("style");
  css.textContent = `
    #view-tasks .hero { align-items: flex-end; }
    .tm-quick { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 4px 0 14px; }
    .tm-quick input { flex: 1; min-width: 320px; background: transparent; border: none; border-bottom: 1px solid rgba(244,237,225,.25); color: var(--ivory,#f4ede1);
      font: 400 19px var(--serif, Georgia, serif); padding: 8px 2px; }
    .tm-quick input:focus { outline: none; border-bottom-color: var(--gold,#d8b77c); }
    .tm-parse { flex-basis: 100%; display: flex; gap: 6px; flex-wrap: wrap; min-height: 4px; }
    .tm-filters { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; padding: 10px 0 14px; border-bottom: 1px solid var(--line); margin-bottom: 18px; }
    .tm-filters select, .tm-filters input:not([type]), .tm-bulk select, .tm-bulk input, .tm-listbar select {
      background: transparent; border: none; border-bottom: 1px solid rgba(244,237,225,.2); color: var(--text); font: 13px Inter, sans-serif; padding: 6px 2px; color-scheme: dark; }
    .tm-filters input:not([type]) { min-width: 200px; }
    .tm-check { font: 600 9.5px Inter, sans-serif; letter-spacing: .18em; text-transform: uppercase; color: var(--muted); display: flex; gap: 6px; align-items: center; }
    .tm-bulk { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; padding: 10px 14px; margin-bottom: 14px; border: 1px solid rgba(216,183,124,.35); background: rgba(216,183,124,.05); }
    .tm-bulk b { font: 500 18px var(--serif, Georgia, serif); color: var(--gold,#d8b77c); }
    .tm-board { display: grid; grid-template-columns: repeat(5, minmax(210px, 1fr)); gap: 14px; align-items: start; overflow-x: auto; padding-bottom: 10px; }
    .tm-col { border-top: 1px solid var(--line); min-height: 240px; transition: background .2s; }
    .tm-col.over { background: rgba(216,183,124,.06); border-top-color: var(--gold,#d8b77c); }
    .tm-col-head { display: flex; justify-content: space-between; align-items: baseline; padding: 12px 2px; font: 600 10px Inter, sans-serif; letter-spacing: .24em; text-transform: uppercase; color: var(--muted); }
    .tm-col[data-stage="review"] .tm-col-head { color: var(--gold,#d8b77c); }
    .tm-col-head b { font: 500 20px var(--serif, Georgia, serif); color: var(--ivory,#f4ede1); letter-spacing: 0; }
    .tm-col-body { display: flex; flex-direction: column; gap: 10px; }
    .tm-card { background: rgba(244,237,225,.035); border: 1px solid var(--line); border-left: 2px solid transparent; padding: 12px 12px 10px; cursor: grab; transition: border-color .2s, transform .2s; }
    .tm-card:hover { border-color: rgba(216,183,124,.4); }
    .tm-card.dragging { opacity: .45; }
    .tm-card.prio-line-high { border-left-color: #f0a597; } .tm-card.prio-line-medium { border-left-color: var(--gold,#d8b77c); } .tm-card.prio-line-low { border-left-color: rgba(244,237,225,.25); }
    .tm-card-title { font: 500 17px/1.3 var(--serif, Georgia, serif); color: var(--ivory,#f4ede1); margin-bottom: 8px; }
    .tm-card .sub { display: flex; gap: 6px; flex-wrap: wrap; }
    .tm-card-foot { margin-top: 8px; font: 600 9px Inter, sans-serif; letter-spacing: .14em; text-transform: uppercase; color: rgba(239,232,220,.4); }
    .tm-why { margin-top: 6px; font: italic 400 14px var(--serif, Georgia, serif); color: var(--gold,#d8b77c); }
    .tm-empty { font: italic 400 15px var(--serif, Georgia, serif); color: var(--muted); padding: 10px 2px; }
    .tm-cancelled { margin-top: 20px; }
    .tm-mini { padding: 8px 2px; border-bottom: 1px solid var(--line); color: var(--muted); text-decoration: line-through; cursor: pointer; }
    .tm-listbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .tm-table { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
    .tm-table th { text-align: left; font: 600 9px Inter, sans-serif; letter-spacing: .2em; text-transform: uppercase; color: var(--muted); padding: 8px 8px; border-bottom: 1px solid var(--line); }
    .tm-table td { padding: 11px 8px; border-bottom: 1px solid var(--line); font-size: 13px; vertical-align: top; }
    .tm-table tr.sel td { background: rgba(216,183,124,.05); }
    .tm-table .tm-t { font: 500 17px/1.3 var(--serif, Georgia, serif); color: var(--ivory,#f4ede1); cursor: pointer; }
    .tm-table .tm-t:hover { color: var(--gold,#d8b77c); }
    .tm-stage-done { color: var(--good) !important; } .tm-stage-blocked { color: #e8b58c !important; } .tm-stage-in_progress { color: #cfe3e6 !important; }
    .tm-stage-review { color: var(--gold,#d8b77c) !important; } .tm-stage-cancelled { color: var(--muted) !important; }
    .tm-timeline { display: flex; flex-direction: column; gap: 4px; }
    .tm-day { display: grid; grid-template-columns: 220px 1fr; gap: 20px; padding: 14px 0; border-bottom: 1px solid var(--line); }
    .tm-day-label { font: 500 20px var(--serif, Georgia, serif); color: var(--ivory,#f4ede1); }
    .tm-day-label span { color: var(--muted); font-size: 15px; } .tm-day-label.bad { color: var(--bad); } .tm-day-label.gold { color: var(--gold,#d8b77c); }
    .tm-line { display: flex; align-items: baseline; gap: 10px; padding: 5px 0; cursor: pointer; }
    .tm-line:hover .tm-line-t { color: var(--gold,#d8b77c); }
    .tm-line-t { font: 500 17px var(--serif, Georgia, serif); color: var(--ivory,#f4ede1); }
    .tm-line-m { font: 600 9px Inter, sans-serif; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
    .tm-dot { width: 7px; height: 7px; border-radius: 50%; background: rgba(244,237,225,.3); flex: none; transform: translateY(-2px); }
    .tm-dot.prio-high { background: #f0a597; } .tm-dot.prio-medium { background: var(--gold,#d8b77c); }
    .tm-shade { position: fixed; inset: 0; background: rgba(5,4,3,.5); z-index: 54; }
    .tm-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(500px, 94vw); z-index: 55; background: #120f0d; border-left: 1px solid var(--line);
      overflow-y: auto; padding: 22px 26px 40px; box-shadow: -30px 0 80px rgba(0,0,0,.5); animation: tmIn .25s ease; }
    @keyframes tmIn { from { transform: translateX(30px); opacity: 0; } }
    .tm-d-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .tm-d-top select { background: transparent; border: 1px solid rgba(216,183,124,.5); color: var(--gold,#d8b77c); font: 600 10px Inter, sans-serif; letter-spacing: .2em; text-transform: uppercase; padding: 7px 10px; color-scheme: dark; }
    .tm-d-title { width: 100%; background: transparent; border: none; resize: none; color: var(--ivory,#f4ede1); font: 500 28px/1.15 var(--serif, Georgia, serif); padding: 0; }
    .tm-d-title:focus { outline: none; }
    .tm-review { margin: 12px 0; padding: 12px 14px; border-left: 2px solid var(--gold,#d8b77c); background: rgba(216,183,124,.06); font: italic 400 16px var(--serif, Georgia, serif); color: var(--accent-2); }
    .tm-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 18px; margin: 16px 0 6px; }
    .tm-fields label, .tm-inline { display: flex; flex-direction: column; gap: 4px; font: 600 9px Inter, sans-serif; letter-spacing: .2em; text-transform: uppercase; color: var(--muted); }
    .tm-fields input, .tm-fields select, .tm-inline input { background: transparent; border: none; border-bottom: 1px solid rgba(244,237,225,.22); color: var(--ivory,#f4ede1);
      font: 400 15px Inter, sans-serif; letter-spacing: 0; text-transform: none; padding: 6px 2px; color-scheme: dark; }
    .tm-fields input:disabled { opacity: .6; }
    .tm-sec { margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--line); }
    .tm-sec .kick, .tm-review .kick { font: 600 10px Inter, sans-serif; font-style: normal; letter-spacing: .26em; text-transform: uppercase; color: var(--gold,#d8b77c); margin-bottom: 10px; }
    .tm-sec .kick span { color: var(--muted); margin-left: 6px; }
    .tm-quote { margin-top: 10px; padding-left: 12px; border-left: 1px solid rgba(216,183,124,.5); font: italic 400 17px/1.45 var(--serif, Georgia, serif); color: rgba(239,232,220,.8); }
    .tm-quote span { display: block; font: 600 9px Inter, sans-serif; font-style: normal; letter-spacing: .18em; text-transform: uppercase; color: var(--muted); margin-top: 4px; }
    .tm-link { margin-top: 8px; padding: 8px 10px; border: 1px solid var(--line); cursor: pointer; font: 500 15px var(--serif, Georgia, serif); color: var(--ivory,#f4ede1); }
    .tm-link:hover { border-color: rgba(216,183,124,.45); }
    .tm-sub { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 14px; }
    .tm-sub span { flex: 1; } .tm-sub span.done { text-decoration: line-through; color: var(--muted); }
    .tm-x { background: none; border: none; color: var(--muted); cursor: pointer; }
    .tm-subadd { display: flex; gap: 8px; margin: 10px 0; }
    .tm-subadd input { flex: 1; background: transparent; border: none; border-bottom: 1px solid rgba(244,237,225,.22); color: var(--text); padding: 6px 2px; font: 14px Inter, sans-serif; }
    .tm-notes { width: 100%; min-height: 90px; background: rgba(244,237,225,.03); border: 1px solid var(--line); color: var(--text); padding: 10px; font: 14px/1.55 Inter, sans-serif; resize: vertical; }
    .tm-act { padding: 6px 0; font-size: 13.5px; } .tm-act a, .tm-ev a { color: var(--gold,#d8b77c); }
    .tm-ev { display: grid; grid-template-columns: 110px 1fr; gap: 10px; padding: 6px 0; font-size: 13.5px; border-bottom: 1px solid var(--line); }
    .tm-ev span { font: 600 9px Inter, sans-serif; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); padding-top: 3px; }
  `;
  document.head.appendChild(css);

  // ---------------------------------------------------------------- wiring
  document.addEventListener("aether:route", (e) => { if (e.detail.view === "tasks") render(); else closeDrawer(); });
  setTimeout(() => { if (A.route.view === "tasks") render(); }, 0);
})();
