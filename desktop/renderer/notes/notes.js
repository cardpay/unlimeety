// Floating notes window shown by main.js during a Live session. Talks to
// main via the `notesApi` bridge exposed in preload.js.
//
// The displayed timecode is a local echo only, anchored to when this window
// loaded — not the authoritative recording start (which lives in main.js and
// may only be finalized once the helper's 'recording' event arrives). The
// saved transcript always uses main's timestamp; this one just gives the
// user immediate visual feedback and can drift a little from it.

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const inputEl = document.getElementById('input');
const closeBtn = document.getElementById('close-btn');
const collapseBtn = document.getElementById('collapse-btn');
const iconCollapse = document.getElementById('icon-collapse');
const iconExpand = document.getElementById('icon-expand');

const startedAt = Date.now();

function formatHms(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

function addRow(text) {
    emptyEl.style.display = 'none';
    const row = document.createElement('div');
    row.className = 'note-row';

    const time = document.createElement('div');
    time.className = 'note-time';
    time.textContent = formatHms((Date.now() - startedAt) / 1000);

    const body = document.createElement('div');
    body.className = 'note-text';
    body.textContent = text;

    row.appendChild(time);
    row.appendChild(body);
    listEl.appendChild(row);
    listEl.scrollTop = listEl.scrollHeight;
}

inputEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const text = inputEl.value.trim();
    if (!text) return;
    addRow(text);
    window.notesApi.add(text);
    inputEl.value = '';
});

closeBtn.addEventListener('click', () => window.notesApi.close());

// Collapse to just the header bar — same idea as the Chrome extension
// widget's collapse toggle. main.js owns the actual resize since this is a
// real OS window, not a resizable DOM element.
let collapsed = false;
collapseBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    document.body.classList.toggle('collapsed', collapsed);
    iconCollapse.style.display = collapsed ? 'none' : 'block';
    iconExpand.style.display = collapsed ? 'block' : 'none';
    collapseBtn.title = collapsed ? 'Expand' : 'Collapse';
    window.notesApi.setCollapsed(collapsed);
    if (!collapsed) inputEl.focus();
});

inputEl.focus();
