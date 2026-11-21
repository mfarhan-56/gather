// Gather: name transcript speakers from the shared screen (additive, self-contained).
// Reasons with several clues instead of one:
//  1. reads EVERY participant name visible on the shared meeting screen (frames taken while people talk)
//  2. elimination: only one other person on screen -> every non-mic voice is that person;
//     all voices but one named -> the last voice gets the remaining name
//  3. active-speaker cue (highlighted tile / ring / sound bars / main view) -> names that voice directly
// Applied to the live transcript and the saved meeting (transcript + tasks). Click a name to change it.
(() => {
  const A = window.AETHER;
  if (!A) return;
  const $ = (id) => document.getElementById(id);
  const VOICE = /^(Speaker [A-Z0-9]{1,3}|Participant)$/;
  const MIN_GAP_MS = 2500, MAX_READS = 30;

  // ---------------------------------------------------------------- per-meeting speaker map (own storage key)
  const mapKey = () => `aether.u.${A.user ? A.user.id : "anon"}.speakermap`;
  const allMaps = () => { try { return JSON.parse(localStorage.getItem(mapKey()) || "{}"); } catch { return {}; } };
  const mapFor = (id) => allMaps()[id] || {};
  function saveMap(id, map) { const all = allMaps(); all[id] = map; try { localStorage.setItem(mapKey(), JSON.stringify(all)); } catch {} }

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
  const origSave = A.Store.save.bind(A.Store);
  A.Store.save = (m) => origSave(applyMap(m));

  // ---------------------------------------------------------------- live state
  let meetingId = null, video = null, canvas = null, observer = null;
  let reads = 0, lastCall = 0, inflight = false, votes = {}, remote = new Map(), voices = new Set(), autoKeys = new Set();
  const frames = new WeakMap();

  const me = () => (A.Profile.get().name || "").trim().toLowerCase();
  function isSelf(name, selfLabel) {
    const n = String(name || "").trim().toLowerCase();
    if (!n) return true;
    if (/^(you|me|myself)$/.test(n) || /\((you|me)\)/.test(n)) return true;
    if (selfLabel && n === String(selfLabel).trim().toLowerCase()) return true;
    const mine = me();
    return !!mine && (n === mine || n.split(/\s+/)[0] === mine.split(/\s+/)[0]);
  }
  const cleanName = (n) => String(n).replace(/\((you|me|host|presenting|guest)\)/gi, "").replace(/\s{2,}/g, " ").trim();

  function grab() {
    if (!video || !video.videoWidth) return null;
    canvas = canvas || document.createElement("canvas");
    const w = Math.min(1600, video.videoWidth), h = Math.round((video.videoHeight / video.videoWidth) * w);
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(video, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.8);
  }
  const initials = (n) => { const p = String(n).trim().split(/\s+/); return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : (p[0] || "?")[1] || "")).toUpperCase(); };
  function relabelLive() {
    const map = mapFor(meetingId);
    document.querySelectorAll("#transcript .turn").forEach((el) => {
      if (el.classList.contains("me")) return;
      const who = el.querySelector(".who"); if (!who) return;
      let label = who.dataset.voice || who.textContent.trim();
      // a line still being spoken has no voice label yet; with only one other person on screen it can only be them
      if (!map[label] && el.classList.contains("partial") && label === "Participant" && remote.size === 1) {
        const only = [...remote.keys()][0];
        if (who.textContent !== only) { who.textContent = only; const av = el.querySelector(".avatar"); if (av) av.textContent = initials(only); }
        return;
      }
      if (!map[label]) return;
      who.dataset.voice = label;
      if (who.textContent !== map[label]) {
        who.textContent = map[label]; who.title = `Name read from the shared screen (${label})`;
        const av = el.querySelector(".avatar"); if (av) av.textContent = initials(map[label]);
      }
    });
  }
  function assign(label, name, why, auto = false) {
    const map = mapFor(meetingId);
    if (map[label] === name) return;
    map[label] = name; saveMap(meetingId, map);
    if (auto) autoKeys.add(label); else autoKeys.delete(label);
    relabelLive();
    A.toast(`${label === "Participant" ? "Other speaker" : label} is ${name} (${why}). Click a name to change it.`);
  }

  // think: combine what we have read so far
  function reason() {
    const map = mapFor(meetingId);
    const names = [...remote.keys()];
    const used = new Set(Object.values(map));
    // only one other person on screen -> every non-mic voice is them
    if (names.length === 1) {
      for (const v of voices) if (!map[v]) assign(v, names[0], "the only other participant on screen", true);
      return;
    }
    // more people appeared: undo guesses that relied on "only one other person"
    if (names.length > 1) for (const k of [...autoKeys]) {
      if (k === "Participant" || Object.keys(map).filter((x) => map[x] === map[k]).length > 1) {
        delete map[k]; autoKeys.delete(k); saveMap(meetingId, map);
        document.querySelectorAll(`#transcript .who[data-voice="${k}"]`).forEach((w) => { w.textContent = k; delete w.dataset.voice; });
      }
    }
    // elimination: one voice left unnamed and exactly one name left unused
    const speakers = [...voices].filter((v) => v !== "Participant");
    const unnamed = speakers.filter((v) => !map[v]);
    const free = names.filter((n) => !used.has(n));
    if (speakers.length > 1 && unnamed.length === 1 && free.length === 1) assign(unnamed[0], free[0], "the remaining participant on screen");
  }

  async function read(label, frame) {
    if (inflight || reads >= MAX_READS || Date.now() - lastCall < MIN_GAP_MS || !frame) return;
    inflight = true; lastCall = Date.now(); reads++;
    try {
      const r = await fetch("/api/ocr/speaker", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: frame }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return;
      for (const raw of d.names || []) { const n = cleanName(raw); if (n && !isSelf(raw, d.self)) remote.set(n, (remote.get(n) || 0) + 1); }
      const spk = d.speaker && cleanName(d.speaker);
      if (label && spk && !isSelf(d.speaker, d.self) && d.confidence >= 0.55) {
        const map = mapFor(meetingId);
        if (!Object.values(map).includes(spk) || map[label] === spk) {
          votes[label] = votes[label] || {};
          votes[label][spk] = (votes[label][spk] || 0) + d.confidence;
          if (votes[label][spk] >= 0.8) assign(label, spk, d.cue ? `seen speaking: ${d.cue}` : "seen speaking on screen");
        }
      }
      reason();
    } catch { /* try again on the next turn */ }
    finally { inflight = false; }
  }

  function onTranscriptChange() {
    if (!meetingId) return;
    const map = mapFor(meetingId);
    relabelLive();
    document.querySelectorAll("#transcript .turn").forEach((el) => {
      if (el.classList.contains("me")) return;
      if (el.classList.contains("partial")) { if (!frames.has(el)) { const f = grab(); if (f) frames.set(el, f); } return; }
      const who = el.querySelector(".who"); if (!who) return;
      const label = who.dataset.voice || who.textContent.trim();
      if (!VOICE.test(label) || el.dataset.spkChecked) return;
      el.dataset.spkChecked = "1";
      voices.add(label);
      reason();
      if (!mapFor(meetingId)[label]) read(label, frames.get(el) || grab());
    });
    relabelLive(); // lines that arrived after a name was known
  }

  document.addEventListener("aether:capture-started", (e) => {
    const display = (e.detail.streams || []).find((s) => s.getVideoTracks().length);
    meetingId = e.detail.meetingId; reads = 0; lastCall = 0; votes = {}; remote = new Map(); voices = new Set(); autoKeys = new Set();
    if (!display) { video = null; return; }
    video = document.createElement("video");
    video.muted = true; video.playsInline = true;
    video.srcObject = new MediaStream(display.getVideoTracks());
    video.play().catch(() => {});
    setTimeout(() => read(null, grab()), 3000); // learn who is on screen before anyone speaks
    if (observer) observer.disconnect();
    observer = new MutationObserver(onTranscriptChange);
    observer.observe($("transcript"), { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  });
  document.addEventListener("aether:capture-stopping", () => {
    setTimeout(() => { if (observer) observer.disconnect(); observer = null; if (video) video.srcObject = null; video = null; }, 1500);
  });
  document.addEventListener("aether:summary-ready", (e) => {
    const m = A.Store.get(e.detail.id);
    if (m && Object.keys(mapFor(m.id)).length) { A.Store.save(m); A.rerender(); }
  });
})();
