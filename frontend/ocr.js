// Gather: OCR name suggestions for recording snapshots (additive, self-contained).
// Adds a "Detect names" button under each snapshot. Results are only SUGGESTIONS placed in the box;
// nothing is saved until the user clicks Accept (which uses the existing save -> "User-confirmed").
(() => {
  const A = window.AETHER;
  if (!A) return;
  function decorate() {
    document.querySelectorAll("#recPanel .snap").forEach((snap) => {
      if (snap.querySelector(".ocr-btn")) return;
      const img = snap.querySelector("img"), input = snap.querySelector("[data-snapedit]");
      if (!img || !input) return;
      const row = document.createElement("div");
      row.className = "ocr-row";
      row.innerHTML = `<button class="ts ocr-btn" type="button">Detect names</button><span class="ocr-note"></span>`;
      snap.appendChild(row);
      const btn = row.querySelector(".ocr-btn"), note = row.querySelector(".ocr-note");
      btn.onclick = async () => {
        btn.disabled = true; btn.textContent = "Reading…"; note.textContent = "";
        try {
          const r = await fetch("/api/ocr/names", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: img.src }) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
          if (!d.names.length && !d.details) { note.textContent = "No readable names found."; return; }
          input.value = [d.names.join(", "), d.details].filter(Boolean).join(" — ");
          note.innerHTML = `Suggested by OCR. Check it, then <button class="ts ocr-accept" type="button">Accept</button>`;
          note.querySelector(".ocr-accept").onclick = () => input.dispatchEvent(new Event("change")); // existing handler saves as User-confirmed
        } catch (e) {
          note.textContent = "Couldn't read names: " + e.message;
        } finally {
          btn.disabled = false; btn.textContent = "Detect names";
        }
      };
    });
  }
  new MutationObserver(decorate).observe(document.body, { childList: true, subtree: true });
  const css = document.createElement("style");
  css.textContent = `.ocr-row { margin-top: 6px; } .ocr-note { display: block; margin-top: 4px; font: italic 400 13px var(--serif, Georgia, serif); color: var(--accent-2, #e9dcc2); }
    .ocr-note .ts { margin-left: 4px; }`;
  document.head.appendChild(css);
})();
