// Floating notes window shown by main.js during a Live session. Talks to
// main via the `notesApi` bridge exposed in preload.js, and shares its row
// rendering with the Record tab's inline control via `window.notesList`
// (renderer/notes-list.js) so the two lists can't drift apart.
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

const PLACEHOLDER = 'Click here to type a note, Enter to save';

window.notesList.attachInput({
    input: inputEl,
    container: listEl,
    emptyEl,
    placeholder: PLACEHOLDER,
    rejectedMessage: 'Not recording — note not saved',
});

// Reopened mid-session: show what main already holds, not an empty list that
// would read as "your earlier notes are gone".
window.notesList.refresh(listEl, emptyEl);
// …and repaint on main's broadcast: a note added from the Record tab's control
// lands in this session too when both are running, and a new session clears
// the list. The disposer is unused on purpose — this list lives exactly as
// long as the window does.
window.notesList.watch(listEl, emptyEl);

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
});

// Deliberately no autofocus/focus() here: the window is shown with
// showInactive() so it never steals focus from the meeting, which means it
// isn't the key window and keystrokes would go elsewhere. Painting a focused
// input would promise otherwise, so the placeholder invites a click instead.
