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
  // [{ kind: "range", range, scroller } | { kind: "ta", start, len }]
  let hits = [];
  let idx = -1;
  let rescanTimer = null;
  let typeTimer = null;

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
      `<button type="button" data-find="prev" title="Previous">↑</button>` +
      `<button type="button" data-find="next" title="Next">↓</button>` +
      `<button type="button" data-find="close" title="Close">✕</button>`;
    const wrap = document.getElementById("editor-wrap");
    if (wrap) wrap.insertBefore(bar, document.getElementById("transcript-view"));
    else document.body.appendChild(bar);

    input = bar.querySelector("input");
    counter = bar.querySelector("#find-count");

    // Debounced: one keystroke on a long transcript builds a Range per match.
    input.addEventListener("input", () => {
      clearTimeout(typeTimer);
      typeTimer = setTimeout(() => { scan(); goto(0); }, 100);
    });
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
    // not touch the DOM, so this can't loop). Editing the note in the textarea
    // emits no mutation records, so that needs its own listener.
    const observer = new MutationObserver(rescan);
    for (const id of ["transcript-view", "summary-rail-body"]) {
      const el = document.getElementById(id);
      if (el) observer.observe(el, { childList: true, subtree: true, characterData: true });
    }
    document.getElementById("editor")?.addEventListener("input", rescan);
  }

  // Content moved under us: refresh the matches but leave the caret, the focus
  // and the scroll position where the user put them — a rescan is not
  // navigation. The position survives a re-render of the pane the user is not
  // in (typically the rail loading its summary); it is only clamped, not
  // re-located, so it can still drift by a match when text is inserted before
  // the current one. If the text the current match lived in is gone — a note
  // switch replaces the whole pane — the position is meaningless, so go back to
  // the first match. Removing a text node collapses the ranges inside it onto
  // its former parent (isConnected stays true, so that would be no signal).
  function rescan() {
    if (!isOpen()) return;
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      const prevIdx = idx, prevHit = hits[idx];
      const survived = prevHit?.kind === "ta" || (!!prevHit && !prevHit.range.collapsed);
      scan();
      idx = hits.length ? (survived ? Math.min(Math.max(prevIdx, 0), hits.length - 1) : 0) : -1;
      paint();
      updateCounter();
    }, 80);
  }

  function isOpen() { return !!bar && !bar.classList.contains("hidden"); }

  const visible = (el) => !!el && !el.classList.contains("hidden");

  // Case-insensitive search for the query. A regex rather than a hand-rolled
  // case fold: toLowerCase() can change a string's length (İ → i̇), which would
  // shift every later offset. Compiled once per scan — a segmented transcript
  // has thousands of text nodes.
  function queryRe(q) {
    return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  }

  // Every match of `re` in `text`, as {start, len} offsets into `text`.
  function matches(text, re) {
    re.lastIndex = 0;
    const out = [];
    for (let m = re.exec(text); m; m = re.exec(text)) out.push({ start: m.index, len: m[0].length });
    return out;
  }

  // ── find skip predicate (extracted verbatim by test/transcript-meta.test.js) ──
  // The transcript's meta panel is hidden until the info icon is hovered, so its
  // text is not on screen: counting it would inflate the counter and send Enter
  // scrolling to nothing. Only DOM access is the closest() call, so the test can
  // hand this a stub node. Keep the markers in place when editing.
  const skipInFind = (node) => !!node.parentElement?.closest(".tv-meta-panel");
  const findNodeFilter = {
    acceptNode: (n) => (skipInFind(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  };
  // ── end find skip predicate ──

  function rangesIn(root, re) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, findNodeFilter);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const { start, len } of matches(node.nodeValue, re)) {
        const r = document.createRange();
        r.setStart(node, start);
        r.setEnd(node, start + len);
        out.push({ kind: "range", range: r, scroller: root });
      }
    }
    return out;
  }

  // Collects the matches only — callers decide the position and then paint, so
  // the highlight set is never built twice for one scan.
  function scan() {
    hits = [];
    idx = -1;
    const q = input.value;
    if (q) {
      const re = queryRe(q);
      const view = document.getElementById("transcript-view");
      const editor = document.getElementById("editor");
      const rail = document.getElementById("summary-rail");
      const railBody = document.getElementById("summary-rail-body");

      if (visible(view)) hits.push(...rangesIn(view, re));
      else if (visible(editor)) {
        for (const { start, len } of matches(editor.value, re)) hits.push({ kind: "ta", start, len });
      }
      if (visible(rail) && railBody) hits.push(...rangesIn(railBody, re));
    }
  }

  function paint() {
    if (!CAN_HIGHLIGHT) return;
    // Built with add() rather than new Highlight(...ranges): spreading tens of
    // thousands of ranges blows V8's argument limit.
    const all = new Highlight();
    for (const h of hits) if (h.kind === "range") all.add(h.range);
    if (all.size) CSS.highlights.set(HL_ALL, all);
    else CSS.highlights.delete(HL_ALL);
    const cur = hits[idx];
    if (cur && cur.kind === "range") CSS.highlights.set(HL_CUR, new Highlight(cur.range));
    else CSS.highlights.delete(HL_CUR);
  }

  // Scroll from the range's own geometry: every hit in a note without timecodes
  // shares one .tv-plain parent, so scrolling the parent into view would never
  // follow the matches.
  function scrollToRange(hit) {
    const box = hit.range.getBoundingClientRect();
    const view = hit.scroller.getBoundingClientRect();
    if (!box.height) return;
    if (box.top < view.top || box.bottom > view.bottom) {
      hit.scroller.scrollTop += box.top - view.top - (view.height - box.height) / 2;
    }
  }

  // Navigation — the only path allowed to move the scroll position or the focus.
  function goto(n) {
    idx = hits.length ? ((n % hits.length) + hits.length) % hits.length : -1;
    const hit = hits[idx];
    if (hit?.kind === "range") {
      scrollToRange(hit);
    } else if (hit?.kind === "ta") {
      // Focus so Chromium scrolls the textarea to the selection, then hand focus
      // back to the find input; the selection stays drawn.
      const editor = document.getElementById("editor");
      editor.focus();
      editor.setSelectionRange(hit.start, hit.start + hit.len);
      input.focus();
    }
    paint();
    updateCounter();
  }

  function updateCounter() {
    counter.textContent = !input.value ? "" : hits.length ? `${idx + 1}/${hits.length}` : "No results";
  }

  function step(dir) {
    if (!hits.length) return;
    goto(idx + dir);
  }

  function open() {
    if (isOpen()) { input.focus(); input.select(); return; } // don't lose the position
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

  window.findInNote = { open, close, isOpen };
})();
