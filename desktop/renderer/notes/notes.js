// Floating notes window shown by main.js during a Live session. Talks to
// main via the `notesApi` bridge exposed in preload.js.
//
// Main owns the notes: this window is closeable and reopenable mid-session, so
// it repopulates from main on load rather than trusting its own DOM, and only
// paints a row once main has acknowledged the note. The elapsed times shown
// here are main's own, so they match the saved transcript exactly.

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const inputEl = document.getElementById('input');
const closeBtn = document.getElementById('close-btn');
const collapseBtn = document.getElementById('collapse-btn');
const iconCollapse = document.getElementById('icon-collapse');
const iconExpand = document.getElementById('icon-expand');

const PLACEHOLDER = 'Note… (Enter to save)';

function formatHms(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

function renderNotes(notes) {
    listEl.querySelectorAll('.note-row').forEach(row => row.remove());
    emptyEl.style.display = notes.length ? 'none' : '';
    for (const n of notes) {
        const row = document.createElement('div');
        row.className = 'note-row';

        const time = document.createElement('div');
        time.className = 'note-time';
        time.textContent = formatHms(n.start);

        const body = document.createElement('div');
        body.className = 'note-text';
        body.textContent = n.text;

        row.appendChild(time);
        row.appendChild(body);
        listEl.appendChild(row);
    }
    listEl.scrollTop = listEl.scrollHeight;
}

async function refresh() {
    try {
        renderNotes((await window.notesApi.list()) || []);
    } catch { /* no session — the empty placeholder is the honest state */ }
}

function flashPlaceholder(message) {
    inputEl.placeholder = message;
    setTimeout(() => { inputEl.placeholder = PLACEHOLDER; }, 2500);
}

// Reopened mid-session: show what main already holds, not an empty list that
// would read as "your earlier notes are gone".
refresh();

inputEl.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    const res = await window.notesApi.add(text);
    if (!res?.ok) {
        // Nothing is recording, so the note has nowhere to land. Hand the text
        // back rather than painting a row for something that wasn't saved.
        inputEl.value = text;
        flashPlaceholder('Not recording — note not saved');
        return;
    }
    refresh();
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
