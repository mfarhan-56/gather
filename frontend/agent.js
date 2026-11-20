// AETHER Agent: real app actions (Composio: Gmail + Google Calendar).
// Uses only the public window.AETHER API from app.js and the "aether:agent-rendered" event.
// Every action runs ONLY after the user clicks and confirms (human-in-the-loop).
(() => {
  const A = window.AETHER;
  if (!A) return;
  const esc = A.esc;
  let status = { enabled: false, connected: {} };
  const APP_LABEL = { gmail: "Gmail", googlecalendar: "Google Calendar", slack: "Slack", notion: "Notion", googledocs: "Google Docs", github: "GitHub" };
  const lookupCache = {};
  async function options(what) {
    if (lookupCache[what]) return lookupCache[what];
    const { options } = await api("lookup", { user: uid(), what });
    lookupCache[what] = options;
    return options;
  }
  function needConnect(app) {
    if (status.connected[app]) return false;
    A.toast(`Connect ${APP_LABEL[app]} first: Settings → Connected apps.`, "warn");
    return true;
  }
  function doneLink(label, link) {
    return link ? `${label} <a href="${A.esc(link)}" target="_blank" rel="noopener">Open ↗</a>` : label;
  }

  const uid = () => A.user && A.user.id;

  async function api(path, body) {
    const r = await fetch("/api/composio/" + path, body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : undefined);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) throw new Error(data.error || "HTTP " + r.status);
    return data;
  }

  async function refreshStatus() {
    if (!uid()) return status;
    try { status = await api("status?user=" + encodeURIComponent(uid())); }
    catch (e) { status = { enabled: true, connected: {}, error: e.message }; }
    renderSettingsPanel();
    return status;
  }

  // ------------------------------------------------------------------
  // Settings → Connected apps
  // ------------------------------------------------------------------
  function ensureSettingsPanel() {
    const grid = document.querySelector("#view-settings .settings-grid");
    if (!grid || document.getElementById("appsPanel")) return;
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.id = "appsPanel";
    grid.prepend(panel);
  }
  function renderSettingsPanel() {
    ensureSettingsPanel();
    const p = document.getElementById("appsPanel");
    if (!p) return;
    if (!status.enabled) {
      p.innerHTML = `<div class="panel-head"><h2>⚡ Connected apps</h2></div>
        <p class="muted small">App actions are not configured on this server (missing COMPOSIO_API_KEY).</p>`;
      return;
    }
    const row = (key, label, icon) => {
      const on = !!status.connected[key];
      return `<div class="app-row">
        <span>${icon} <b>${label}</b></span>
        ${on ? `<span class="tag confirmed">Connected</span>` : `<button class="btn primary sm" data-connect="${key}">Connect</button>`}
      </div>`;
    };
    p.innerHTML = `<div class="panel-head"><h2>⚡ Connected apps</h2><button class="btn ghost sm" id="appsRefresh">↻ Refresh</button></div>
      <p class="muted small">Let AETHER Agent act for you. It only ever acts after you click and confirm.</p>
      ${row("gmail", "Gmail", "✉")}
      ${row("googlecalendar", "Google Calendar", "📅")}
      ${row("slack", "Slack", "💬")}
      ${row("notion", "Notion", "📓")}
      ${row("googledocs", "Google Docs", "📄")}
      ${row("github", "GitHub", "🐙")}
      ${status.error ? `<p class="muted small">⚠ ${esc(status.error)}</p>` : ""}
      <p class="muted small">Google's permission screen will show "Composio", our secure integration partner.</p>`;
    p.querySelector("#appsRefresh").onclick = () => refreshStatus().then(() => A.toast("Connections refreshed"));
    p.querySelectorAll("[data-connect]").forEach((b) => (b.onclick = () => connect(b.dataset.connect)));
  }

  async function connect(toolkit) {
    try {
      const { redirect_url } = await api("connect", { user: uid(), toolkit });
      window.open(redirect_url, "_blank", "noopener");
      A.toast("Finish signing in on the Google tab, then come back here.");
      // poll for the new connection for ~2 minutes
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        await refreshStatus();
        if (status.connected[toolkit]) { A.toast((APP_LABEL[toolkit] || toolkit) + " connected ✓"); return; }
      }
    } catch (e) {
      A.toast("Could not start the connection: " + e.message, "error");
    }
  }

  window.addEventListener("hashchange", () => { if (location.hash === "#/settings") refreshStatus(); });
  if (location.hash === "#/settings") setTimeout(refreshStatus, 300);

  // ------------------------------------------------------------------
  // Agent window → real actions
  // ------------------------------------------------------------------
  function logAction(ref, entry) {
    const t = A.findTaskTarget(ref);
    if (!t) return;
    t.obj.actions = [...(t.obj.actions || []), { ...entry, at: Date.now() }];
    t.save();
  }
  function knownEmail(text) {
    const m = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(text || "");
    return m && JSON.stringify(A.agentContext()).includes(m[0]) ? m[0] : "";
  }
  function localInput(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  document.addEventListener("aether:agent-rendered", async (e) => {
    const { data, ref, body } = e.detail || {};
    if (!body || !data) return;
    await refreshStatus();
    const t = ref ? A.findTaskTarget(ref) : null;

    // history of executed actions for this task
    const done = (t && t.obj.actions) || [];
    if (done.length) {
      const h = document.createElement("div");
      h.className = "agent-done";
      h.innerHTML = `<h2>✔ Actions taken</h2><ul>${done.map((x) =>
        `<li>${doneLink(esc(x.label), x.link)} <span class="muted small">· ${esc(new Date(x.at).toLocaleString())}</span></li>`).join("")}</ul>`;
      body.prepend(h);
    }

    // per-output Gmail actions
    (data.outputs || []).forEach((o, i) => {
      if (o.type !== "email") return;
      const card = body.querySelector(`textarea[data-out="${i}"]`)?.closest(".agent-out");
      if (!card) return;
      const box = document.createElement("div");
      box.className = "agent-actions";
      box.innerHTML = `
        <div class="act-row">
          <label>To <input type="email" class="act-to" placeholder="recipient@example.com" value="${esc(knownEmail(o.to))}" /></label>
          <label>Subject <input class="act-subject" value="${esc(o.subject || o.title || "")}" /></label>
        </div>
        <div class="row">
          <button class="btn ghost sm" data-act="gmail_draft">📝 Save as Gmail draft</button>
          <button class="btn primary sm" data-act="gmail_send">✉ Send via Gmail</button>
          ${status.connected.gmail ? "" : `<span class="muted small">Connect Gmail in Settings first.</span>`}
        </div>`;
      card.appendChild(box);
      box.querySelectorAll("[data-act]").forEach((b) => (b.onclick = async () => {
        const action = b.dataset.act;
        const to = box.querySelector(".act-to").value.trim();
        const subject = box.querySelector(".act-subject").value.trim();
        const text = card.querySelector("textarea").value;
        if (!status.connected.gmail) return A.toast("Connect Gmail first: Settings → Connected apps.", "warn");
        if (action === "gmail_send") {
          if (!to) return A.toast("Enter the recipient's email address.", "warn");
          if (/\[[A-Z][A-Z \-_/]+\]/.test(text) && !confirm("This email still contains placeholders like [PRICE]. Send anyway?")) return;
          if (!confirm(`Send this email to ${to} from your Gmail now?`)) return;
        }
        b.disabled = true;
        const old = b.textContent;
        b.textContent = "Working…";
        try {
          await api("execute", { user: uid(), action, args: { to, subject, body: text } });
          const label = action === "gmail_send" ? `Email sent to ${to}: “${subject}”` : `Gmail draft saved: “${subject}”`;
          logAction(ref, { type: action, label });
          A.toast(action === "gmail_send" ? "Email sent ✓" : "Draft saved in Gmail ✓");
          b.textContent = action === "gmail_send" ? "✓ Sent" : "✓ Draft saved";
        } catch (err) {
          A.toast(err.message, "error");
          b.disabled = false;
          b.textContent = old;
        }
      }));
    });

    // every draft → Slack / Notion / Google Docs
    (data.outputs || []).forEach((o, i) => {
      const card = body.querySelector(`textarea[data-out="${i}"]`)?.closest(".agent-out");
      if (!card) return;
      const ex = document.createElement("div");
      ex.className = "agent-actions";
      ex.innerHTML = `
        <div class="muted small" style="margin-bottom:6px">Send this ${esc(o.type || "draft")} to an app:</div>
        <div class="row wrap">
          <button class="btn ghost sm" data-x="slack">💬 Slack</button>
          <button class="btn ghost sm" data-x="notion">📓 Notion page</button>
          <button class="btn ghost sm" data-x="googledocs">📄 Google Doc</button>
        </div>
        <div class="x-form"></div>`;
      card.appendChild(ex);
      const form = ex.querySelector(".x-form");
      const text = () => card.querySelector("textarea").value;
      const title = () => (o.subject || o.title || (t && (t.obj.task || t.obj.text)) || "AETHER draft").slice(0, 180);

      async function picker(what, labelText, placeholder) {
        form.innerHTML = `<div class="act-row"><label>${labelText}<select class="x-select"><option>Loading…</option></select></label></div>`;
        const sel = form.querySelector(".x-select");
        try {
          const opts = await options(what);
          sel.innerHTML = opts.length
            ? opts.map((x) => `<option value="${esc(x.value)}">${esc(x.label)}</option>`).join("")
            : `<option value="">${placeholder}</option>`;
        } catch (err) { sel.innerHTML = `<option value="">${esc(err.message)}</option>`; }
        return sel;
      }
      async function run(btn, action, args, label) {
        btn.disabled = true; const old = btn.textContent; btn.textContent = "Working…";
        try {
          const r = await api("execute", { user: uid(), action, args });
          logAction(ref, { type: action, label, link: r.link || null });
          form.innerHTML = `<div class="x-done">✓ ${doneLink(esc(label), r.link)}</div>`;
          A.toast(label + " ✓");
        } catch (err) { A.toast(err.message, "error"); btn.disabled = false; btn.textContent = old; }
      }

      ex.querySelector('[data-x="slack"]').onclick = async () => {
        if (needConnect("slack")) return;
        const sel = await picker("slack_channels", "Channel", "No channels found");
        form.insertAdjacentHTML("beforeend", `<div class="row"><button class="btn primary sm x-go">Post to Slack</button></div>`);
        form.querySelector(".x-go").onclick = (ev) => {
          const ch = sel.value, name = sel.options[sel.selectedIndex]?.text || ch;
          if (!ch) return A.toast("Pick a channel.", "warn");
          if (!confirm(`Post this message to ${name} in Slack now?`)) return;
          run(ev.currentTarget, "slack_message", { channel: ch, text: text() }, `Posted to Slack ${name}`);
        };
      };
      ex.querySelector('[data-x="notion"]').onclick = async () => {
        if (needConnect("notion")) return;
        const sel = await picker("notion_pages", "Create under page", "No pages shared with Composio. Share a page in Notion first.");
        form.insertAdjacentHTML("beforeend", `<div class="act-row"><label>Page title<input class="x-title" value="${esc(title())}" /></label></div>
          <div class="row"><button class="btn primary sm x-go">Create Notion page</button></div>`);
        form.querySelector(".x-go").onclick = (ev) => {
          if (!sel.value) return A.toast("Pick a parent page.", "warn");
          const tt = form.querySelector(".x-title").value.trim() || title();
          if (!confirm(`Create the Notion page “${tt}”?`)) return;
          run(ev.currentTarget, "notion_page", { parent_id: sel.value, title: tt, content: text() }, `Notion page created: “${tt}”`);
        };
      };
      ex.querySelector('[data-x="googledocs"]').onclick = () => {
        if (needConnect("googledocs")) return;
        form.innerHTML = `<div class="act-row"><label>Document title<input class="x-title" value="${esc(title())}" /></label></div>
          <div class="row"><button class="btn primary sm x-go">Create Google Doc</button></div>`;
        form.querySelector(".x-go").onclick = (ev) => {
          const tt = form.querySelector(".x-title").value.trim() || title();
          if (!confirm(`Create the Google Doc “${tt}” in your Drive?`)) return;
          run(ev.currentTarget, "google_doc", { title: tt, content: text() }, `Google Doc created: “${tt}”`);
        };
      };
    });

    // GitHub issue for this task
    const gh = document.createElement("div");
    gh.className = "agent-out";
    const ghTitle = (t && (t.obj.task || t.obj.text)) || "Task from meeting";
    const ghBody = [
      `**From AETHER** (meeting task)`, "",
      ...(data.plan?.length ? ["### Plan", ...data.plan.map((x, k) => `${k + 1}. ${x}`), ""] : []),
      ...(data.proactive?.length ? ["### Notes", ...data.proactive.map((x) => `- ${x}`)] : []),
    ].join("\n");
    gh.innerHTML = `
      <div class="agent-out-head"><b>🐙 Track it as a GitHub issue</b></div>
      <div class="row"><button class="btn ghost sm" id="ghStart">Choose repository…</button>
        ${status.connected.github ? "" : `<span class="muted small">Connect GitHub in Settings first.</span>`}</div>
      <div class="x-form" id="ghForm"></div>`;
    body.appendChild(gh);
    gh.querySelector("#ghStart").onclick = async () => {
      if (needConnect("github")) return;
      const form = gh.querySelector("#ghForm");
      form.innerHTML = `<div class="act-row"><label>Repository<select class="x-select"><option>Loading…</option></select></label>
        <label>Issue title<input class="x-title" value="${esc(ghTitle)}" /></label></div>
        <textarea class="followup-text agent-text x-body"></textarea>
        <div class="row"><button class="btn primary sm x-go">Create issue</button></div>`;
      form.querySelector(".x-body").value = ghBody;
      const sel = form.querySelector(".x-select");
      try {
        const opts = await options("github_repos");
        sel.innerHTML = opts.length ? opts.map((x) => `<option value="${esc(x.value)}">${esc(x.label)}</option>`).join("") : `<option value="">No repositories found</option>`;
      } catch (err) { sel.innerHTML = `<option value="">${esc(err.message)}</option>`; }
      form.querySelector(".x-go").onclick = async (ev) => {
        const repo = sel.value, tt = form.querySelector(".x-title").value.trim();
        if (!repo || !tt) return A.toast("Pick a repository and enter a title.", "warn");
        if (!confirm(`Create issue “${tt}” in ${repo}?`)) return;
        const b = ev.currentTarget; b.disabled = true; b.textContent = "Working…";
        try {
          const r = await api("execute", { user: uid(), action: "github_issue", args: { repo, title: tt, body: form.querySelector(".x-body").value } });
          const label = `GitHub issue created in ${repo}: “${tt}”`;
          logAction(ref, { type: "github_issue", label, link: r.link || null });
          form.innerHTML = `<div class="x-done">✓ ${doneLink(esc(label), r.link)}</div>`;
          A.toast("GitHub issue created ✓");
        } catch (err) { A.toast(err.message, "error"); b.disabled = false; b.textContent = "Create issue"; }
      };
    };

    // calendar event for this task
    const cal = document.createElement("div");
    cal.className = "agent-out";
    const start = new Date(Date.now() + 86400000); start.setHours(10, 0, 0, 0);
    const taskText = (t && (t.obj.task || t.obj.text)) || "Follow-up";
    cal.innerHTML = `
      <div class="agent-out-head"><b>📅 Schedule it in Google Calendar</b></div>
      <div class="act-row">
        <label>Title <input class="cal-title" value="${esc(taskText)}" /></label>
        <label>Start <input type="datetime-local" class="cal-start" value="${localInput(start)}" /></label>
        <label>Minutes <input type="number" class="cal-min" value="30" min="5" max="480" step="5" /></label>
      </div>
      <div class="act-row">
        <label>Invite (emails, optional) <input class="cal-att" placeholder="a@x.com, b@y.com" /></label>
      </div>
      <div class="row">
        <button class="btn primary sm" id="calCreate">📅 Create event</button>
        ${status.connected.googlecalendar ? "" : `<span class="muted small">Connect Google Calendar in Settings first.</span>`}
      </div>`;
    body.appendChild(cal);
    cal.querySelector("#calCreate").onclick = async (ev) => {
      const b = ev.currentTarget;
      if (!status.connected.googlecalendar) return A.toast("Connect Google Calendar first: Settings → Connected apps.", "warn");
      const title = cal.querySelector(".cal-title").value.trim() || taskText;
      const startVal = cal.querySelector(".cal-start").value;
      const minutes = Math.max(5, parseInt(cal.querySelector(".cal-min").value || "30", 10));
      const attendees = cal.querySelector(".cal-att").value.trim();
      if (!startVal) return A.toast("Pick a start time.", "warn");
      if (!confirm(`Create “${title}” on ${new Date(startVal).toLocaleString()}${attendees ? " and invite " + attendees : ""}?`)) return;
      b.disabled = true; b.textContent = "Working…";
      try {
        const r = await api("execute", { user: uid(), action: "calendar_event", args: {
          title, start: startVal, hours: Math.floor(minutes / 60), minutes: minutes % 60,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          attendees, notify: !!attendees, meet: true,
          description: `Created by AETHER from task: ${taskText}`,
        } });
        logAction(ref, { type: "calendar_event", label: `Calendar event created: “${title}” (${new Date(startVal).toLocaleString()})`, link: r.link || null });
        A.toast("Event created in Google Calendar ✓");
        b.textContent = "✓ Created";
      } catch (err) {
        A.toast(err.message, "error");
        b.disabled = false; b.textContent = "📅 Create event";
      }
    };
  });

  // styles (kept here so this feature stays self-contained)
  const css = document.createElement("style");
  css.textContent = `
    .app-row { display:flex; justify-content:space-between; align-items:center; padding:10px 12px; border-radius:10px; background:var(--panel-2); border:1px solid var(--line); margin-bottom:8px; }
    .agent-actions { margin-top:10px; padding-top:10px; border-top:1px dashed var(--line); }
    .act-row { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px; }
    .act-row label { display:flex; flex-direction:column; gap:4px; font-size:11px; color:var(--muted); flex:1; min-width:150px; }
    .act-row input { background:var(--panel-2); border:1px solid var(--line); color:var(--text); padding:7px 9px; border-radius:8px; font:inherit; font-size:13px; color-scheme:dark; }
    .act-row input:focus { outline:none; border-color:rgba(139,124,255,.5); }
    .agent-done { margin-bottom:10px; padding:10px 12px; border-radius:10px; background:rgba(52,211,153,.08); border:1px solid rgba(52,211,153,.3); }
    .agent-done h2 { margin-top:0 !important; color:#a7f3d0 !important; }
    .agent-done a, .x-done a { color:var(--accent-2); }
    .row.wrap { flex-wrap:wrap; }
    .x-form { margin-top:8px; }
    .x-form select { background:var(--panel-2); border:1px solid var(--line); color:var(--text); padding:7px 9px; border-radius:8px; font:inherit; font-size:13px; color-scheme:dark; }
    .x-done { padding:8px 10px; border-radius:8px; background:rgba(52,211,153,.1); border:1px solid rgba(52,211,153,.3); color:#a7f3d0; font-size:13px; }
  `;
  document.head.appendChild(css);
})();
