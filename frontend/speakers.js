// Gather: name transcript speakers from the shared screen (additive, self-contained).
// While "Speaker A" is talking we grab one frame of the shared meeting screen (the meeting app highlights the
// active speaker then); the server-side vision model reads that person's name. After two matching reads the
// label is mapped (Speaker A -> Priya) in the live transcript and in the saved meeting (transcript + tasks).
// Works whenever a screen/tab is shared (recording not required). Names can still be edited by clicking them.
(() => {
  const A = window.AETHER;
  if (!A) return;
  const $ = (id) => document.getElementById(id);
  const LABEL = /^Speaker [A-Z0-9]{1,3}$/;
  const MAX_TRIES = 3, MIN_GAP_MS = 2500, NEED_VOTES = 2;

  // ---------------------------------------------------------------- per-meeting speaker map (own storage key)
  const mapKey = () => `aether.u.${A.user ? A.user.id : "anon"}.speakermap`;
  const allMaps = () => { try { return JSON.parse(localStorage.getItem(mapKey()) || "{}"); } catch { return {}; } };
  const mapFor = (id) => allMaps()[id] || {};
  function saveMap(id, map) { const all = allMaps(); all[id] = map; try { localStorage.setItem(mapKey(), JSON.stringify(all)); } catch {} }

  // apply a meeting's map to a meeting object (transcript + extracted items)
  function applyMap(m) {
    if (!m || !m.id) return m;
    const map = mapFor(m.id);
    if (!Object.keys(map).length) return m;
    const sw = (v) => (v && map[v]) || v;
    (m.turns || []).forEach((t) => { t.speaker = sw(t.speaker); });
    (m.suggestions || []).forEach((s) => { s.speaker = sw(s.speaker); });
    for (const cat of Object.keys(m.state || {})) for (const it of m.state[cat] || []) {
      for (const f of ["owner", "assigned_by", "who", "to_whom", "decided_by"]) if (it[f]) it[f] = sw(it[f]);
      if (it.evidence && it.evidence.speaker) it.evidence.speaker = sw(it.evidence.speaker);
    }
    return m;
  }
  // every meeting save goes through Store.save: keep saved data consistent with the identified names
  const origSave = A.Store.save.bind(A.Store);
  A.Store.save = (m) => origSave(applyMap(m));

  // ---------------------------------------------------------------- live capture state
  let meetingId = null, video = null, canvas = null, observer = null;
  let votes = {}, tries = {}, lastCall = 0, inflight = false;
  const frames = new WeakMap(); // turn element -> frame captured while that person was speaking

  function grab() {
    if (!video || !video.videoWidth) return null;
    canvas = canvas || document.createElement("canvas");
    const w = Math.min(1280, video.videoWidth), h = Math.round((video.videoHeight / video.videoWidth) * w);
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(video, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.72);
  }
  const initials = (n) => { const p = String(n).trim().split(/\s+/); return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : (p[0] || "?")[1] || "")).toUpperCase(); };
  function relabelLive(label, name) {
    document.querySelectorAll("#transcript .turn").forEach((el) => {
      const who = el.querySelector(".who");
      if (who && who.textContent.trim() === label) {
        who.textContent = name; who.title = `${label}, name read from the shared screen`;
        const av = el.querySelector(".avatar"); if (av) av.textContent = initials(name);
      }
    });
  }

  async function identify(label, frame) {
    if (inflight || Date.now() - lastCall < MIN_GAP_MS) return;
    inflight = true; lastCall = Date.now();
    tries[label] = (tries[label] || 0) + 1;
    try {
      const r = await fetch("/api/ocr/speaker", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: frame }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.speaker || d.confidence < 0.5) return;
      const name = d.speaker.trim();
      const used = Object.values(mapFor(meetingId));
      if (used.includes(name)) return; // another voice already has this name
      votes[label] = votes[label] || {};
      votes[label][name] = (votes[label][name] || 0) + 1;
      if (votes[label][name] >= NEED_VOTES || (d.confidence >= 0.9 && tries[label] >= MAX_TRIES)) {
        const map = mapFor(meetingId); map[label] = name; saveMap(meetingId, map);
        relabelLive(label, name);
        A.toast(`${label} identified as ${name} (read from the shared screen). Click a name to change it.`);
      }
    } catch { /* network hiccup: try again on the next turn */ }
    finally { inflight = false; }
  }

  function onTranscriptChange() {
    if (!meetingId) return;
    const map = mapFor(meetingId);
    document.querySelectorAll("#transcript .turn").forEach((el) => {
      if (el.classList.contains("me")) return;
      if (el.classList.contains("partial")) { if (!frames.has(el)) { const f = grab(); if (f) frames.set(el, f); } return; }
      const who = el.querySelector(".who"); if (!who) return;
      const label = who.textContent.trim();
      if (map[label]) { relabelLive(label, map[label]); return; }
      if (!LABEL.test(label) || el.dataset.spkChecked) return;
      el.dataset.spkChecked = "1";
      if ((tries[label] || 0) >= MAX_TRIES) return;
      const frame = frames.get(el) || grab();
      if (frame) identify(label, frame);
    });
  }

  document.addEventListener("aether:capture-started", (e) => {
    const display = (e.detail.streams || []).find((s) => s.getVideoTracks().length);
    meetingId = e.detail.meetingId; votes = {}; tries = {}; lastCall = 0;
    if (!display) { video = null; return; } // no screen shared: nothing to read names from
    video = document.createElement("video");
    video.muted = true; video.playsInline = true;
    video.srcObject = new MediaStream(display.getVideoTracks());
    video.play().catch(() => {});
    const box = $("transcript");
    if (observer) observer.disconnect();
    observer = new MutationObserver(onTranscriptChange);
    observer.observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  });
  document.addEventListener("aether:capture-stopping", () => {
    setTimeout(() => { if (observer) observer.disconnect(); observer = null; if (video) video.srcObject = null; video = null; }, 1500);
  });
  // after the meeting is summarised, make sure the saved copy carries the names (and refresh the page)
  document.addEventListener("aether:summary-ready", (e) => {
    const m = A.Store.get(e.detail.id);
    if (m && Object.keys(mapFor(m.id)).length) { A.Store.save(m); A.rerender(); }
  });
})();
