// Find in the open note (⌘F) — searches the transcript pane (or the editor
// textarea when in Edit mode) plus the summary rail, with next/prev navigation
// and a match counter. Scoped to the open note only; the sidebar's ⌘K search
// stays the cross-note one.
//
// Highlighting uses the CSS Custom Highlight API, so nothing in the DOM is
// mutated: transcript segments keep their data-t offsets, .tv-active state and
// click handlers, and the summary rail is not re-rendered. Text inside the
// <textarea> can't be highlighted that way, so those hits use the native
// selection instead. Self-contained, mirroring speaker-rename.js.
(function () {
  const HL_ALL = "find-all";
  const HL_CUR = "find-cur";
  const CAN_HIGHLIGHT = !!(window.CSS && CSS.highlights && window.Highlight);
  if (!CAN_HIGHLIGHT) console.warn("[find] CSS Custom Highlight API missing, matches won't be shaded");

  injectStyles();

  let bar = null;      // the find bar, built on first open
  let input = null;
  let counter = null;
  let hits = [];       // [{ kind: "range", range } | { kind: "ta", start, len }]
  let idx = -1;
  let rescanTimer = null;

  function injectStyles() {
    const css = `
      /* An in-flow strip rather than a floating overlay: #editor-wrap is a flex
         column, so this can never cover the toolbar or the audio player. */
      #find-bar {
        flex: 0 0 auto;
        display: flex; align-items: center; justify-content: flex-end; gap: 4px;
        padding: 6px 12px; background: var(--bg-elevated);
        border-bottom: 1px solid var(--border);
      }
      #find-bar input {
        width: 180px; box-sizing: border-box; padding: 4px 7px; font-size: 12px;
        color: var(--text-primary); background: var(--bg-input, var(--bg-base));
        border: 1px solid var(--border); border-radius: 7px; outline: none;
      }
      #find-bar input:focus { border-color: var(--border-focus, var(--accent)); }
      #find-count {
        min-width: 52px; text-align: center; font-size: 11px;
        color: var(--text-muted); font-variant-numeric: tabular-nums;
      }
      #find-bar button {
        display: flex; align-items: center; justify-content: center;
        width: 22px; height: 22px; padding: 0; font-size: 12px; line-height: 1;
        color: var(--text-secondary); background: transparent;
        border: none; border-radius: 6px; cursor: pointer;
      }
      #find-bar button:hover { background: var(--bg-hover, rgba(255,255,255,0.07)); color: var(--text-primary); }
    `;
    const el = document.createElement("style");
    el.textContent = css;
    document.head.appendChild(el);
  }

  function build() {
    bar = document.createElement("div");
    bar.id = "find-bar";
    bar.innerHTML =
      `<input type="text" placeholder="Find in note…" autocomplete="off" spellcheck="false" />` +
      `<span id="find-count"></span>` +
      `<button type="button" data-find="prev" title="Previous (⇧⏎)">↑</button>` +
      `<button type="button" data-find="next" title="Next (⏎)">↓</button>` +
      `<button type="button" data-find="close" title="Close (Esc)">✕</button>`;
    const wrap = document.getElementById("editor-wrap");
    if (wrap) wrap.insertBefore(bar, document.getElementById("transcript-view"));
    else document.body.appendChild(bar);

    input = bar.querySelector("input");
    counter = bar.querySelector("#find-count");

    input.addEventListener("input", () => { scan(); goto(0); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    });
    bar.addEventListener("click", (e) => {
      const act = e.target.closest("button")?.dataset.find;
      if (act === "next") step(1);
      else if (act === "prev") step(-1);
      else if (act === "close") close();
    });

    // The rail loads asynchronously and both panes re-render on note switch, so
    // re-run the query whenever their content changes (highlighting itself does
    // not touch the DOM, so this can't loop).
    const observer = new MutationObserver(() => {
      if (!isOpen()) return;
      clearTimeout(rescanTimer);
      rescanTimer = setTimeout(() => { scan(); goto(0); }, 80);
    });
    for (const id of ["transcript-view", "summary-rail-body"]) {
      const el = document.getElementById(id);
      if (el) observer.observe(el, { childList: true, subtree: true, characterData: true });
    }
  }

  function isOpen() { return !!bar && !bar.classList.contains("hidden"); }

  const visible = (el) => !!el && !el.classList.contains("hidden");

  // All match offsets of `q` in `text`, case-insensitive.
  function offsets(text, q) {
    const hay = text.toLowerCase(), needle = q.toLowerCase();
    const out = [];
    let i = hay.indexOf(needle);
    while (i !== -1) {
      out.push(i);
      i = hay.indexOf(needle, i + needle.length);
    }
    return out;
  }

  function rangesIn(root, q) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const i of offsets(node.nodeValue, q)) {
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + q.length);
        out.push({ kind: "range", range: r });
      }
    }
    return out;
  }

  function scan() {
    hits = [];
    idx = -1;
    const q = input.value;
    if (q) {
      const view = document.getElementById("transcript-view");
      const editor = document.getElementById("editor");
      const rail = document.getElementById("summary-rail");
      const railBody = document.getElementById("summary-rail-body");

      if (visible(view)) hits.push(...rangesIn(view, q));
      else if (visible(editor)) {
        for (const start of offsets(editor.value, q)) hits.push({ kind: "ta", start, len: q.length });
      }
      if (visible(rail) && railBody) hits.push(...rangesIn(railBody, q));
    }
    paint();
  }

  function paint() {
    if (!CAN_HIGHLIGHT) return;
    const all = hits.filter(h => h.kind === "range").map(h => h.range);
    if (all.length) CSS.highlights.set(HL_ALL, new Highlight(...all));
    else CSS.highlights.delete(HL_ALL);
    const cur = hits[idx];
    if (cur && cur.kind === "range") CSS.highlights.set(HL_CUR, new Highlight(cur.range));
    else CSS.highlights.delete(HL_CUR);
  }

  function goto(n) {
    idx = hits.length ? ((n % hits.length) + hits.length) % hits.length : -1;
    const hit = hits[idx];
    if (hit?.kind === "range") {
      hit.range.startContainer.parentElement?.scrollIntoView({ block: "center" });
    } else if (hit?.kind === "ta") {
      // Focus so Chromium scrolls the textarea to the selection, then hand focus
      // back to the find input; the selection stays drawn.
      const editor = document.getElementById("editor");
      editor.focus();
      editor.setSelectionRange(hit.start, hit.start + hit.len);
      input.focus();
    }
    paint();
    counter.textContent = !input.value ? "" : hits.length ? `${idx + 1}/${hits.length}` : "No results";
  }

  function step(dir) {
    if (!hits.length) return;
    goto(idx + dir);
  }

  function open() {
    if (!bar) build();
    bar.classList.remove("hidden");
    // Seed from the current selection, the way a find bar usually does.
    const sel = String(document.getSelection() || "").trim();
    if (sel && !sel.includes("\n")) input.value = sel;
    input.focus();
    input.select();
    scan();
    goto(0);
  }

  function close() {
    if (!bar) return;
    bar.classList.add("hidden");
    hits = [];
    idx = -1;
    if (CAN_HIGHLIGHT) { CSS.highlights.delete(HL_ALL); CSS.highlights.delete(HL_CUR); }
  }

  window.findInNote = { open, close };
})();
