const { app, BrowserWindow, Menu, Tray, nativeImage, screen, dialog, ipcMain, shell, systemPreferences, clipboard, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { normalizeSummary, hasValidFrontmatter } = require('./summary-frontmatter');
const glossary = require('./glossary');
const enhance = require('./transcript-enhance');
const { createJobQueue } = require('./job-queue');

const TRANSCRIPTS_FOLDER = path.join(os.homedir(), 'Downloads', 'Meet_Transcripts');
const RECORDINGS_FOLDER = path.join(os.homedir(), 'Downloads', 'Meet_Recordings');

// ─── Job queue ─────────────────────────────────────────────────────────────
// Single queue for every transcribe/enhance/summarize run. Lanes are
// registered next to each executor below (runEnhanceJob, runRecordTranscribeJob,
// runSummarizeJob); this just creates the (pure, Electron-free) scheduler and
// wires its broadcast to the renderer. See job-queue.js for the scheduling
// rules and spec-universal-job-queue.md for the design.
const queue = createJobQueue();
queue.onChange((jobs) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('queue:changed', jobs);
});

// Background-queue a bigger, more accurate re-transcription of `filePath` —
// used by live:saveTranscript (its own session's wav) and record:autoQueueTranscribe.
// Its own successful completion chains an Enhance pass; see runRecordTranscribeJob's
// return. Replaces the old autoPipelineQueue: same large-v3/diarize-on defaults,
// now a visible, cancelable job instead of a silent 2s-polled FIFO.
function queueAutoTranscribe(filePath, language) {
    return queue.submit('transcribe', filePath, {
        title: path.basename(filePath),
        extra: {
            filePath,
            model: 'openai_whisper-large-v3',
            language,
            diarize: true,
            // numberOfSpeakers left undefined — auto-detect.
        },
    });
}

// The header panel's only bridge: one snapshot on demand, one cancel-by-id,
// plus the `queue:changed` broadcast wired above.
ipcMain.handle('queue:list', () => queue.list());
ipcMain.handle('queue:cancel', (_e, jobId) => ({ ok: queue.cancel(jobId) }));
ipcMain.handle('queue:dismiss', (_e, jobId) => ({ ok: queue.dismiss(jobId) }));

// ─── Config (persisted to userData/config.json) ───────────────────────────────

function configPath() {
    return path.join(app.getPath('userData'), 'config.json');
}

function readConfig() {
    try {
        return JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
    } catch {
        return {};
    }
}

function writeConfig(data) {
    fs.writeFileSync(configPath(), JSON.stringify(data, null, 2), 'utf-8');
}

let mainWindow = null;
let currentFilePath = null;
let isDirty = false;

let pendingFilePath = null; // file queued before window ready

// ─── Single instance lock ─────────────────────────────────────────────────────
// Windows: when a second instance is launched (e.g. via protocol URL),
// forward the file to the already-running instance and quit.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
}

app.on('second-instance', (_e, argv) => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
    const fileToOpen = getStartupFile(argv);
    if (fileToOpen) openFileFromPath(fileToOpen);
});

// ─── macOS: "Open With" / Finder double-click / recent docs ──────────────────
app.on('open-file', (e, filePath) => {
    e.preventDefault();
    if (mainWindow && !mainWindow.webContents.isLoading()) {
        openFileFromPath(filePath);
    } else {
        pendingFilePath = filePath;
    }
});

// ─── macOS + Windows: custom protocol unlimeety://open?file=<path> ──────────
app.on('open-url', (e, url) => {
    e.preventDefault();
    const filePath = parseProtocolUrl(url);
    if (!filePath) return;
    if (mainWindow && !mainWindow.webContents.isLoading()) {
        openFileFromPath(filePath);
    } else {
        pendingFilePath = filePath;
    }
});

// ─── Protocol helpers ─────────────────────────────────────────────────────────

// Files opened via the custom protocol / argv / second-instance come from an
// untrusted source: any website can fire `unlimeety://open?file=…`. Confine
// such opens to the transcripts folder and to text extensions, resolving
// symlinks first, so a crafted URL can't read arbitrary files (e.g. an SSH key).
// Note: the Finder "Open With" path (app.on('open-file')) is an explicit user
// action and is intentionally NOT confined here.
const OPEN_ALLOWED_EXT = new Set(['.txt', '.md']);

function isPathInside(child, parent) {
    const rel = path.relative(parent, child);
    return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function confineOpenPath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return null;
    let resolved;
    try {
        resolved = fs.realpathSync(rawPath); // resolves symlinks; throws if missing
    } catch {
        return null;
    }
    if (!OPEN_ALLOWED_EXT.has(path.extname(resolved).toLowerCase())) return null;
    let base;
    try {
        base = fs.realpathSync(TRANSCRIPTS_FOLDER);
    } catch {
        return null; // transcripts folder doesn't exist yet — nothing to open
    }
    return isPathInside(resolved, base) ? resolved : null;
}

function parseProtocolUrl(url) {
    try {
        const raw = decodeURIComponent(new URL(url).searchParams.get('file') || '');
        return confineOpenPath(raw);
    } catch {
        return null;
    }
}

// ─── Defense-in-depth: read allow-list ────────────────────────────────────────
// The read-only IPC handlers (summarize / chat / follow-up / transcribe) accept a
// file path from the renderer. The renderer is trusted local code and its XSS
// surface is well contained (escaping + CSP + contextIsolation), but if it were
// ever compromised these handlers would otherwise read ANY file the user can read
// and — with a remote LLM provider — exfiltrate it. So we only honour paths that
// are inside the managed folders, or that the user explicitly picked themselves
// (file dialog / Finder "Open With" / confined protocol open).
const allowedReadPaths = new Set();

function registerReadablePath(p) {
    if (!p || typeof p !== 'string') return;
    allowedReadPaths.add(p);
    try { allowedReadPaths.add(fs.realpathSync(p)); } catch { /* file may be gone */ }
}

function canReadPath(p) {
    if (!p || typeof p !== 'string') return false;
    let resolved;
    try { resolved = fs.realpathSync(p); } catch { return false; }
    for (const base of [TRANSCRIPTS_FOLDER, RECORDINGS_FOLDER]) {
        let b;
        try { b = fs.realpathSync(base); } catch { continue; }
        if (resolved === b || isPathInside(resolved, b)) return true;
    }
    return allowedReadPaths.has(p) || allowedReadPaths.has(resolved);
}

// Symmetric confinement for IPC handlers that WRITE to a renderer-supplied
// path. Same policy as canReadPath (managed folders + explicitly user-picked
// paths), except the target may not exist yet — so confinement resolves the
// parent directory and re-joins the basename.
function canWritePath(p) {
    if (!p || typeof p !== 'string') return false;
    if (canReadPath(p)) return true;
    // The target exists (possibly as a symlink) but didn't pass canReadPath —
    // deny instead of falling through to the parent-dir check, which a symlink
    // planted inside a managed folder could otherwise redirect elsewhere.
    try { fs.lstatSync(p); return false; } catch { /* no entry — a new file */ }
    let dir;
    try { dir = fs.realpathSync(path.dirname(p)); } catch { return false; }
    const resolved = path.join(dir, path.basename(p));
    for (const base of [TRANSCRIPTS_FOLDER, RECORDINGS_FOLDER]) {
        let b;
        try { b = fs.realpathSync(base); } catch { continue; }
        if (isPathInside(resolved, b)) return true;
    }
    return allowedReadPaths.has(resolved);
}

// Returns a file path from argv, handling both direct paths and protocol URLs.
// Both branches are confined: argv can carry a protocol URL on some platforms,
// and a bare path here is equally untrusted (e.g. injected by the protocol
// registration relaunch), so it goes through the same allow-list.
function getStartupFile(argv) {
    const args = argv.slice(app.isPackaged ? 1 : 2);
    const proto = args.find(a => a.startsWith('unlimeety://'));
    if (proto) return parseProtocolUrl(proto);
    const direct = args.find(a => !a.startsWith('-') && fs.existsSync(a));
    return direct ? confineOpenPath(direct) : null;
}

// ─── Window ──────────────────────────────────────────────────────────────────

// Set once a Quit is cleared to proceed, so the close guard below lets the
// window go.
let quitting = false;

// A recording only ever exists in the renderer that started it, so quitting
// mid-session used to SIGTERM the helper (the handlers further down do that)
// and drop the transcript on the floor — silently, 40 minutes in. Flush first:
// run the renderer's own stop+save, then quit for real.
//
// Registered here on purpose: `before-quit` handlers run in registration order,
// and the two that kill the helpers live later in this file.
let quitFlushing = false;
let quitFlushDone = null;                 // resolve fn while a flush is in flight
let quitFlushPending = null;              // Set of busy slot names still owed an ack
const QUIT_FLUSH_TIMEOUT_MS = 10000;      // live:stop alone can take 5 s

// Called by the handlers that complete a slot's work — `live:saveTranscript`
// once the transcript is on disk, `record:stop` once the WAV is finalized,
// `record:transcribe` once it has written (or given up on) its output. All
// three can be in flight at once, so this tracks each by name rather than
// resolving on the first ack — two acks from a re-entered slot must not
// satisfy a quota a different, still-busy slot owes. Outside a quit flush it
// does nothing.
function noteSessionFlushed(slot) {
    if (!quitFlushDone) return;
    quitFlushPending.delete(slot);
    if (quitFlushPending.size > 0) return;
    const resolve = quitFlushDone;
    quitFlushDone = null;
    resolve();
}

app.on('before-quit', (e) => {
    if (quitting) return;                                    // already flushed
    // A second before-quit during an in-flight flush must be deferred
    // unconditionally: recomputing "pending" from proc handles here would miss
    // a slot whose helper has already exited (proc nulled) but hasn't acked
    // yet — e.g. Live's helper process exits before its renderer finishes
    // mapping segments and calling live:saveTranscript. quitFlushing, not
    // proc liveness, is what a flush in flight actually looks like.
    if (quitFlushing) { e.preventDefault(); return; }
    // A recording can only be saved by the renderer that owns it; a
    // transcription is assembled here in main and needs no renderer at all.
    const rendererAlive = Boolean(mainWindow && !mainWindow.isDestroyed());
    const pending = new Set([
        rendererAlive && live.proc && 'live',
        rendererAlive && recorder.proc && 'record',
        transcriber.proc && 'transcriber',
    ].filter(Boolean));
    if (!pending.size) return;                               // nothing to lose
    e.preventDefault();
    quitFlushing = true;
    quitFlushPending = pending;

    cancelAutoStop();     // whatever the countdown was going to do, we're doing now
    const saved = new Promise((resolve) => { quitFlushDone = resolve; });
    if (rendererAlive) {
        showMainWindow();  // the user should see "Finalizing…", not a Quit that hangs
        triggerAutoStop(['live', 'record']); // renderers run the same stop+save as their Stop buttons
    }
    // Closing the transcriber's stdin cancels its run — it can't be waited out
    // inside a quit — but `record:transcribe` then writes the segments it has
    // instead of losing them to the SIGTERM below. Flagged as interrupted so
    // that partial output is written as a `.partial.txt` and never passes for
    // a finished transcript.
    if (transcriber.proc) {
        transcriber.interrupted = true;
        try { transcriber.proc.stdin.end(); } catch { /* already closed */ }
    }

    const timedOut = new Promise((resolve) => setTimeout(resolve, QUIT_FLUSH_TIMEOUT_MS));
    Promise.race([saved, timedOut]).then(() => {
        // Stand down no longer: if this was a timeout rather than a clean
        // flush, the kill handlers below are the backstop that reaps whatever
        // slot never acked.
        quitFlushing = false;
        quitting = true;
        app.quit();
    });
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        icon: process.platform === 'win32'
            ? path.join(__dirname, 'build', 'icon.ico')
            : process.platform === 'linux'
                ? path.join(__dirname, 'build', 'icon.png')
                : path.join(__dirname, 'build', 'icon.icns'),
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        backgroundColor: '#0f0f13',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    updateTitle();

    // The app only ever shows its own bundled renderer (a static SPA). Lock that
    // down: deny all new windows, and block any navigation away from the loaded
    // file:// document. External http(s) links (none today) are routed to the
    // system browser rather than loaded in-app.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (e, url) => {
        if (url !== mainWindow.webContents.getURL()) {
            e.preventDefault();
            if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        }
    });

    mainWindow.webContents.on('did-finish-load', () => {
        const fileToOpen = pendingFilePath || getStartupFile(process.argv);
        if (fileToOpen) {
            pendingFilePath = null;
            openFileFromPath(fileToOpen);
        }
    });

    // Edits autosave (renderer flushes on editor/window blur), so closing never
    // risks unsaved work — no confirmation dialog needed. A recording is the one
    // thing closing could still lose, which is what the guard below is for; Quit
    // is handled by the flush registered next to `quitting`.

    // A recording session lives in the renderer: the transcript, the Stop button
    // and the auto-stop delegation are all its state. Destroying the window
    // mid-recording therefore strands the helper — nothing can stop it short of
    // Quit, and the transcript is lost. Hide the window instead; the tray item
    // and the Dock icon bring it back, and every stop path keeps working.
    mainWindow.on('close', (e) => {
        if (quitting) return;
        if (!live.proc && !recorder.proc) return;
        e.preventDefault();
        // Hiding a fullscreen window leaves its Space behind as an empty desktop
        // the user has to swipe out of, so drop out of fullscreen first.
        if (mainWindow.isFullScreen()) {
            mainWindow.once('leave-full-screen', () => mainWindow.hide());
            mainWindow.setFullScreen(false);
        } else {
            mainWindow.hide();
        }
    });
}

function updateTitle() {
    if (!mainWindow) return;
    const name = currentFilePath ? path.basename(currentFilePath) : 'Untitled';
    const dirty = isDirty ? '● ' : '';
    mainWindow.setTitle(`${dirty}${name} — Unlimeety`);
}

// ─── Open file from path ──────────────────────────────────────────────────────

// The renderer may decline an open (it prompts when the current note has edits
// a failed write left unsaved), so main-side state waits for the file:accepted
// ack rather than assuming the open happened.
function openFileFromPath(filePath) {
    if (!filePath || !mainWindow) return;
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        registerReadablePath(filePath);
        mainWindow.webContents.send('file:opened', { filePath, content });
    } catch (err) {
        dialog.showErrorBox('Cannot open file', err.message);
    }
}

ipcMain.on('file:accepted', (_e, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return;
    currentFilePath = filePath;
    isDirty = false;
    updateTitle();
    app.addRecentDocument(filePath);
});

// ─── Menu ─────────────────────────────────────────────────────────────────────

function buildMenu() {
    const isMac = process.platform === 'darwin';

    const template = [
        ...(isMac ? [{ role: 'appMenu' }] : []),
        {
            label: 'File',
            submenu: [
                {
                    label: 'New Transcript…',
                    accelerator: 'CmdOrCtrl+N',
                    click: () => mainWindow?.webContents.send('menu:new'),
                },
                {
                    label: 'Open…',
                    accelerator: 'CmdOrCtrl+O',
                    click: () => mainWindow?.webContents.send('menu:open'),
                },
                ...(isMac ? [{
                    label: 'Open Recent',
                    role: 'recentDocuments',
                    submenu: [{ role: 'clearRecentDocuments' }],
                }] : []),
                { type: 'separator' },
                {
                    label: 'Save',
                    accelerator: 'CmdOrCtrl+S',
                    click: () => mainWindow?.webContents.send('menu:save'),
                },
                {
                    label: 'Save As…',
                    accelerator: 'CmdOrCtrl+Shift+S',
                    click: () => mainWindow?.webContents.send('menu:saveAs'),
                },
                { type: 'separator' },
                isMac ? { role: 'close' } : { role: 'quit' },
            ],
        },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
        {
            role: 'help',
            submenu: [
                {
                    label: 'Open Extension Folder',
                    click: () => shell.openPath(path.join(__dirname, '..', 'extension')),
                },
            ],
        },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── IPC: File operations ─────────────────────────────────────────────────────

ipcMain.handle('file:open', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Open Transcript',
        filters: [
            { name: 'Text Files', extensions: ['txt', 'md'] },
            { name: 'All Files', extensions: ['*'] },
        ],
        properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return null;

    const filePath = result.filePaths[0];
    const content = fs.readFileSync(filePath, 'utf-8');
    registerReadablePath(filePath);
    currentFilePath = filePath;
    isDirty = false;
    updateTitle();
    app.addRecentDocument(filePath);
    return { filePath, content };
});

// Same-directory temp file, fsync, then rename: the rename is atomic on APFS and
// NTFS, and the fsync is what makes the claim hold through a power loss rather
// than only a process crash — without it the directory entry can land before the
// data blocks. Matters most for Enhance, which has no backup to fall back on.
//
// The temp file is opened 'wx' and named unpredictably: `wx` fails on an existing
// entry, symlink included. Plain writeFileSync follows symlinks, so a pre-planted
// `<transcript>.tmp -> /somewhere/else` would have turned this into a write
// outside the managed folders — the very redirect canWritePath refuses, which
// never saw the temp path. The mode is inherited so a 0600 transcript does not
// come back world-readable.
function writeFileAtomic(target, content) {
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    let mode = 0o600;
    try { mode = fs.statSync(target).mode & 0o777; } catch { /* new file: keep 0600 */ }
    // The watcher keys suppression off a single filename, and the temp file's
    // creation is an event of its own; stamp its name first, the target's after.
    lastSelfWrite = { name: path.basename(tmp), at: Date.now() };
    let fd;
    try {
        fd = fs.openSync(tmp, 'wx', mode);
        fs.writeFileSync(fd, content, 'utf-8');
        fs.fsyncSync(fd);
    } catch (err) {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
        try { fs.unlinkSync(tmp); } catch { /* never created */ }
        throw err;
    }
    fs.closeSync(fd);
    try {
        fs.renameSync(tmp, target);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* leave no litter behind */ }
        throw err;
    }
}

function writeTranscriptFile(filePath, content) {
    const target = filePath || currentFilePath;
    if (!target) return { ok: false, error: 'No file path' };
    if (!canWritePath(target)) {
        return { ok: false, error: 'Refusing to write to a path outside the managed folders.' };
    }
    try {
        fs.writeFileSync(target, content, 'utf-8');
        // Stamped after the write, not before: writeFileSync blocks until the
        // data is out, and the watcher event can only arrive afterwards. Timing
        // it from before would spend the suppression window on the write itself
        // — worst on exactly the large notes where the re-read hurts most.
        lastSelfWrite = { name: path.basename(target), at: Date.now() };
        currentFilePath = target;
        isDirty = false;
        updateTitle();
        app.addRecentDocument(target);
        return { ok: true, filePath: target };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

ipcMain.handle('file:save', (_e, filePath, content) => writeTranscriptFile(filePath, content));

// Synchronous twin for the renderer's beforeunload flush (see saveFileSync in
// preload.js): sendSync blocks the renderer, which is what makes the write land
// before the window is gone.
// returnValue must be set on every path: sendSync blocks the renderer until it
// is, and this runs while the window is closing — a throw here would hang the
// quit and cost the user the very edits this flush protects.
ipcMain.on('file:saveSync', (e, filePath, content) => {
    try {
        e.returnValue = writeTranscriptFile(filePath, content);
    } catch (err) {
        e.returnValue = { ok: false, error: err.message };
    }
});

async function handleSaveAs(content) {
    const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Transcript As',
        defaultPath: currentFilePath || 'transcript.txt',
        filters: [
            { name: 'Text Files', extensions: ['txt', 'md'] },
            { name: 'All Files', extensions: ['*'] },
        ],
    });
    if (result.canceled) return null;
    return result.filePath;
}

ipcMain.handle('file:saveAs', async (_e, content) => {
    const filePath = await handleSaveAs(content);
    if (!filePath) return { ok: false, canceled: true };
    try {
        fs.writeFileSync(filePath, content, 'utf-8');
        registerReadablePath(filePath); // user-picked target: allow follow-up saves
        currentFilePath = filePath;
        isDirty = false;
        updateTitle();
        app.addRecentDocument(filePath);
        return { ok: true, filePath };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

// ─── IPC: Export to PDF / DOCX ────────────────────────────────────────────────

// Render a standalone HTML document to a PDF buffer via an offscreen window.
// The renderer hands us a fully self-contained HTML string (its own light
// print CSS), so this window only ever loads our own static markup.
let pdfExportSeq = 0;
async function generatePdf(html) {
    const tmpPath = path.join(app.getPath('temp'), `transcriber-export-${process.pid}-${pdfExportSeq++}.html`);
    fs.writeFileSync(tmpPath, html, 'utf-8');
    const win = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    try {
        await win.loadFile(tmpPath);
        return await win.webContents.printToPDF({ printBackground: true });
    } finally {
        win.destroy();
        try { fs.unlinkSync(tmpPath); } catch { /* best effort temp cleanup */ }
    }
}

ipcMain.handle('export:pdf', async (_e, html, defaultName) => {
    if (typeof html !== 'string' || !html) return { ok: false, error: 'No content to export.' };
    const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export as PDF',
        defaultPath: defaultName || 'export.pdf',
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
        fs.writeFileSync(result.filePath, await generatePdf(html));
        registerReadablePath(result.filePath); // user-picked target: allow showInFinder
        return { ok: true, filePath: result.filePath };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

// Split a markdown line into docx TextRuns, honoring **bold** spans.
function mdInlineToRuns(TextRun, text, italics = false) {
    const runs = [];
    let rest = String(text || '');
    while (rest.length) {
        const m = rest.match(/\*\*([^*]+)\*\*/);
        if (!m) { runs.push(new TextRun({ text: rest, italics })); break; }
        if (m.index > 0) runs.push(new TextRun({ text: rest.slice(0, m.index), italics }));
        runs.push(new TextRun({ text: m[1], bold: true, italics }));
        rest = rest.slice(m.index + m[0].length);
    }
    return runs.length ? runs : [new TextRun({ text: '', italics })];
}

// Minimal markdown → docx paragraphs (headings / bullets / quote / bold).
// Mirrors the renderer's renderMarkdown: consecutive plain lines fold into a
// single paragraph, blank lines separate blocks, and every block carries
// spacing so the document breathes the way the PDF does.
function markdownToDocxParagraphs(docx, text) {
    const { Paragraph, TextRun, HeadingLevel } = docx;
    const out = [];
    let para = [];
    const flushPara = () => {
        if (para.length) {
            out.push(new Paragraph({ spacing: { after: 160 }, children: mdInlineToRuns(TextRun, para.join(' ')) }));
            para = [];
        }
    };
    for (const raw of String(text || '').split('\n')) {
        const l = raw.trimEnd();
        if (!l.trim()) { flushPara(); continue; }
        let m;
        if ((m = l.match(/^#\s+(.+)/)))         { flushPara(); out.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 }, children: mdInlineToRuns(TextRun, m[1]) })); }
        else if ((m = l.match(/^###\s+(.+)/)))  { flushPara(); out.push(new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 100 }, children: mdInlineToRuns(TextRun, m[1]) })); }
        else if ((m = l.match(/^##\s+(.+)/)))   { flushPara(); out.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 220, after: 110 }, children: mdInlineToRuns(TextRun, m[1]) })); }
        else if ((m = l.match(/^[-*]\s+(.+)/))) { flushPara(); out.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: mdInlineToRuns(TextRun, m[1]) })); }
        else if ((m = l.match(/^>\s*(.+)/)))    { flushPara(); out.push(new Paragraph({ spacing: { after: 160 }, children: mdInlineToRuns(TextRun, m[1], true) })); }
        else                                    { para.push(l); }
    }
    flushPara();
    return out;
}

ipcMain.handle('export:docx', async (_e, payload) => {
    const { kind, text, title, defaultName } = payload || {};
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'No content to export.' };

    // Lazy require so a missing package degrades gracefully instead of
    // breaking app startup.
    let docx;
    try {
        docx = require('docx');
    } catch {
        return { ok: false, error: 'DOCX export needs the "docx" package. Run `npm install` in desktop/.' };
    }
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docx;

    const children = [];
    if (title) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 160 }, children: [new TextRun(String(title))] }));
    if (kind === 'transcript') {
        // Plain text — one paragraph per non-empty line, layout preserved.
        for (const raw of text.split('\n')) {
            const l = raw.replace(/\s+$/, '');
            if (l.trim()) children.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun(l)] }));
        }
    } else {
        children.push(...markdownToDocxParagraphs(docx, text));
    }

    const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export as DOCX',
        defaultPath: defaultName || 'export.docx',
        filters: [{ name: 'Word Document', extensions: ['docx'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
        const doc = new Document({ sections: [{ children }] });
        const buffer = await Packer.toBuffer(doc);
        fs.writeFileSync(result.filePath, buffer);
        registerReadablePath(result.filePath); // user-picked target: allow showInFinder
        return { ok: true, filePath: result.filePath };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.on('window:setDirty', (_e, dirty) => {
    isDirty = dirty;
    updateTitle();
});

// ─── Summary file helpers ─────────────────────────────────────────────────────

function sanitizeSummaryBase(name) {
    const trimmed = path.basename(String(name)).replace(/\.md$/i, '').trim();
    return trimmed || null;
}

function stripMeetPrefix(title) {
    return (
        title.replace(/^(?:Google[\s_\-]*Meet|GMeet|Meet)[\s_\-]+/i, '').trim() ||
        title
    );
}

function sanitizeFilenameChars(name) {
    return String(name)
        .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function dateParts(ms) {
    const dt = new Date(ms);
    return {
        y: String(dt.getFullYear()),
        mo: String(dt.getMonth() + 1).padStart(2, '0'),
        d: String(dt.getDate()).padStart(2, '0'),
    };
}

function meetingDateParts(transcriptPath, mtimeMs) {
    const m = path.basename(transcriptPath).match(/(\d{4})-(\d{2})-(\d{2})/);
    // A filename carries anything date-shaped. These parts feed a real YAML
    // `date:` property now, and `2026-13-45` there is a field Obsidian cannot
    // coerce — fall through to the timestamp rather than trust the match.
    if (m && !Number.isNaN(Date.parse(`${m[0]}T00:00:00Z`))) return { y: m[1], mo: m[2], d: m[3] };
    return dateParts(mtimeMs);
}

function formatDateDdMmYy(transcriptPath, mtimeMs) {
    const { y, mo, d } = meetingDateParts(transcriptPath, mtimeMs);
    return `${d}.${mo}.${y.slice(-2)}`;
}

function legacySummaryBase(transcriptPath) {
    return path.basename(transcriptPath, path.extname(transcriptPath));
}

function defaultSummaryBase(transcriptPath, info, mtimeMs) {
    const rawTitle = info?.title || legacySummaryBase(transcriptPath);
    const shortName = sanitizeFilenameChars(stripMeetPrefix(rawTitle));
    if (!shortName) return legacySummaryBase(transcriptPath);
    return `${formatDateDdMmYy(transcriptPath, mtimeMs)} ${shortName}`;
}

function readTranscriptInfoSync(transcriptPath) {
    let info = { title: null, generated: null, language: null, participants: [] };
    let mtimeMs = Date.now();
    try {
        const stat = fs.statSync(transcriptPath);
        mtimeMs = stat.mtime.getTime();
        const head = fs.readFileSync(transcriptPath, 'utf-8').slice(0, 512);
        info = parseTranscriptHeaderMain(head);
    } catch { /* fall back to defaults */ }
    return { info, mtimeMs };
}

function summaryFilePath(transcriptPath, folderOverride) {
    const cfg = readConfig();
    const dir = folderOverride ?? cfg.summaryFolder ?? path.dirname(transcriptPath);
    const rawOverride = cfg.summaryNames?.[transcriptPath];
    const safeOverride = rawOverride ? sanitizeSummaryBase(rawOverride) : null;
    if (safeOverride) return path.join(dir, safeOverride + '.summary.md');
    const { info, mtimeMs } = readTranscriptInfoSync(transcriptPath);
    return path.join(dir, defaultSummaryBase(transcriptPath, info, mtimeMs) + '.summary.md');
}

// The summary handlers accept an optional folder override from the renderer.
// Legitimate renderer code always sends null (main falls back to the configured
// summary folder or the transcript's own directory), so only honour overrides
// that resolve to a directory the main process already trusts.
function summaryDirAllowed(transcriptPath, folderOverride) {
    if (folderOverride == null) return true;
    if (typeof folderOverride !== 'string') return false;
    let resolved;
    try { resolved = fs.realpathSync(folderOverride); } catch { return false; }
    const trusted = [readConfig().summaryFolder, path.dirname(transcriptPath), TRANSCRIPTS_FOLDER, RECORDINGS_FOLDER];
    for (const dir of trusted) {
        if (!dir) continue;
        let d;
        try { d = fs.realpathSync(dir); } catch { continue; }
        if (resolved === d || isPathInside(resolved, d)) return true;
    }
    return false;
}

function findExistingSummaryPath(transcriptPath, folderOverride) {
    const cfg = readConfig();
    const dir = folderOverride ?? cfg.summaryFolder ?? path.dirname(transcriptPath);
    const candidates = [];
    const rawOverride = cfg.summaryNames?.[transcriptPath];
    const safeOverride = rawOverride ? sanitizeSummaryBase(rawOverride) : null;
    if (safeOverride) candidates.push(path.join(dir, safeOverride + '.summary.md'));
    const { info, mtimeMs } = readTranscriptInfoSync(transcriptPath);
    candidates.push(path.join(dir, defaultSummaryBase(transcriptPath, info, mtimeMs) + '.summary.md'));
    candidates.push(path.join(dir, legacySummaryBase(transcriptPath) + '.summary.md'));
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

ipcMain.handle('settings:getSummaryFolder', () => {
    return readConfig().summaryFolder || null;
});

ipcMain.handle('settings:setSummaryFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose folder for summaries',
        properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    const folder = result.filePaths[0];
    const cfg = readConfig();
    cfg.summaryFolder = folder;
    writeConfig(cfg);
    return { ok: true, folder };
});

ipcMain.handle('settings:pickFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose folder for this prompt\'s summaries',
        properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, folder: result.filePaths[0] };
});

ipcMain.handle('prompts:list', () => {
    return readConfig().customPrompts || [];
});

ipcMain.handle('prompts:save', (_e, prompt) => {
    if (
        !prompt ||
        typeof prompt.id !== 'string' || !prompt.id ||
        typeof prompt.name !== 'string' || !prompt.name.trim() ||
        typeof prompt.text !== 'string'
    ) {
        return { ok: false, error: 'invalid prompt payload' };
    }
    const clean = {
        id: prompt.id,
        name: prompt.name.trim(),
        text: prompt.text,
        summaryFolder: typeof prompt.summaryFolder === 'string' ? prompt.summaryFolder : null,
    };
    const cfg = readConfig();
    if (!cfg.customPrompts) cfg.customPrompts = [];
    const idx = cfg.customPrompts.findIndex(p => p.id === clean.id);
    if (idx >= 0) cfg.customPrompts[idx] = clean;
    else cfg.customPrompts.push(clean);
    writeConfig(cfg);
    return { ok: true };
});

// Domain glossary for the Enhance pass — plain text, one entry per line.
// Deliberately not merged into the summarizer payload: it is not a provider
// setting, and it outlives any switch between providers.
// The prompt block is rebuilt for every chunk, on the main process, so this cap
// is a latency budget as much as a size limit: matching ~700 entries against one
// chunk costs a few hundred ms, and every one of those blocks IPC.
const MAX_GLOSSARY_CHARS = 16 * 1024;

ipcMain.handle('settings:getGlossary', () => readConfig().glossary || '');

ipcMain.handle('settings:setGlossary', (_e, text) => {
    if (typeof text !== 'string') return { ok: false, error: 'invalid glossary payload' };
    if (text.length > MAX_GLOSSARY_CHARS) {
        return { ok: false, error: `Glossary is too long (max ${MAX_GLOSSARY_CHARS / 1024} KB).` };
    }
    const cfg = readConfig();
    cfg.glossary = text;
    writeConfig(cfg);
    return { ok: true };
});

ipcMain.handle('prompts:delete', (_e, id) => {
    const cfg = readConfig();
    cfg.customPrompts = (cfg.customPrompts || []).filter(p => p.id !== id);
    writeConfig(cfg);
    return { ok: true };
});

// Generated summaries are normalized in `summarize:run`, but a hand-edited one
// can still lose its frontmatter in the inline editor. We never rewrite what the
// user typed — we just refuse to let the note go to the vault silently broken.
function frontmatterWarning(text) {
    return hasValidFrontmatter(text)
        ? undefined
        : 'Frontmatter is missing or unterminated — Obsidian Bases/Dataview will skip this note.';
}

ipcMain.handle('summary:save', (_e, transcriptPath, text, folder) => {
    if (!canReadPath(transcriptPath) || !summaryDirAllowed(transcriptPath, folder || null)) {
        return { ok: false, error: 'Refusing to operate on a path outside the managed folders.' };
    }
    try {
        const filePath = summaryFilePath(transcriptPath, folder || null);
        fs.writeFileSync(filePath, text, 'utf-8');
        registerReadablePath(filePath); // summary may live outside managed folders
        return { ok: true, filePath, warning: frontmatterWarning(text) };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

// Overwrite an existing summary in place — writes back to the exact file the
// summary was loaded from (findExistingSummaryPath), so editing never spawns a
// duplicate under a different (default/legacy) name.
ipcMain.handle('summary:overwrite', (_e, transcriptPath, text, folder) => {
    if (!canReadPath(transcriptPath) || !summaryDirAllowed(transcriptPath, folder || null)) {
        return { ok: false, error: 'Refusing to operate on a path outside the managed folders.' };
    }
    try {
        const filePath = findExistingSummaryPath(transcriptPath, folder || null)
            || summaryFilePath(transcriptPath, folder || null);
        fs.writeFileSync(filePath, text, 'utf-8');
        registerReadablePath(filePath); // summary may live outside managed folders
        return { ok: true, filePath, warning: frontmatterWarning(text) };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('summary:setName', (_e, transcriptPath, customName) => {
    const cfg = readConfig();
    if (!cfg.summaryNames) cfg.summaryNames = {};
    const safe = customName ? sanitizeSummaryBase(customName) : null;
    if (safe) {
        cfg.summaryNames[transcriptPath] = safe;
    } else {
        delete cfg.summaryNames[transcriptPath];
    }
    writeConfig(cfg);
    return { ok: true };
});

ipcMain.handle('summary:load', (_e, transcriptPath, folder) => {
    if (!canReadPath(transcriptPath) || !summaryDirAllowed(transcriptPath, folder || null)) {
        return { ok: false, error: 'Refusing to operate on a path outside the managed folders.' };
    }
    try {
        const p = findExistingSummaryPath(transcriptPath, folder || null);
        if (!p) return { ok: false };
        return { ok: true, text: fs.readFileSync(p, 'utf-8') };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

// ─── IPC: Summarizer settings ─────────────────────────────────────────────────

const DEFAULT_SUMMARIZER = {
    provider: 'claude-code', // 'claude-code' | 'openrouter' | 'ollama' | 'openai-compatible'
    openrouter: {
        apiKey: '',
        model: 'anthropic/claude-3.5-sonnet',
        baseUrl: 'https://openrouter.ai/api/v1',
    },
    ollama: {
        baseUrl: 'http://localhost:11434',
        model: 'llama3.1',
    },
    openaiCompatible: {
        apiKey: '',
        model: 'gpt-5.4-mini',
        baseUrl: 'https://api.openai.com/v1',
    },
};

// The OpenRouter API key is a secret. Persist it encrypted at rest via
// Electron safeStorage (Keychain on macOS / DPAPI on Windows) as `apiKeyEnc`
// (base64), never as plaintext. Legacy configs that still hold a plaintext
// `apiKey` keep working and get migrated to encrypted form on the next save.
function decryptApiKey(or) {
    if (or && typeof or.apiKeyEnc === 'string' && or.apiKeyEnc) {
        try {
            if (safeStorage.isEncryptionAvailable()) {
                return safeStorage.decryptString(Buffer.from(or.apiKeyEnc, 'base64'));
            }
        } catch { /* unreadable blob — treat as no key */ }
        return '';
    }
    return typeof or?.apiKey === 'string' ? or.apiKey : '';
}

function encryptApiKey(plain) {
    const key = String(plain || '').trim();
    if (!key) return { apiKeyEnc: '' };
    try {
        if (safeStorage.isEncryptionAvailable()) {
            return { apiKeyEnc: safeStorage.encryptString(key).toString('base64') };
        }
    } catch { /* fall through */ }
    // Encryption unavailable (e.g. Linux without a keyring): fall back to
    // plaintext so the feature still works, matching prior behavior.
    return { apiKey: key };
}

function readSummarizerConfig() {
    const cfg = readConfig();
    const s = cfg.summarizer || {};
    const or = s.openrouter || {};
    return {
        provider: s.provider || DEFAULT_SUMMARIZER.provider,
        openrouter: {
            apiKey: decryptApiKey(or),
            model: or.model || DEFAULT_SUMMARIZER.openrouter.model,
            baseUrl: or.baseUrl || DEFAULT_SUMMARIZER.openrouter.baseUrl,
        },
        ollama: { ...DEFAULT_SUMMARIZER.ollama, ...(s.ollama || {}) },
        openaiCompatible: {
            apiKey: decryptApiKey(s.openaiCompatible || {}),
            model: (s.openaiCompatible || {}).model || DEFAULT_SUMMARIZER.openaiCompatible.model,
            baseUrl: (s.openaiCompatible || {}).baseUrl || DEFAULT_SUMMARIZER.openaiCompatible.baseUrl,
        },
    };
}

ipcMain.handle('settings:getSummarizer', () => readSummarizerConfig());

ipcMain.handle('settings:getAutoStop', () => autoStopEnabled());
ipcMain.handle('settings:setAutoStop', (_e, on) => { setAutoStopEnabled(Boolean(on)); return { ok: true }; });

ipcMain.handle('settings:setSummarizer', (_e, summarizer) => {
    if (!summarizer || typeof summarizer !== 'object') {
        return { ok: false, error: 'invalid summarizer payload' };
    }
    const allowed = new Set(['claude-code', 'openrouter', 'ollama', 'openai-compatible']);
    const provider = allowed.has(summarizer.provider) ? summarizer.provider : 'claude-code';
    const apiKey = String(summarizer.openrouter?.apiKey || '').trim();
    const oaiKey = String(summarizer.openaiCompatible?.apiKey || '').trim();
    const stored = {
        provider,
        openrouter: {
            ...encryptApiKey(apiKey),
            model: String(summarizer.openrouter?.model || DEFAULT_SUMMARIZER.openrouter.model).trim(),
            baseUrl: String(summarizer.openrouter?.baseUrl || DEFAULT_SUMMARIZER.openrouter.baseUrl).trim().replace(/\/+$/, ''),
        },
        ollama: {
            baseUrl: String(summarizer.ollama?.baseUrl || DEFAULT_SUMMARIZER.ollama.baseUrl).trim().replace(/\/+$/, ''),
            model: String(summarizer.ollama?.model || DEFAULT_SUMMARIZER.ollama.model).trim(),
        },
        openaiCompatible: {
            ...encryptApiKey(oaiKey),
            model: String(summarizer.openaiCompatible?.model || DEFAULT_SUMMARIZER.openaiCompatible.model).trim(),
            baseUrl: String(summarizer.openaiCompatible?.baseUrl || DEFAULT_SUMMARIZER.openaiCompatible.baseUrl).trim().replace(/\/+$/, ''),
        },
    };
    const cfg = readConfig();
    cfg.summarizer = stored;
    writeConfig(cfg);
    // Hand the decrypted shape back so the settings UI keeps working unchanged.
    return { ok: true, summarizer: readSummarizerConfig() };
});

// ─── IPC: Summarization ───────────────────────────────────────────────────────

function findClaude() {
    const isWin = process.platform === 'win32';
    const extraPaths = isWin
        ? [
            path.join(process.env.APPDATA || '', 'npm'),
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude'),
          ]
        : ['/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local', 'bin')];

    const env = {
        ...process.env,
        PATH: [process.env.PATH, ...extraPaths].filter(Boolean).join(path.delimiter),
    };

    const whichCmd = isWin ? 'where' : 'which';
    const claudeExe = isWin ? 'claude.cmd' : 'claude';

    return new Promise((resolve) => {
        execFile(whichCmd, ['claude'], { env }, (err, stdout) => {
            if (!err && stdout.trim()) {
                resolve(stdout.trim().split('\n')[0].trim());
                return;
            }
            // Fallback: check common locations directly
            const candidates = extraPaths.map(p => path.join(p, claudeExe));
            resolve(candidates.find(p => fs.existsSync(p)) || null);
        });
    });
}

// Summarization is a pure text task — the model needs no tools. We run with ALL
// tools disabled (`--tools=`) and WITHOUT `--dangerously-skip-permissions`, so
// a prompt-injection payload hidden in an untrusted transcript can't make Claude
// Code run shell commands or touch the filesystem. (Removing the bypass flag also
// means any tool the model still tries is auto-denied in this non-TTY child.)
// `--tools=` and not `--tools` `''`: on Windows we spawn through a shell, and
// Node joins argv with spaces and no quoting there — a bare empty string
// disappears, so the flag would swallow whatever came after it as its value.
const CLAUDE_BASE_ARGS = ['-p', '--output-format', 'text', '--tools='];

// The child inherits HOME, so without these it also inherits the user's whole
// Claude Code setup: ~/CLAUDE.md, plugin SessionStart hooks, output styles, a
// `defaultMode: "plan"` in settings.json. Those turn a summary into whatever
// house style the user codes in — leaked reasoning above the frontmatter,
// compressed prose in the body. `--safe-mode` drops every customization while
// leaving OAuth auth working (unlike `--bare`, which demands an API key).
const CLAUDE_ISOLATION_ARGS = ['--safe-mode', '--permission-mode', 'manual'];

// A CLI that rejects the isolation flags rejects them every time. Remembering the
// answer keeps the doomed first spawn off every later summary, follow-up draft and
// chat message — all three route through runClaudeCode.
let claudeIsolationSupported = true;

// `onAbort`, when passed, is called with an `{ abort() }` handle as soon as
// one exists (once per attempt — runClaudeCode's isolation-flag fallback
// spawns a second child and hands over a second handle for it), so a caller
// can store the latest one and invoke `.abort()` whenever it wants to cancel
// — including before any handle existed yet, since the caller's own onAbort
// re-checks whether cancellation was already requested each time it receives
// a handle. Omitted by every caller below except summarize:run, so none of
// them changes behavior.
async function runClaudeCode(content, promptInstruction, onAbort) {
    const claudePath = await findClaude();
    // `error` alongside `notInstalled` so a generic consumer (the job queue
    // panel, which has no per-provider special-casing) still shows something
    // actionable instead of a bare "Job failed." Summarize's own modal still
    // reads `notInstalled` directly for its richer "Install it…" view.
    if (!claudePath) {
        return {
            ok: false,
            notInstalled: true,
            error: 'Claude Code not found. Install it, or pick another provider in Settings.',
        };
    }

    const isWin = process.platform === 'win32';
    const extraPaths = isWin
        ? [
            path.join(process.env.APPDATA || '', 'npm'),
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude'),
          ]
        : ['/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local', 'bin')];
    const extendedPath = [process.env.PATH, ...extraPaths].filter(Boolean).join(path.delimiter);

    if (claudeIsolationSupported) {
        const startedAt = Date.now();
        const res = await spawnClaude(claudePath, [...CLAUDE_BASE_ARGS, ...CLAUDE_ISOLATION_ARGS], content, promptInstruction, extendedPath, onAbort);
        if (res.ok || res.canceled) return res;
        // A CLI too old for the isolation flags rejects them outright — summarizing
        // unisolated beats not summarizing at all. Two rejection shapes, both from
        // the same cause: `unknown option '--safe-mode'` when the flag is missing
        // entirely, and `option '--permission-mode <mode>' argument 'manual' is
        // invalid` when the flag exists but predates that choice.
        // The elapsed-time gate is what makes that safe to act on: argv parsing
        // fails in milliseconds, before the model runs. A slower failure whose
        // stderr merely happens to contain the phrase (a hook, an MCP server, a
        // Node warning) would otherwise cost a second full-transcript run and
        // silently give up the isolation this whole flag set exists for.
        if (Date.now() - startedAt > 2000
            || !/unknown option|argument '[^']*' is invalid/i.test(res.error || '')) {
            return res;
        }
        claudeIsolationSupported = false;
    }
    return spawnClaude(claudePath, CLAUDE_BASE_ARGS, content, promptInstruction, extendedPath, onAbort);
}

function spawnClaude(claudePath, args, content, promptInstruction, extendedPath, onAbort) {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        // Set by our own onAbort handle, never by the timeout below (that path
        // resolves itself before `close`/`error` can fire) — the only thing this
        // flag has to distinguish is "killed because the user cancelled" from
        // "killed/exited for any other reason".
        let canceled = false;

        // Both the instruction and the transcript are fed via stdin and NOT as
        // argv — on Windows we spawn through a shell (claude is a .cmd), and any
        // untrusted string passed as an argument would be an argument/command-
        // injection vector. With only constant flags in argv there's nothing for
        // the shell to abuse.
        const proc = spawn(claudePath, args, {
            env: { ...process.env, PATH: extendedPath, HOME: os.homedir() },
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
        });

        // The abort handle exists the instant the child does. If the caller asked
        // to cancel before this point (e.g. while findClaude() above was still
        // resolving), that request is remembered by the caller, not by us — handing
        // over the handle here gives it something to act on, and it fires the
        // abort right back at us synchronously when that's the case.
        if (onAbort) onAbort({ abort: () => { canceled = true; proc.kill(); } });

        // A child that rejects its flags exits during this write, and a transcript
        // is far bigger than the pipe buffer — the rest of it then lands on a
        // closed pipe. Without this listener that EPIPE is an uncaught exception
        // and takes the whole main process down instead of resolving below.
        proc.stdin.on('error', () => { /* child died early; `close` resolves us */ });

        // Instruction first, a blank line, then the transcript content.
        proc.stdin.write(`${promptInstruction}\n\n${content}`, 'utf-8');
        proc.stdin.end();

        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });

        const timer = setTimeout(() => {
            proc.kill();
            resolve({ ok: false, error: 'Timed out (5 min). Make sure Claude Code is authenticated.' });
        }, 300_000);

        proc.on('close', (code) => {
            clearTimeout(timer);
            if (canceled) { resolve({ ok: false, canceled: true }); return; }
            if (code === 0 && stdout.trim()) resolve({ ok: true, summary: stdout.trim() });
            else resolve({ ok: false, error: stderr.trim() || `Claude Code exited with code ${code}. Try running 'claude login' in a terminal to re-authenticate.` });
        });

        proc.on('error', (err) => {
            clearTimeout(timer);
            if (canceled) { resolve({ ok: false, canceled: true }); return; }
            resolve({ ok: false, error: err.message });
        });
    });
}

async function fetchWithTimeout(url, options, timeoutMs, onAbort) {
    const controller = new AbortController();
    // Built synchronously, unlike claude-code's child process — there is no gap
    // for a cancel to land before this handle exists.
    if (onAbort) onAbort({ abort: () => controller.abort() });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// The timeout above aborts the same AbortController a user cancel does, so an
// AbortError alone doesn't say which one happened. Wraps `onAbort` so the
// caller's own abort() — and only that — flips a local flag the catch block
// can check.
function withCancelFlag(onAbort) {
    if (!onAbort) return { onAbort: null, wasCanceled: () => false };
    let canceled = false;
    return {
        onAbort: (handle) => onAbort({ abort: () => { canceled = true; handle.abort(); } }),
        wasCanceled: () => canceled,
    };
}

async function runOpenRouter(content, promptInstruction, config, onAbort) {
    const { apiKey, model, baseUrl } = config;
    if (!apiKey) return { ok: false, error: 'OpenRouter API key is not set. Open Settings to add one.' };
    if (!model) return { ok: false, error: 'OpenRouter model is not set.' };

    const abortState = withCancelFlag(onAbort);
    try {
        const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': 'https://github.com/cardpay/unlimeety',
                'X-Title': 'Unlimeety',
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: promptInstruction },
                    { role: 'user', content },
                ],
            }),
        }, 300_000, abortState.onAbort);

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { ok: false, error: `OpenRouter error ${res.status}: ${text.slice(0, 500) || res.statusText}` };
        }
        const data = await res.json();
        const summary = data?.choices?.[0]?.message?.content?.trim();
        if (!summary) return { ok: false, error: 'OpenRouter returned an empty response.' };
        return { ok: true, summary };
    } catch (err) {
        if (err.name === 'AbortError') {
            return abortState.wasCanceled()
                ? { ok: false, canceled: true }
                : { ok: false, error: 'Request to OpenRouter timed out (5 min).' };
        }
        return { ok: false, error: `OpenRouter request failed: ${err.message}` };
    }
}

async function runOpenAICompat(content, promptInstruction, config, onAbort) {
    const { apiKey, model, baseUrl } = config;
    if (!baseUrl) return { ok: false, error: 'OpenAI-compatible base URL is not set. Open Settings to add one.' };
    if (!model) return { ok: false, error: 'OpenAI-compatible model is not set.' };

    // The API key is optional: local servers (vLLM, LM Studio, Ollama's
    // OpenAI shim) commonly accept requests without auth. Only send the
    // Authorization header when a key is actually configured.
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const abortState = withCancelFlag(onAbort);
    try {
        const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: promptInstruction },
                    { role: 'user', content },
                ],
            }),
        }, 300_000, abortState.onAbort);

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { ok: false, error: `OpenAI-compatible error ${res.status}: ${text.slice(0, 500) || res.statusText}` };
        }
        const data = await res.json();
        const summary = data?.choices?.[0]?.message?.content?.trim();
        if (!summary) return { ok: false, error: 'OpenAI-compatible endpoint returned an empty response.' };
        return { ok: true, summary };
    } catch (err) {
        if (err.name === 'AbortError') {
            return abortState.wasCanceled()
                ? { ok: false, canceled: true }
                : { ok: false, error: 'Request to OpenAI-compatible endpoint timed out (5 min).' };
        }
        if (err.code === 'ECONNREFUSED' || /fetch failed/i.test(err.message)) {
            return { ok: false, error: `Cannot reach OpenAI-compatible endpoint at ${baseUrl}. Is the server running?` };
        }
        return { ok: false, error: `OpenAI-compatible request failed: ${err.message}` };
    }
}

async function runOllama(content, promptInstruction, config, onAbort) {
    const { baseUrl, model } = config;
    if (!model) return { ok: false, error: 'Ollama model is not set.' };

    const abortState = withCancelFlag(onAbort);
    try {
        const res = await fetchWithTimeout(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                stream: false,
                messages: [
                    { role: 'system', content: promptInstruction },
                    { role: 'user', content },
                ],
            }),
        }, 600_000, abortState.onAbort);

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { ok: false, error: `Ollama error ${res.status}: ${text.slice(0, 500) || res.statusText}` };
        }
        const data = await res.json();
        const summary = data?.message?.content?.trim();
        if (!summary) return { ok: false, error: 'Ollama returned an empty response.' };
        return { ok: true, summary };
    } catch (err) {
        if (err.name === 'AbortError') {
            return abortState.wasCanceled()
                ? { ok: false, canceled: true }
                : { ok: false, error: 'Request to Ollama timed out (10 min).' };
        }
        if (err.code === 'ECONNREFUSED' || /fetch failed/i.test(err.message)) {
            return { ok: false, error: `Cannot reach Ollama at ${baseUrl}. Is it running? (\`ollama serve\`)` };
        }
        return { ok: false, error: `Ollama request failed: ${err.message}` };
    }
}

// One dispatch for every caller that sends text through the configured model —
// summarize:run and transcripts:enhance. Returns { ok, summary } / { ok, error }.
async function runSummarizerProvider(content, promptInstruction, cfg, onAbort) {
    switch (cfg.provider) {
        case 'openrouter':        return runOpenRouter(content, promptInstruction, cfg.openrouter, onAbort);
        case 'ollama':            return runOllama(content, promptInstruction, cfg.ollama, onAbort);
        case 'openai-compatible': return runOpenAICompat(content, promptInstruction, cfg.openaiCompatible, onAbort);
        case 'claude-code':
        default:                  return runClaudeCode(content, promptInstruction, onAbort);
    }
}

// One summarize job at a time, process-wide — the summarize lane already
// guarantees that; these two just carry the current run's cancel handle.
// `summarizeAbort` holds whatever the active provider handed back through
// `onAbort`; the lane's cancel hook (registered below) just calls it.
let summarizeCancelRequested = false;
let summarizeAbort = null;

// The `summarize:run` body, unchanged — now called by the queue instead of
// directly by the IPC handler, which only submits.
async function runSummarizeJob(filePath, promptInstruction) {
    if (!canReadPath(filePath)) return { ok: false, error: 'File is not accessible.' };
    let content;
    try {
        content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
        return { ok: false, error: 'Could not read transcript file.' };
    }

    // Lines like "[12:34] Note:" are the user's own typed notes (Live floating
    // window, Record-tab inline control, or the Chrome extension — all three
    // write this exact marker), not a spoken turn. Every preset and custom
    // prompt funnels through this one handler, so this is the only place it
    // needs explaining to the model. Gated on the marker so note-free
    // transcripts don't pay for an irrelevant instruction.
    if (content.includes(`] ${NOTE_LABEL}:`)) {
        promptInstruction = `Any transcript line formatted as "[mm:ss] ${NOTE_LABEL}:" followed by text is a note the user typed themselves during the meeting — not something anyone said aloud. Treat these as high-priority context: if a note reads like a task/TODO, fold it into the Action Items section (don't invent an owner or deadline unless the note itself states one); otherwise incorporate it as context in the relevant part of the summary.\n\n${promptInstruction}`;
    }

    const cfg = readSummarizerConfig();
    summarizeCancelRequested = false;
    summarizeAbort = null;
    let result;
    try {
        result = await runSummarizerProvider(content, promptInstruction, cfg, (handle) => {
            summarizeAbort = handle;
            // Cancel may have been requested before this provider had a handle to
            // give us (e.g. claude-code's findClaude() gap) — fire it right away.
            if (summarizeCancelRequested) handle.abort();
        });
    } finally {
        summarizeAbort = null;
    }
    if (!result?.ok) return result;

    // The frontmatter block is model output, delimiters and all — every provider
    // drops the closing `---` or leaks a line of reasoning above it sooner or
    // later. This is the one place all four funnel through, so it's the only
    // place the block has to be made sound.
    // `content` is already in memory, so parse the header off it rather than
    // re-reading the whole transcript. Recorded-At is the meeting's own ISO
    // timestamp and outranks everything else — including the filename, which
    // `meetingDateParts` prefers and which for an imported transcript is often a
    // different day. It only steps aside when the header has no Recorded-At line.
    const { recordedAt } = parseTranscriptHeaderMain(content.slice(0, 512));
    const recordedMs = Date.parse(recordedAt || '');
    let parts;
    if (!Number.isNaN(recordedMs)) {
        parts = dateParts(recordedMs);
    } else {
        // The stat must not throw here: the model call above took minutes, and the
        // user may have renamed or deleted the transcript meanwhile. Letting ENOENT
        // reject the handler would discard a summary that is already paid for.
        let mtimeMs = Date.now();
        try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { /* transcript moved mid-run */ }
        parts = meetingDateParts(filePath, mtimeMs);
    }
    const date = `${parts.y}-${parts.mo}-${parts.d}`;
    const { text, repairs } = normalizeSummary(result.summary, { date });
    return { ...result, summary: text, repairs };
}

queue.registerLane('summarize', {
    run: (job) => runSummarizeJob(job.filePath, job.extra?.promptInstruction),
    cancel: () => {
        summarizeCancelRequested = true;
        if (summarizeAbort) summarizeAbort.abort();
    },
});

// Submits and returns immediately — the result arrives via `queue:changed`.
// A second call for the same file while one is already queued/running just
// hands back that job's id (see job-queue.js's duplicate collapse).
ipcMain.handle('summarize:run', (_e, filePath, promptInstruction) => {
    const job = queue.submit('summarize', filePath, {
        title: path.basename(filePath),
        extra: { promptInstruction },
    });
    return { ok: true, jobId: job.id };
});

// ─── IPC: Follow-up draft ─────────────────────────────────────────────────────

const FOLLOWUP_PROMPT = `You are drafting a brief follow-up message after a meeting.
Based on the content provided (summary and/or transcript), write a professional follow-up that:
- Starts with a subject line on its own line, prefixed exactly with "Subject: "
- Thanks participants briefly (one sentence)
- Recaps key decisions (bullet points)
- Lists action items with owners where mentioned (bullet points)
- Ends with next steps or open questions if any
Keep it under 300 words. Write in plain text, no markdown formatting.`;

ipcMain.handle('followup:draft', async (_e, filePath) => {
    if (!canReadPath(filePath)) return { ok: false, error: 'File is not accessible.' };
    let transcriptContent;
    try {
        transcriptContent = fs.readFileSync(filePath, 'utf-8');
    } catch {
        return { ok: false, error: 'Could not read transcript file.' };
    }

    const sumPath = findExistingSummaryPath(filePath);
    let content = transcriptContent;
    if (sumPath && fs.existsSync(sumPath)) {
        const summaryText = fs.readFileSync(sumPath, 'utf-8');
        content = `SUMMARY:\n${summaryText}\n\nFULL TRANSCRIPT:\n${transcriptContent}`;
    }

    const cfg = readSummarizerConfig();
    switch (cfg.provider) {
        case 'openrouter':        return runOpenRouter(content, FOLLOWUP_PROMPT, cfg.openrouter);
        case 'ollama':            return runOllama(content, FOLLOWUP_PROMPT, cfg.ollama);
        case 'openai-compatible': return runOpenAICompat(content, FOLLOWUP_PROMPT, cfg.openaiCompatible);
        case 'claude-code':
        default:                  return runClaudeCode(content, FOLLOWUP_PROMPT);
    }
});

// Strip a leading YAML frontmatter block (Obsidian-format summaries carry one).
function stripFrontmatter(md) {
    return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

// Convert Markdown to Slack mrkdwn. Not a full parser — covers the constructs
// our summaries/follow-ups actually use. Order matters: links and bold/italic
// before list bullets so we don't mangle markers.
function mdToSlack(md) {
    let t = stripFrontmatter(md);
    // Links [text](url) → <url|text>
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<$2|$1>');
    // Headings (#, ##, …) → bold line
    t = t.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
    // Bold **b** / __b__ → *b*
    t = t.replace(/\*\*([^*]+)\*\*/g, '*$1*');
    t = t.replace(/__([^_]+)__/g, '*$1*');
    // List markers -, * → • (keep indentation)
    t = t.replace(/^(\s*)[-*]\s+/gm, '$1• ');
    return t;
}

ipcMain.handle('followup:share', (_e, service, text, isSummary) => {
    function extractSubject(t) {
        const m = t.match(/^Subject:\s*(.+)/im);
        return m ? m[1].trim() : 'Meeting Follow-up';
    }
    function bodyWithoutSubject(t) {
        return t.replace(/^Subject:.*\r?\n?/im, '').trim();
    }

    if (service === 'email') {
        const subj = isSummary ? 'Meeting Summary' : extractSubject(text);
        const body = isSummary
            ? `Here's the meeting summary:\n\n${text}`
            : bodyWithoutSubject(text);
        shell.openExternal(`mailto:?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}`);
    } else if (service === 'telegram') {
        // Telegram's share deep link inserts the `url` param at the start of the
        // compose field after the user picks a chat. `url` MUST be non-empty — an
        // empty url silently prefills nothing (that was the old bug), so we pass the
        // whole message there (Telegram accepts arbitrary text in `url`). Clipboard
        // kept as a fallback: very long summaries can exceed the deep-link length
        // LaunchServices will pass through, in which case the user pastes manually.
        const body = `${isSummary ? "Here's the meeting summary:\n\n" : ''}${stripFrontmatter(text)}`;
        clipboard.writeText(body);
        shell.openExternal(`tg://msg_url?url=${encodeURIComponent(body)}`);
    } else if (service === 'slack') {
        // Slack has no deep link that prefills the compose box, so we copy to the
        // clipboard and open Slack for a manual paste — but format as Slack mrkdwn.
        const msg = isSummary ? `Here's the meeting summary:\n\n${mdToSlack(text)}` : mdToSlack(text);
        clipboard.writeText(msg);
        shell.openExternal('slack://open');
    } else if (service === 'copy') {
        clipboard.writeText(text);
    }
    return { ok: true };
});


// ─── IPC: Chat ───────────────────────────────────────────────────────────────

async function runChatClaudeCode(transcriptContent, messages) {
    const history = messages.slice(0, -1)
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n');
    const last = messages[messages.length - 1].content;
    const instruction = history
        ? `You are a helpful assistant answering questions about a meeting transcript (provided via stdin).\n\nConversation so far:\n${history}\n\nUser: ${last}\n\nAnswer the user's question based on the transcript. Be concise.`
        : `You are a helpful assistant. Answer this question about the meeting transcript (provided via stdin): ${last}\n\nBe concise and factual.`;
    const result = await runClaudeCode(transcriptContent, instruction);
    if (!result.ok) return result;
    return { ok: true, reply: result.summary };
}

async function runChatOpenRouter(transcriptContent, messages, config) {
    const { apiKey, model, baseUrl } = config;
    if (!apiKey) return { ok: false, error: 'OpenRouter API key is not set. Open Settings to add one.' };
    const systemMsg = { role: 'system', content: `You are a helpful assistant answering questions about a meeting. Here is the transcript:\n\n${transcriptContent}` };
    try {
        const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': 'https://github.com/cardpay/unlimeety',
                'X-Title': 'Unlimeety',
            },
            body: JSON.stringify({ model, messages: [systemMsg, ...messages] }),
        }, 300_000);
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { ok: false, error: `OpenRouter error ${res.status}: ${text.slice(0, 500) || res.statusText}` };
        }
        const data = await res.json();
        const reply = data?.choices?.[0]?.message?.content?.trim();
        if (!reply) return { ok: false, error: 'OpenRouter returned an empty response.' };
        return { ok: true, reply };
    } catch (err) {
        if (err.name === 'AbortError') return { ok: false, error: 'Request to OpenRouter timed out.' };
        return { ok: false, error: `OpenRouter request failed: ${err.message}` };
    }
}

async function runChatOpenAICompat(transcriptContent, messages, config) {
    const { apiKey, model, baseUrl } = config;
    if (!baseUrl) return { ok: false, error: 'OpenAI-compatible base URL is not set. Open Settings to add one.' };
    if (!model) return { ok: false, error: 'OpenAI-compatible model is not set.' };
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const systemMsg = { role: 'system', content: `You are a helpful assistant answering questions about a meeting. Here is the transcript:\n\n${transcriptContent}` };
    try {
        const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ model, messages: [systemMsg, ...messages] }),
        }, 300_000);
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { ok: false, error: `OpenAI-compatible error ${res.status}: ${text.slice(0, 500) || res.statusText}` };
        }
        const data = await res.json();
        const reply = data?.choices?.[0]?.message?.content?.trim();
        if (!reply) return { ok: false, error: 'OpenAI-compatible endpoint returned an empty response.' };
        return { ok: true, reply };
    } catch (err) {
        if (err.name === 'AbortError') return { ok: false, error: 'Request to OpenAI-compatible endpoint timed out.' };
        if (err.code === 'ECONNREFUSED' || /fetch failed/i.test(err.message))
            return { ok: false, error: `Cannot reach OpenAI-compatible endpoint at ${baseUrl}. Is the server running?` };
        return { ok: false, error: `OpenAI-compatible request failed: ${err.message}` };
    }
}

async function runChatOllama(transcriptContent, messages, config) {
    const { baseUrl, model } = config;
    if (!model) return { ok: false, error: 'Ollama model is not set.' };
    const systemMsg = { role: 'system', content: `You are a helpful assistant answering questions about a meeting. Here is the transcript:\n\n${transcriptContent}` };
    try {
        const res = await fetchWithTimeout(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, stream: false, messages: [systemMsg, ...messages] }),
        }, 600_000);
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { ok: false, error: `Ollama error ${res.status}: ${text.slice(0, 500) || res.statusText}` };
        }
        const data = await res.json();
        const reply = data?.message?.content?.trim();
        if (!reply) return { ok: false, error: 'Ollama returned an empty response.' };
        return { ok: true, reply };
    } catch (err) {
        if (err.name === 'AbortError') return { ok: false, error: 'Request to Ollama timed out.' };
        if (err.code === 'ECONNREFUSED' || /fetch failed/i.test(err.message))
            return { ok: false, error: `Cannot reach Ollama at ${baseUrl}. Is it running? (\`ollama serve\`)` };
        return { ok: false, error: `Ollama request failed: ${err.message}` };
    }
}

ipcMain.handle('chat:ask', async (_e, target, messages) => {
    // `target` is either a file path (Editor tab — read from disk) or
    // { transcript: 'text' } (Live tab — the transcript is still in memory
    // and grows between messages, so the renderer re-snapshots it on every
    // send to include whatever was spoken while AI was answering).
    let content;
    if (typeof target === 'string') {
        if (!canReadPath(target)) return { ok: false, error: 'File is not accessible.' };
        try {
            content = fs.readFileSync(target, 'utf-8');
        } catch {
            return { ok: false, error: 'Could not read transcript file.' };
        }
    } else if (target && typeof target === 'object' && typeof target.transcript === 'string') {
        content = target.transcript;
    } else {
        return { ok: false, error: 'No transcript provided.' };
    }
    if (!Array.isArray(messages) || messages.length === 0)
        return { ok: false, error: 'No messages provided.' };
    const cfg = readSummarizerConfig();
    switch (cfg.provider) {
        case 'openrouter':        return runChatOpenRouter(content, messages, cfg.openrouter);
        case 'ollama':            return runChatOllama(content, messages, cfg.ollama);
        case 'openai-compatible': return runChatOpenAICompat(content, messages, cfg.openaiCompatible);
        case 'claude-code':
        default:                  return runChatClaudeCode(content, messages);
    }
});

// ─── IPC: Transcripts library ─────────────────────────────────────────────────

function parseTranscriptHeaderMain(content) {
    const info = { title: null, generated: null, recordedAt: null, language: null, participants: [], source: null };
    for (const line of content.split('\n')) {
        if (line === '') break;
        if (line.startsWith('Meeting: '))         info.title       = line.slice(9).trim();
        else if (line.startsWith('Generated: '))  info.generated   = line.slice(11).trim();
        else if (line.startsWith('Recorded-At: ')) info.recordedAt = line.slice(13).trim();
        else if (line.startsWith('Language: '))   info.language    = line.slice(10).trim();
        else if (line.startsWith('Source: '))     info.source      = line.slice(8).trim();
        else if (line.startsWith('Participants: '))
            info.participants = line.slice(14).trim().split(', ').filter(Boolean);
    }
    return info;
}

// Rewrites a single `Key: value` header line in transcript/partial content.
// A function replacement, not a string — a string replacement lets
// String.replace reinterpret $&/$$/$`/$'/$<digit> sequences inside `value`
// (a user-typed title, or a path), corrupting the header instead of writing
// it literally.
function setHeaderLine(content, key, value) {
    return content.replace(new RegExp(`^${key}: .*$`, 'm'), () => `${key}: ${value}`);
}

// Convert the diarizer's raw "S0"/"S1" speaker tags into the Greek phonetic
// alphabet: S0 → Alpha, S1 → Beta, …, S23 → Omega. After Omega the letters
// recycle with a numeric suffix: S24 → Alpha 2, S25 → Beta 2, etc.
const PHONETIC_LETTERS = [
    'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta',
    'Iota', 'Kappa', 'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron', 'Pi',
    'Rho', 'Sigma', 'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega',
];
function humanizeSpeakerLabel(raw) {
    if (raw == null) return raw;
    const s = String(raw);
    if (!s || s === '?' || s === '…' || s === 'Me' || s === 'Speaker') return s;
    const m = s.match(/^S(\d+)$/i);
    if (!m) return s;
    const idx = parseInt(m[1], 10);
    if (Number.isNaN(idx) || idx < 0) return s;
    const base = PHONETIC_LETTERS[idx % PHONETIC_LETTERS.length];
    const cycle = Math.floor(idx / PHONETIC_LETTERS.length);
    return cycle === 0 ? base : `${base} ${cycle + 1}`;
}

// Concatenate participant name lists in order, dropping case-insensitive
// duplicates. Used to put calendar attendee names ahead of speaker labels.
function mergeParticipants(...lists) {
    const out = [];
    const seen = new Set();
    for (const list of lists) {
        for (const name of list || []) {
            const key = String(name).toLowerCase();
            if (key && !seen.has(key)) { seen.add(key); out.push(name); }
        }
    }
    return out;
}

ipcMain.handle('transcripts:getFolder', () => TRANSCRIPTS_FOLDER);

ipcMain.handle('transcripts:list', () => {
    try {
        if (!fs.existsSync(TRANSCRIPTS_FOLDER)) return [];
        return fs.readdirSync(TRANSCRIPTS_FOLDER)
            .filter(f => {
                if (!f.endsWith('.txt')) return false;
                try { return fs.statSync(path.join(TRANSCRIPTS_FOLDER, f)).isFile(); } catch { return false; }
            })
            .map(f => {
                const filePath = path.join(TRANSCRIPTS_FOLDER, f);
                const stat = fs.statSync(filePath);
                try {
                    const raw = fs.readFileSync(filePath, 'utf-8');
                    const blankIdx = raw.indexOf('\n\n');
                    const head = blankIdx >= 0 ? raw.slice(0, blankIdx) : raw;
                    const info = parseTranscriptHeaderMain(head);
                    const recordedAtMs = info.recordedAt ? Date.parse(info.recordedAt) : NaN;
                    const createdAt = Number.isFinite(recordedAtMs)
                        ? recordedAtMs
                        : (stat.birthtimeMs || stat.mtimeMs);
                    const hasSummary = findExistingSummaryPath(filePath) !== null;
                    const audioPaths = findRelatedAudioPaths(filePath);
                    const hasAudio = audioPaths.length > 0;
                    return { filename: f, filePath, createdAt, mtime: stat.mtimeMs, hasSummary, hasAudio, audioPath: audioPaths[0] || null, ...info };
                } catch {
                    return {
                        filename: f, filePath,
                        createdAt: stat.birthtimeMs || stat.mtimeMs,
                        mtime: stat.mtimeMs,
                        hasSummary: false, hasAudio: false,
                        title: f, generated: null, participants: [],
                    };
                }
            })
            .sort((a, b) => b.createdAt - a.createdAt);
    } catch {
        return [];
    }
});

// Full-text content index: filePath -> { mtime, raw, text }. `text` is the
// lowercased body used for matching; `raw` is kept for snippet extraction.
// Self-invalidates per file by mtime, so a re-recorded/edited transcript is
// re-read on the next search without us tracking deletions.
const contentIndex = new Map();

function makeSnippet(raw, idx, qLen) {
    const radius = 40;
    const start = Math.max(0, idx - radius);
    const end = Math.min(raw.length, idx + qLen + radius);
    let s = raw.slice(start, end).replace(/\s+/g, ' ').trim();
    if (start > 0) s = '…' + s;
    if (end < raw.length) s = s + '…';
    return s;
}

ipcMain.handle('transcripts:search', (_e, query) => {
    const q = (query || '').toLowerCase().trim();
    if (!q || !fs.existsSync(TRANSCRIPTS_FOLDER)) return [];
    let files;
    try { files = fs.readdirSync(TRANSCRIPTS_FOLDER); } catch { return []; }
    const results = [];
    for (const f of files) {
        if (!f.endsWith('.txt')) continue;
        const filePath = path.join(TRANSCRIPTS_FOLDER, f);
        let stat;
        try { stat = fs.statSync(filePath); if (!stat.isFile()) continue; } catch { continue; }
        let entry = contentIndex.get(filePath);
        if (!entry || entry.mtime !== stat.mtimeMs) {
            try {
                const raw = fs.readFileSync(filePath, 'utf-8');
                entry = { mtime: stat.mtimeMs, raw, text: raw.toLowerCase() };
                contentIndex.set(filePath, entry);
            } catch { continue; }
        }
        const idx = entry.text.indexOf(q);
        if (idx === -1) continue;
        results.push({ filePath, snippet: makeSnippet(entry.raw, idx, q.length) });
    }
    return results;
});

let libraryWatcher = null;
let libraryChangeTimer = null;
// The file the app itself last wrote, and when. Autosave writes the open
// transcript on every typing pause; without this the watcher would answer each
// one with a transcripts:changed, and the renderer would re-read every
// transcript in the folder and rebuild the sidebar mid-edit.
let lastSelfWrite = { name: null, at: 0 };
const SELF_WRITE_WINDOW_MS = 500; // covers the watcher's own 200ms coalescing

ipcMain.handle('transcripts:watch', () => {
    if (libraryWatcher) return;
    try {
        if (!fs.existsSync(TRANSCRIPTS_FOLDER)) {
            fs.mkdirSync(TRANSCRIPTS_FOLDER, { recursive: true });
        }
        // fs.watch on macOS fires multiple events per single write —
        // coalesce them so the renderer only reloads the library once.
        libraryWatcher = fs.watch(TRANSCRIPTS_FOLDER, (_event, filename) => {
            // Our own autosave: the renderer already knows, and refreshes the
            // library itself when the user leaves the editor.
            const mine = Date.now() - lastSelfWrite.at < SELF_WRITE_WINDOW_MS
                && (!filename || filename === lastSelfWrite.name);
            if (mine) return;
            clearTimeout(libraryChangeTimer);
            libraryChangeTimer = setTimeout(() => {
                mainWindow?.webContents.send('transcripts:changed');
            }, 200);
        });
    } catch (err) {
        console.error('Library watch error:', err);
    }
});

// Find recordings whose filename stem matches a transcript file. Recordings
// are stored as "<base>-<YYYYMMDD-HHMMSS>.wav" (sometimes with " (n)" suffix
// for collisions); transcripts derive their base from the same sanitized
// title. We match defensively — exact base, or base followed by " (n)", then
// a "-" before the timestamp.
function findRelatedAudioPaths(transcriptPath) {
    try {
        const paths = [];
        // Source: field in transcript header — most reliable, use first
        try {
            const head = fs.readFileSync(transcriptPath, 'utf-8').slice(0, 512);
            const info = parseTranscriptHeaderMain(head);
            if (info.source && fs.existsSync(info.source)) paths.push(info.source);
        } catch { /* ignore */ }

        if (!fs.existsSync(RECORDINGS_FOLDER)) return paths;
        const stem = path.basename(transcriptPath, path.extname(transcriptPath));
        // New format: transcript stem matches the WAV stem exactly
        const direct = path.join(RECORDINGS_FOLDER, `${stem}.wav`);
        if (fs.existsSync(direct) && !paths.includes(direct)) paths.push(direct);
        // Legacy format: "<stem>-YYYYMMDD-HHMMSS.wav" with optional " (N)"
        const sanitized = sanitizeRecordingName(stem);
        const esc = sanitized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`^${esc}(?:\\s+\\(\\d+\\))?-\\d{8}-\\d{6}(?:-\\d+)?\\.wav$`, 'i');
        for (const f of fs.readdirSync(RECORDINGS_FOLDER)) {
            if (!re.test(f)) continue;
            const p = path.join(RECORDINGS_FOLDER, f);
            if (!paths.includes(p)) paths.push(p);
        }
        return paths;
    } catch {
        return [];
    }
}

ipcMain.handle('transcripts:getAudioPath', (_e, filePath) => {
    const paths = findRelatedAudioPaths(filePath);
    return paths[0] || null;
});

ipcMain.handle('transcripts:delete', async (_e, filePath) => {
    // Match the *Only delete handlers: never operate on a renderer-supplied path
    // that lies outside the transcripts folder (defense-in-depth vs a compromised
    // renderer). The summary/audio it also removes are derived, not passed in.
    if (typeof filePath !== 'string' || !filePath.startsWith(TRANSCRIPTS_FOLDER)) {
        return { ok: false, error: 'Refusing to operate on a path outside the transcripts folder.' };
    }
    const sumPath = findExistingSummaryPath(filePath);
    const audioPaths = findRelatedAudioPaths(filePath);

    const artifacts = [];
    artifacts.push('the transcript');
    if (sumPath) artifacts.push('its summary');
    if (audioPaths.length === 1) artifacts.push('the audio recording');
    else if (audioPaths.length > 1) artifacts.push(`${audioPaths.length} audio recordings`);

    const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Delete', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Delete this meeting?',
        detail: `${artifacts.join(', ').replace(/, ([^,]+)$/, ' and $1')} will be permanently deleted.`,
    });
    if (choice !== 0) return { ok: false, canceled: true };

    const errors = [];
    const tryUnlink = (p) => {
        try { fs.unlinkSync(p); return true; }
        catch (err) { errors.push(`${path.basename(p)}: ${err.message}`); return false; }
    };
    if (sumPath) tryUnlink(sumPath);
    for (const a of audioPaths) {
        // Only once the wav is actually gone: on EPERM (locked file, read-only
        // volume) the recording survives and the user is told the delete
        // failed — dropping its notes anyway would silently strip them from
        // the next re-transcription. Nothing ever overwrites an orphaned
        // sidecar (flushNotesSidecar early-returns on an empty note list), so
        // a successful delete does have to take it.
        if (tryUnlink(a)) removeNotesSidecar(a);
    }
    tryUnlink(filePath);

    if (errors.length) return { ok: false, error: errors.join('; ') };
    return { ok: true };
});

ipcMain.handle('transcripts:openFile', async (_e, filePath) => {
    // Unlike the main-process open paths (Finder, confined protocol, dialogs),
    // this one is renderer-driven — honour only already-readable paths so a
    // compromised renderer can't use it to read (and then exfiltrate via a
    // remote LLM) arbitrary files.
    if (!canReadPath(filePath)) {
        return { ok: false, error: 'Refusing to open a path outside the managed folders.' };
    }
    openFileFromPath(filePath);
    return { ok: true };
});

// Delete only the .txt transcript. Audio and summary stay on disk.
ipcMain.handle('transcripts:deleteTranscriptOnly', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !filePath.startsWith(TRANSCRIPTS_FOLDER)) {
        return { ok: false, error: 'Refusing to operate on a path outside the transcripts folder.' };
    }
    if (!fs.existsSync(filePath)) {
        return { ok: false, error: 'Transcript not found.' };
    }
    const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Delete', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Delete the transcript?',
        detail: 'Only the .txt transcript will be removed. The audio recording and summary (if any) are kept.',
    });
    if (choice !== 0) return { ok: false, canceled: true };
    try {
        fs.unlinkSync(filePath);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

// Delete only the summary paired with a transcript. Transcript and audio stay.
ipcMain.handle('transcripts:deleteSummaryOnly', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !filePath.startsWith(TRANSCRIPTS_FOLDER)) {
        return { ok: false, error: 'Refusing to operate on a path outside the transcripts folder.' };
    }
    const summaryPath = findExistingSummaryPath(filePath);
    if (!summaryPath) {
        return { ok: false, error: 'No summary found for this meeting.' };
    }
    const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Delete', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Delete the summary?',
        detail: 'Only the summary file will be removed. The audio recording and transcript stay.',
    });
    if (choice !== 0) return { ok: false, canceled: true };
    try {
        fs.unlinkSync(summaryPath);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

// Delete only the audio recording(s) paired with a transcript. Transcript and
// summary stay on disk.
ipcMain.handle('transcripts:deleteAudioOnly', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !filePath.startsWith(TRANSCRIPTS_FOLDER)) {
        return { ok: false, error: 'Refusing to operate on a path outside the transcripts folder.' };
    }
    const audioPaths = findRelatedAudioPaths(filePath);
    if (!audioPaths.length) {
        return { ok: false, error: 'No audio recording found for this meeting.' };
    }
    const detail = audioPaths.length === 1
        ? 'Only the .wav audio file will be removed. The transcript and summary (if any) are kept.'
        : `Only the ${audioPaths.length} .wav audio files will be removed. The transcript and summary (if any) are kept.`;
    const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Delete', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: audioPaths.length === 1 ? 'Delete the audio recording?' : 'Delete the audio recordings?',
        detail,
    });
    if (choice !== 0) return { ok: false, canceled: true };
    const errors = [];
    for (const p of audioPaths) {
        try { fs.unlinkSync(p); }
        catch (err) { errors.push(`${path.basename(p)}: ${err.message}`); }
    }
    if (errors.length) return { ok: false, error: errors.join('; ') };
    return { ok: true };
});

function sanitizeFilenameBase(name) {
    return String(name)
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || 'Transcript';
}

function uniqueFilePath(dir, base, ext) {
    let candidate = path.join(dir, `${base}${ext}`);
    let n = 2;
    while (fs.existsSync(candidate)) {
        candidate = path.join(dir, `${base} (${n})${ext}`);
        n++;
    }
    return candidate;
}

ipcMain.handle('transcripts:create', async (_e, payload) => {
    try {
        const title = String(payload?.title || '').trim();
        const body = String(payload?.content || '').replace(/\r\n/g, '\n');
        if (!title) return { ok: false, error: 'Title is required' };
        if (!body.trim()) return { ok: false, error: 'Transcript content is empty' };

        const participants = Array.isArray(payload?.participants)
            ? payload.participants.map(s => String(s).trim()).filter(Boolean)
            : [];
        const language = typeof payload?.language === 'string' ? payload.language.trim() : '';

        const headerLines = [`Meeting: ${title}`];
        headerLines.push(`Generated: ${new Date().toLocaleString()}`);
        if (participants.length) headerLines.push(`Participants: ${participants.join(', ')}`);
        if (language) headerLines.push(`Language: ${language}`);
        const content = headerLines.join('\n') + '\n\n' + body.replace(/\s+$/, '') + '\n';

        if (!fs.existsSync(TRANSCRIPTS_FOLDER)) {
            fs.mkdirSync(TRANSCRIPTS_FOLDER, { recursive: true });
        }
        const filePath = uniqueFilePath(TRANSCRIPTS_FOLDER, sanitizeFilenameBase(title), '.txt');
        fs.writeFileSync(filePath, content, 'utf-8');
        app.addRecentDocument(filePath);
        return { ok: true, filePath };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

// ─── IPC: Enhance (LLM proofreading pass over the transcript) ─────────────────

// One at a time, process-wide: two passes over the same transcript would each
// hold a full copy in memory and the loser would write its stale one back.
// The enhance lane already guarantees this; the flag only remains to let a
// long-running pass notice a cancel between chunks.
let enhanceCancelled = false;

// Rejections before the first usable part: the same failure repeats on every
// part, so there is nothing to learn from parts 4..500.
const FAIL_FAST_PARTS = 3;

// Enhance is deliberately not a quit-flush slot (see before-quit): it holds
// nothing that must be saved — the file is written only at the end — so quitting
// mid-run costs model time, not data. Cancelling just stops the next call.
app.on('before-quit', () => { enhanceCancelled = true; });

// Every enhance job — user-clicked or auto-chained after a transcribe (see
// runRecordTranscribeJob's return) — runs through the queue, so it always has
// a sink rather than the real `event.sender`. `isDestroyed: () => false` is
// deliberate: a queued job outlives the window that submitted it, and
// teardown-on-navigation belonged to a renderer-owned run.
function makeEnhanceSink(updateProgress) {
    return {
        send: (_channel, payload) => updateProgress(payload),
        once() {}, on() {}, off() {},
        isDestroyed: () => false,
    };
}

// Shared by the manual `transcripts:enhance` handler and any auto-chained
// enhance — `sender` is always the queue's sink now (see makeEnhanceSink).
async function runEnhanceJob(filePath, sender) {
    if (typeof filePath !== 'string' || !isPathInside(filePath, TRANSCRIPTS_FOLDER)) {
        return { ok: false, error: 'Refusing to operate on a path outside the transcripts folder.' };
    }
    // Transcripts only: the folder also holds `.summary.md` files, and a
    // compromised renderer should not be able to have the model rewrite one.
    if (path.extname(filePath).toLowerCase() !== '.txt') {
        return { ok: false, error: 'Enhance only works on a transcript (.txt) file.' };
    }
    if (!canReadPath(filePath) || !canWritePath(filePath)) {
        return { ok: false, error: 'File is not accessible.' };
    }

    let original;
    try {
        original = fs.readFileSync(filePath, 'utf-8');
    } catch {
        return { ok: false, error: 'Could not read transcript file.' };
    }

    const { header, body } = enhance.splitTranscript(original);
    const blocks = enhance.parseBlocks(body);
    const targets = enhance.spokenTargets(blocks, NOTE_LABEL);
    if (!targets.length) {
        return {
            ok: false,
            error: 'No spoken turns to enhance — each turn needs its "[mm:ss] Speaker:" line on a line of its own.',
        };
    }

    const chunks = enhance.chunkBlocks(targets);
    const cfg = readSummarizerConfig();
    // Parsed once for the whole run; `select` still runs per chunk, so the block
    // only carries the terms that chunk plausibly contains.
    const glossaryEntries = glossary.parse(readConfig().glossary || '');

    // A renderer that reloads or goes away can no longer show the result, and the
    // run would otherwise hold the lock for hours and write the file under a
    // window that knows nothing about it.
    const stopOnGone = () => { enhanceCancelled = true; };
    sender.once('destroyed', stopOnGone);
    sender.on('did-start-navigation', stopOnGone);

    enhanceCancelled = false;
    let skipped = 0;
    let done = 0;
    try {
        for (let i = 0; i < chunks.length; i++) {
            if (enhanceCancelled) break;
            const chunk = chunks[i];
            if (!sender.isDestroyed()) {
                sender.send('transcripts:enhanceProgress', {
                    filePath, done: i, total: chunks.length, skipped,
                });
            }
            const rendered = enhance.renderChunk(chunk);
            // Matched against the spoken text only: matching the rendered chunk
            // would also hit the marker lines, so a glossary entry that happens to
            // be a participant's surname was selected in every single chunk.
            const spoken = chunk.map((b) => b.text).join('\n');
            const block = glossary.render(glossary.select(glossaryEntries, spoken));
            const instruction = block
                ? `${enhance.ENHANCE_PROMPT}\n\n${block}`
                : enhance.ENHANCE_PROMPT;
            const result = await runSummarizerProvider(rendered, instruction, cfg);
            // A provider-level failure (no model, no network, no CLI) is the
            // user's problem to fix, not something to paper over by writing a
            // half-enhanced transcript — bail with the file untouched.
            if (!result?.ok) return result;

            const merged = enhance.mergeEnhanced(chunk, result.summary);
            if (!merged.ok) {
                // The only diagnosis there is: the reply itself is long gone by
                // the time the user asks why nothing changed.
                console.warn(`enhance: part ${i + 1}/${chunks.length} skipped — ${merged.reason}`);
                skipped++;
                // Fail fast. The usual cause is a context window smaller than a
                // chunk, and that fails identically on every part — on a long
                // transcript the user would otherwise wait hours to be told.
                if (skipped === FAIL_FAST_PARTS && done === 0) {
                    return {
                        ok: false,
                        error: `The model's reply was unusable for the first ${skipped} parts — nothing was written. `
                            + 'A model with a larger context window usually fixes this.',
                    };
                }
                continue;
            }
            merged.texts.forEach((text, j) => { blocks[chunk[j].index].text = text; });
            done++;
        }

        // Every part rejected is a failure, not a clean transcript. Saying
        // "nothing to fix" here would report a total model failure as success.
        if (!done) {
            if (enhanceCancelled) return { ok: false, canceled: true, applied: 0 };
            return {
                ok: false,
                error: `The model's reply was unusable for all ${chunks.length} part(s) — nothing was written. `
                    + 'A model with a larger context window usually fixes this.',
            };
        }

        // The model call took minutes; the transcript may have been renamed,
        // deleted or edited meanwhile. Writing our in-memory copy over someone
        // else's version would silently lose their edits. Checked before the
        // no-op comparison below, not after: on a run that changed nothing the
        // renderer still gets `original` back, and a stale copy handed to the
        // editor is a lost edit exactly like a stale write.
        let current;
        try {
            current = fs.readFileSync(filePath, 'utf-8');
        } catch {
            return { ok: false, error: 'Transcript disappeared while it was being enhanced.' };
        }
        if (current !== original) {
            return { ok: false, error: 'Transcript changed while it was being enhanced — nothing was written.' };
        }

        const updated = enhance.matchLineEndings(enhance.assembleTranscript(header, blocks), original);
        if (updated === original) {
            return { ok: true, canceled: enhanceCancelled, total: chunks.length, skipped, changed: false };
        }

        writeFileAtomic(filePath, updated);
        // Stamped after the write, like writeTranscriptFile: the watcher event
        // can only arrive once the data is out. Not routed through that helper —
        // it also moves currentFilePath/isDirty, and Enhance runs on transcripts
        // that are not open in the editor.
        lastSelfWrite = { name: path.basename(filePath), at: Date.now() };
        // Cancelling keeps the parts already proofread: they each passed the same
        // gate as any other part, and discarding an hour of model time because the
        // user stopped the rest would be its own kind of loss.
        return {
            ok: true, canceled: enhanceCancelled, total: chunks.length, skipped, applied: done,
            changed: true, content: updated,
        };
    } catch (err) {
        return { ok: false, error: err.message };
    } finally {
        enhanceCancelled = false;
        if (!sender.isDestroyed()) sender.off('did-start-navigation', stopOnGone);
    }
}

queue.registerLane('enhance', {
    run: (job, updateProgress) => runEnhanceJob(job.filePath, makeEnhanceSink(updateProgress)),
    cancel: () => { enhanceCancelled = true; },
});

// Submits and returns immediately — the result (including the updated
// content, for the in-editor reload) arrives via `queue:changed`.
ipcMain.handle('transcripts:enhance', (_e, filePath) => {
    const job = queue.submit('enhance', filePath, { title: path.basename(filePath) });
    return { ok: true, jobId: job.id };
});

ipcMain.handle('transcripts:rename', async (_e, filePath, newTitle) => {
    if (typeof filePath !== 'string' || !filePath.startsWith(TRANSCRIPTS_FOLDER)) {
        return { ok: false, error: 'Refusing to operate on a path outside the transcripts folder.' };
    }
    if (!fs.existsSync(filePath)) return { ok: false, error: 'Transcript not found.' };
    const trimmed = String(newTitle || '').trim();
    if (!trimmed) return { ok: false, error: 'Title cannot be empty.' };

    try {
        const oldSummaryPath = findExistingSummaryPath(filePath);

        const content = fs.readFileSync(filePath, 'utf-8');
        const updated = setHeaderLine(content, 'Meeting', trimmed);
        fs.writeFileSync(filePath, updated, 'utf-8');

        const newBase = sanitizeFilenameBase(trimmed);
        const newPath = uniqueFilePath(TRANSCRIPTS_FOLDER, newBase, '.txt');
        fs.renameSync(filePath, newPath);

        const cfg = readConfig();
        if (cfg.summaryNames?.[filePath]) {
            if (!cfg.summaryNames) cfg.summaryNames = {};
            cfg.summaryNames[newPath] = cfg.summaryNames[filePath];
            delete cfg.summaryNames[filePath];
            writeConfig(cfg);
        }

        const oldStem = path.basename(filePath, '.txt');
        const newStem = path.basename(newPath, '.txt');
        const directAudio = path.join(RECORDINGS_FOLDER, `${oldStem}.wav`);
        if (fs.existsSync(directAudio)) {
            const newAudioPath = path.join(RECORDINGS_FOLDER, `${newStem}.wav`);
            if (!fs.existsSync(newAudioPath)) {
                fs.renameSync(directAudio, newAudioPath);
                // Same reason as record:rename — the sidecar is keyed on the
                // wav stem, so renaming the meeting here would otherwise strand
                // the notes and the next re-transcription would drop them.
                moveNotesSidecar(directAudio, newAudioPath);
            }
        }

        if (oldSummaryPath && fs.existsSync(oldSummaryPath)) {
            const { mtimeMs } = readTranscriptInfoSync(newPath);
            const newSummaryBase = defaultSummaryBase(newPath, { title: trimmed }, mtimeMs);
            const summaryDir = path.dirname(oldSummaryPath);
            const newSummaryPath = path.join(summaryDir, newSummaryBase + '.summary.md');
            if (newSummaryPath !== oldSummaryPath && !fs.existsSync(newSummaryPath)) {
                fs.renameSync(oldSummaryPath, newSummaryPath);
            }
        }

        return { ok: true, newFilePath: newPath };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

// ─── IPC: Live recording (isolated feature) ───────────────────────────────────
// All state and code for the Live tab live in this block. Nothing above uses
// any of it, so removing this block leaves the rest of the app fully working.

const live = {
    proc: null,
    segments: [],   // finalized segments, collected during a session
    stdoutBuf: '',
    stderrBuf: '',
    // When the renderer kicks off a Live session, we compute a WAV path under
    // RECORDINGS_FOLDER (same naming convention as the Record tab) and tell
    // the Swift helper to tee audio there in addition to live transcription.
    // The path is held here so live:saveTranscript can name the .txt with the
    // matching stem — that way transcripts:list and record:list pair them up
    // automatically via findRelatedAudioPaths / recordingTranscriptPath.
    outputPath: null,
    notes: [],            // freeform notes typed during this session: {text, at}
    notesStartedAt: null, // wall-clock anchor notes' elapsed offsets are measured from
};

function liveHelperPath() {
    // Bundled into Contents/MacOS/ (not Resources/) so macOS attributes the
    // helper's mic / Screen Recording grants to the parent app instead of
    // treating it as a separate TCC subject.
    const dev = path.join(__dirname, 'live-helper', '.build', 'release', 'unlimeety-live');
    if (!app.isPackaged && fs.existsSync(dev)) return dev;
    return path.join(path.dirname(app.getPath('exe')), 'unlimeety-live');
}

function liveModelDir() {
    const dir = path.join(app.getPath('userData'), 'models', 'whisperkit');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function liveSendToRenderer(event) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('live:event', event);
}

function liveHandleEvent(event) {
    if (!event || typeof event.type !== 'string') return;

    // Auto-stop signals are handled in main; not forwarded to the renderer.
    if (event.type === 'meetingEnded') { onMeetingEnded('live'); return; }
    if (event.type === 'meetingResumed') { cancelAutoStop('live'); return; }

    // Re-anchor notes' elapsed-time origin to when audio capture actually
    // starts, not when live:start was called — model load can take tens of
    // seconds and would otherwise throw off every note timestamp.
    if (event.type === 'recording') live.notesStartedAt = Date.now();

    if (event.type === 'segment' && event.final === true) {
        live.segments.push(event);
    }
    liveSendToRenderer(event);
}

function liveConsumeStdout(chunk) {
    live.stdoutBuf += chunk;
    let idx;
    while ((idx = live.stdoutBuf.indexOf('\n')) >= 0) {
        const line = live.stdoutBuf.slice(0, idx).trim();
        live.stdoutBuf = live.stdoutBuf.slice(idx + 1);
        if (!line) continue;
        try {
            liveHandleEvent(JSON.parse(line));
        } catch (err) {
            console.warn('live: bad JSON from helper:', line);
        }
    }
}

ipcMain.handle('live:platformOK', () => process.platform === 'darwin');

// On macOS the spawned swift helper inherits the parent process's TCC grant,
// so we trigger the microphone prompt on the Electron side BEFORE spawning.
//
// We deliberately do NOT pre-gate on `getMediaAccessStatus('screen')`:
//   • The API caches results and frequently lies after the user has just
//     granted Screen Recording (TCC and Electron's cache fall out of sync;
//     the value can stay 'denied' until a full relaunch, sometimes longer).
//   • There's no `askForMediaAccess('screen')` — only ScreenCaptureKit in
//     swift can actually trigger the prompt, and only it knows the truth.
// So we let the helper try; if `SCShareableContent` throws because the
// permission isn't actually granted, swift surfaces a precise, user-actionable
// error message that we render as a red banner in the stream.
async function ensureMacPermissions() {
    if (process.platform !== 'darwin') return { ok: true };

    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    if (micStatus !== 'granted') {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        if (!granted) {
            shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
            return {
                ok: false,
                error: `Microphone access denied. Enable ${app.getName()} in System Settings → Privacy & Security → Microphone, then try again.`,
            };
        }
    }

    return { ok: true };
}

// Convenience IPC so the setup form can offer a one-click deep-link to the
// Screen Recording pane. Useful both on first run and after a stale-cache
// situation where the user has already granted but the app still complains.
ipcMain.handle('live:openScreenSettings', () => {
    if (process.platform !== 'darwin') return false;
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    return true;
});

// ─── Calendar (EventKit) ────────────────────────────────────────────────────
// One-shot query: spawn the swift helper, ask for nearby calendar events, read
// the single `calendarEvents` reply, then kill it. Independent of the live
// session above — it never touches the `live` state, so it's safe to run while
// idle. The helper triggers the macOS calendar prompt on first use (Electron
// has no calendar-prompt API like askForMediaAccess('microphone')).
ipcMain.handle('calendar:platformOK', () => process.platform === 'darwin');

ipcMain.handle('calendar:openSettings', () => {
    if (process.platform !== 'darwin') return false;
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars');
    return true;
});

// Shared one-shot helper query: spawn, send `payload`, resolve with the first
// stdout line whose `type` is in `accept` (mapped via `onAccept`), or with an
// error / timeout. Always tears the process down.
function runCalendarQuery(payload, onLine) {
    const helper = liveHelperPath();
    if (!fs.existsSync(helper)) {
        return Promise.resolve({ ok: false, error: `Calendar helper binary not found at ${helper}. Run 'npm run build:helper' first.` });
    }
    return new Promise((resolve) => {
        const proc = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        let buf = '';
        let settled = false;

        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { proc.stdin.end(); } catch {}
            try { proc.kill(); } catch {}
            resolve(result);
        };

        const timer = setTimeout(() => finish({ ok: false, error: 'Calendar query timed out.' }), 8000);

        proc.stdout.on('data', (chunk) => {
            buf += chunk;
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line) continue;
                let event;
                try { event = JSON.parse(line); } catch { continue; }
                if (event.type === 'error') {
                    finish({ ok: false, error: event.message || 'Calendar query failed.', reason: event.reason });
                    return;
                }
                const mapped = onLine(event);
                if (mapped) finish(mapped);
                // otherwise ignore (e.g. the initial {"type":"ready"})
            }
        });
        proc.on('error', (err) => finish({ ok: false, error: err.message }));
        proc.on('close', () => finish({ ok: false, error: 'Calendar helper exited without a response.' }));

        try {
            proc.stdin.write(JSON.stringify(payload) + '\n');
        } catch (err) {
            finish({ ok: false, error: err.message });
        }
    });
}

// Selected calendar ids live in config.calendar.selectedIds. `null`/absent means
// "not configured" → query all calendars; an array (even empty) restricts to it.
function readSelectedCalendarIds() {
    const ids = readConfig().calendar?.selectedIds;
    return Array.isArray(ids) ? ids : null;
}

ipcMain.handle('calendar:list', async (_e, opts) => {
    if (process.platform !== 'darwin') {
        return { ok: false, error: 'Calendar integration is macOS-only.' };
    }
    const payload = { cmd: 'listCalendarEvents' };
    if (opts && Number.isFinite(opts.windowBackMinutes)) payload.windowBackMinutes = opts.windowBackMinutes;
    if (opts && Number.isFinite(opts.windowForwardMinutes)) payload.windowForwardMinutes = opts.windowForwardMinutes;
    const selected = readSelectedCalendarIds();
    if (selected) payload.calendarIds = selected;
    return runCalendarQuery(payload, (event) =>
        event.type === 'calendarEvents'
            ? { ok: true, events: Array.isArray(event.events) ? event.events : [] }
            : null);
});

ipcMain.handle('calendar:listCalendars', async () => {
    if (process.platform !== 'darwin') {
        return { ok: false, error: 'Calendar integration is macOS-only.' };
    }
    return runCalendarQuery({ cmd: 'listCalendars' }, (event) =>
        event.type === 'calendars'
            ? { ok: true, calendars: Array.isArray(event.calendars) ? event.calendars : [] }
            : null);
});

ipcMain.handle('calendar:getSelected', () => readSelectedCalendarIds());

ipcMain.handle('calendar:setSelected', (_e, ids) => {
    const cfg = readConfig();
    cfg.calendar = { ...(cfg.calendar || {}), selectedIds: Array.isArray(ids) ? ids : null };
    writeConfig(cfg);
    return { ok: true };
});

ipcMain.handle('live:start', async (_e, opts) => {
    if (process.platform !== 'darwin') {
        return { ok: false, error: 'Live transcription is macOS-only.' };
    }
    if (live.proc) return { ok: false, error: 'Live session already running.' };

    const helper = liveHelperPath();
    if (!fs.existsSync(helper)) {
        return { ok: false, error: `Live helper binary not found at ${helper}. Run 'npm run build:helper' first.` };
    }

    const perm = await ensureMacPermissions();
    if (!perm.ok) return { ok: false, error: perm.error };

    // Tee audio to a WAV under RECORDINGS_FOLDER using the Record tab's
    // naming convention. The stem becomes "HH-mm DD-MM-YY" (no user title)
    // or "HH-mm DD-MM-YY <title>" when the user typed one. Collision suffix
    // " (N)" mirrors record:start so concurrent or rapid sessions don't
    // clobber each other.
    if (!fs.existsSync(RECORDINGS_FOLDER)) {
        fs.mkdirSync(RECORDINGS_FOLDER, { recursive: true });
    }
    const rawTitle = String(opts?.title || '').trim();
    const stem = defaultRecordingStem(rawTitle);
    let outputPath = path.join(RECORDINGS_FOLDER, `${stem}.wav`);
    let n = 2;
    while (fs.existsSync(outputPath)) {
        outputPath = path.join(RECORDINGS_FOLDER, `${stem} (${n}).wav`);
        n++;
    }

    const sources = Array.isArray(opts?.sources) && opts.sources.length
        ? opts.sources.filter(s => s === 'mic' || s === 'system')
        : ['mic', 'system'];

    const payload = {
        cmd: 'start',
        model: String(opts?.model || 'large-v3-turbo'),
        modelDir: liveModelDir(),
        language: String(opts?.language || 'ru'),
        sources,
        outputPath,
        // Auto-stop only for an active online meeting: both mic and system.
        autoStopOnMeetingEnd: autoStopEnabled() && sources.includes('mic') && sources.includes('system'),
    };

    try {
        live.segments = [];
        live.stdoutBuf = '';
        live.stderrBuf = '';
        live.outputPath = outputPath;
        live.notes = [];
        // Provisional fallback — overwritten precisely once the helper's
        // 'recording' event fires (liveHandleEvent above). Stop is reachable
        // before that event arrives, so this must never be left null.
        live.notesStartedAt = Date.now();
        // A panel left open from a previous (crashed) session is still showing
        // that session's notes: showNotesWindow() below early-returns when one
        // exists, so nothing else would repaint it until the user happened to
        // type — and until then the old notes read as if they belonged here.
        broadcastNotesChanged();

        const proc = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        live.proc = proc;

        proc.stdout.setEncoding('utf-8');
        proc.stderr.setEncoding('utf-8');

        proc.stdout.on('data', (d) => liveConsumeStdout(d));
        proc.stderr.on('data', (d) => {
            // Always mirror helper stderr to the parent terminal so anyone
            // running `npm start` can see exactly what the swift side is
            // doing without needing the TRANSCRIBER_LIVE_DEBUG env flag.
            process.stderr.write(d);
            live.stderrBuf += d;
            // Forward each complete line as a `helperLog` event so the
            // renderer's Diagnostics panel can show recent activity.
            const lines = String(d).split(/\r?\n/);
            for (const line of lines) {
                const t = line.trim();
                if (!t) continue;
                liveSendToRenderer({ type: 'helperLog', line: t });
            }
        });

        proc.on('exit', (code) => {
            // Mirrors the recorder's exit: a helper that dies on its own never
            // reaches live:saveTranscript, so mirror the notes to disk while
            // outputPath still points at the (salvageable) WAV.
            flushNotesSidecar(live);
            liveSendToRenderer({ type: 'exited', code });
            live.proc = null;
            cancelAutoStop('live');
            closeNotesWindow();
        });

        proc.on('error', (err) => {
            liveSendToRenderer({ type: 'error', message: `helper spawn error: ${err.message}` });
            live.proc = null;
            // Node emits 'error' (not 'exit') when the helper fails to spawn at
            // all, so without this the always-on-top notes panel would outlive
            // the session it belongs to, with nothing left to accept its notes.
            closeNotesWindow();
        });

        proc.stdin.write(JSON.stringify(payload) + '\n');
        showNotesWindow();
        return { ok: true, config: payload };
    } catch (err) {
        live.proc = null;
        live.outputPath = null;
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('live:stop', async () => {
    if (!live.proc) return { ok: false, error: 'No live session running.' };
    try {
        live.proc.stdin.write(JSON.stringify({ cmd: 'stop' }) + '\n');
    } catch { /* may already be closed */ }

    // Wait up to 5 s for the helper to flush and exit cleanly.
    await new Promise((resolve) => {
        const t = setTimeout(() => {
            try { live.proc?.kill('SIGTERM'); } catch {}
            resolve();
        }, 5000);
        live.proc?.once('exit', () => { clearTimeout(t); resolve(); });
    });

    return { ok: true };
});

// Pre-fetch a WhisperKit model without starting an actual session. Spawns
// a one-shot helper, forwards download progress to the renderer via the
// existing `live:event` channel (events are tagged with `model` so the
// renderer can route to the correct card), then resolves with ok/error.
ipcMain.handle('live:downloadModel', async (_e, modelName) => {
    if (process.platform !== 'darwin') return { ok: false, error: 'macOS only' };
    if (live.proc) return { ok: false, error: 'a live session is already running' };

    if (typeof modelName !== 'string' || !/^openai_whisper-[A-Za-z0-9._-]+$/.test(modelName)) {
        return { ok: false, error: 'invalid model name' };
    }

    const helper = liveHelperPath();
    if (!fs.existsSync(helper)) {
        return { ok: false, error: `Live helper binary not found at ${helper}.` };
    }

    return new Promise((resolve) => {
        const proc = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        let buf = '';
        let settled = false;

        const finish = (result) => {
            if (settled) return;
            settled = true;
            try { proc.stdin.end(); } catch {}
            try { proc.kill('SIGTERM'); } catch {}
            resolve(result);
        };

        proc.stdout.setEncoding('utf-8');
        proc.stderr.setEncoding('utf-8');

        proc.stdout.on('data', (d) => {
            buf += d;
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line) continue;
                let evt;
                try { evt = JSON.parse(line); } catch { continue; }
                if (evt.type === 'modelDownload') {
                    liveSendToRenderer({ type: 'modelDownloadProgress', model: modelName, progress: evt.progress });
                } else if (evt.type === 'modelDownloaded') {
                    finish({ ok: true });
                } else if (evt.type === 'error') {
                    finish({ ok: false, error: evt.message || 'download failed' });
                }
                // Helper also emits "ready" on boot — ignore.
            }
        });

        proc.stderr.on('data', (d) => { process.stderr.write(d); });

        proc.on('exit', () => finish({ ok: false, error: 'helper exited before completing download' }));
        proc.on('error', (err) => finish({ ok: false, error: err.message }));

        try {
            proc.stdin.write(JSON.stringify({
                cmd: 'downloadModel',
                model: modelName,
                modelDir: liveModelDir(),
            }) + '\n');
        } catch (err) {
            finish({ ok: false, error: err.message });
        }
    });
});

ipcMain.handle('live:saveTranscript', async (_e, payload) => {
    try {
        const title = String(payload?.title || '').trim() || `Live recording — ${new Date().toLocaleString()}`;
        const language = String(payload?.language || '').trim();
        const segments = Array.isArray(payload?.segments) ? payload.segments : live.segments;
        const sourceLabels = { mic: 'Me', system: null }; // null = use diarized speaker

        // Manual speaker → real-name overrides from the Live UI, keyed by
        // 'Me' (mic) / raw diarization label ('S1'…). Bake them into the
        // transcript so the names show up in both the body and Participants.
        //
        // NOTE_LABEL is filtered out here rather than in the renderer that
        // offers the rename: it's the reserved marker for the user's own typed
        // notes, and a speaker renamed onto it would have every turn written as
        // `[mm:ss] Note:` and fed to the summarizer as user-authored context.
        // Guarding at the writer covers every rename popover, present or future.
        const rawNames = (payload && payload.speakerNames && typeof payload.speakerNames === 'object')
            ? payload.speakerNames : {};
        const names = Object.fromEntries(
            Object.entries(rawNames).filter(([, v]) => String(v).trim() !== NOTE_LABEL)
        );

        // Build participant list from speakers actually seen.
        const speakerParticipants = Array.from(new Set(segments.map(s => {
            if (s.source === 'mic') return names['Me'] || 'Me';
            return s.speaker && s.speaker !== '?' && s.speaker !== '…'
                ? (names[s.speaker] || humanizeSpeakerLabel(s.speaker))
                : null;
        }).filter(Boolean)));

        // Names picked from the calendar event (if any) take precedence and are
        // merged ahead of the speaker labels (Me / S1 / S2), deduped case-insensitively.
        const calendarParticipants = Array.isArray(payload?.calendarParticipants)
            ? payload.calendarParticipants.map(p => String(p).trim()).filter(Boolean)
            : [];
        const participants = mergeParticipants(calendarParticipants, speakerParticipants);

        // When the Live session wrote audio to disk, use the WAV stem as the
        // transcript filename so findRelatedAudioPaths / recordingTranscriptPath
        // pair the two automatically. The display title in the header stays
        // user-friendly (no timestamp prefix); only the filename gets the
        // timestamped stem. Inherit the WAV's creation time as Recorded-At
        // so the entry sorts by recording time, not by save time.
        const wavPath = live.outputPath;
        let recordedAtIso = null;
        if (wavPath) {
            try {
                const wavStat = fs.statSync(wavPath);
                recordedAtIso = new Date(wavStat.birthtimeMs || wavStat.mtimeMs).toISOString();
            } catch { /* WAV vanished — skip Recorded-At, use Generated only */ }
        }

        const headerLines = [`Meeting: ${title}`];
        if (recordedAtIso) headerLines.push(`Recorded-At: ${recordedAtIso}`);
        headerLines.push(`Generated: ${new Date().toLocaleString()}`);
        if (participants.length) headerLines.push(`Participants: ${participants.join(', ')}`);
        if (language) headerLines.push(`Language: ${language}`);

        const segBlocks = segments.map(seg => {
            const t = formatHms(seg.start);
            const who = seg.source === 'mic'
                ? (names['Me'] || 'Me')
                : (seg.speaker && seg.speaker !== '?' && seg.speaker !== '…'
                    ? (names[seg.speaker] || humanizeSpeakerLabel(seg.speaker))
                    : 'Speaker');
            return { start: seg.start, block: `[${t}] ${who}:\n${String(seg.text || '').trim()}` };
        });
        const body = interleaveNotes(
            segBlocks, buildNoteBlocks(resolveNotes(live.notes, live.notesStartedAt)));

        const content = headerLines.join('\n') + '\n\n' + body + (body ? '\n' : '');

        if (!fs.existsSync(TRANSCRIPTS_FOLDER)) {
            fs.mkdirSync(TRANSCRIPTS_FOLDER, { recursive: true });
        }
        const filePath = wavPath
            ? path.join(TRANSCRIPTS_FOLDER, `${path.basename(wavPath, '.wav')}.txt`)
            : uniqueFilePath(TRANSCRIPTS_FOLDER, sanitizeFilenameBase(title), '.txt');
        fs.writeFileSync(filePath, content, 'utf-8');
        app.addRecentDocument(filePath);
        // Kept (not deleted) after a successful save: re-transcribing this same
        // wav from the Record tab rewrites the .txt from scratch, and the notes
        // should come back with it.
        flushNotesSidecar(live);
        live.outputPath = null;
        live.notes = [];
        live.notesStartedAt = null;
        // Background-queue a bigger, more accurate re-transcription of this
        // same session, then (on its success) an Enhance pass over the
        // result — no manual action needed. Skipped if the wav never existed
        // or has since vanished; nothing else here depends on it either way.
        if (wavPath && fs.existsSync(wavPath)) queueAutoTranscribe(wavPath, language);
        noteSessionFlushed('live');
        return { ok: true, filePath, audioPath: wavPath };
    } catch (err) {
        // A failed save is still the end of the session — don't make a pending
        // Quit sit out its whole timeout waiting for a save that won't come.
        noteSessionFlushed('live');
        return { ok: false, error: err.message };
    }
});

function formatHms(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

// Reserved pseudo-speaker for the user's own typed notes. Spelled once here:
// both transcript writers, summarize:run's gate and the renderer's
// "not a real speaker" check all key off this single literal.
const NOTE_LABEL = 'Note';

// A note body is free text, but the transcript is line-oriented: parseSegments
// treats a line starting `[<digit>…]` as the start of a new turn. Pasting
// "[04:12] Alice: …" into the note box would therefore re-parse on reopen as a
// bogus Alice turn, and swallow the note's own body. A leading space breaks the
// anchor and is invisible in the note itself.
function escapeNoteText(text) {
    return String(text || '').replace(/^\[/gm, ' [');
}

// Offset of a note from the session's audio clock, in seconds. Deliberately
// *not* clamped: notes typed while the model was still loading predate the
// first audio sample, so their true offset is negative. Keeping it negative
// all the way to disk means their spread and order survive (a 20 s cold load
// otherwise flattens a whole run of notes into one indistinguishable heap),
// and only the rendered timecode — which can't express "before the recording"
// — is pinned to 00:00.
function noteElapsed(note, startedAt) {
    return (note.at - (startedAt || note.at)) / 1000;
}

// In-memory notes ({text, at}) resolved onto the session's audio clock, giving
// the same {start, text} shape the sidecar stores — so both transcript writers
// feed buildNoteBlocks from one representation instead of each spelling the
// marker out for its own.
function resolveNotes(notes, startedAt) {
    return notes.map(n => ({ start: noteElapsed(n, startedAt), text: n.text }));
}

// Turn resolved notes into the same {start, block} shape the segment writers
// produce. The one place the on-disk marker format is spelled out; changing it
// here and missing a caller is what would quietly break summarize:run's gate.
function buildNoteBlocks(notes) {
    return notes.map(n => ({
        start: n.start,
        block: `[${formatHms(n.start)}] ${NOTE_LABEL}:\n${n.text}`,
    }));
}

// Shared by live:saveTranscript and record:transcribe. Sorting on the true
// offset puts pre-roll notes ahead of the first turn in the order they were
// typed; the index tie-break keeps genuinely simultaneous entries stable.
function interleaveNotes(segBlocks, noteBlocks) {
    return [...segBlocks, ...noteBlocks]
        .map((x, i) => ({ ...x, i }))
        .sort((a, b) => a.start - b.start || a.i - b.i)
        .map(x => x.block)
        .join('\n\n');
}

// Make sure we don't leave a zombie helper if the window is closed mid-recording.
app.on('before-quit', () => {
    if (quitFlushing) return;   // the flush above owns teardown while it's running
    if (live.proc) {
        try { live.proc.kill('SIGTERM'); } catch {}
        live.proc = null;
    }
});

// ─── IPC: Record tab (isolated feature) ───────────────────────────────────────
// Record-only mode + on-demand local transcription of saved files. Mirrors
// the Live block's structure: separate helper processes, JSON line protocol,
// events forwarded to the renderer via `record:event`. Independent of Live.

const recorder = {
    proc: null,
    outputPath: null,
    stdoutBuf: '',
    notes: [],            // freeform notes typed during this session: {text, at}
    notesStartedAt: null, // wall-clock anchor notes' elapsed offsets are measured from
};
const transcriber = {
    proc: null,
    stdoutBuf: '',
    // Set when we cut a run short (quit flush, or the user's Cancel). Closing
    // the helper's stdin cancels the in-flight FileTranscriber task rather than
    // letting it finish, so whatever `record:transcribe` writes afterwards is a
    // prefix of the real transcript and must not pass for a complete one.
    interrupted: false,
};

function recordSendToRenderer(event) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('record:event', event);
}

// A short, human label for the job panel — the Record tab keeps its own rich
// per-segment live view (still fed by recordSendToRenderer below); this is
// only the summary a header panel row has room for.
function transcribeStatusLabel(evt) {
    switch (evt?.type) {
        case 'transcribeStarted': return 'Loading model…';
        case 'modelDownload': {
            const pct = Math.round(Math.max(0, Math.min(1, Number(evt.progress) || 0)) * 100);
            return `Downloading model… ${pct}%`;
        }
        case 'loaded': return 'Audio loaded';
        case 'transcribing': return 'Transcribing…';
        case 'diarizing': return 'Labeling speakers…';
        case 'diarizationComplete': return 'Saving transcript…';
        case 'diarizationFailed': return 'Speaker labels unavailable — saving transcript…';
        default: return null;
    }
}

// The transcribe lane's sink: forwards every event to the Record tab exactly
// as a manual run always has (whoever's on that tab keeps its live progress
// view), and separately distills the job's own `progress` for the header
// panel. Used for both the manual `record:transcribe` handler and any
// auto-queued re-transcription — there is no more "silent" variant; every
// transcribe job is an ordinary, visible job. Tagged with the producing
// job's id/filePath: several transcribe jobs can exist at once (one running,
// others queued) and record:event has no other way to say which job a given
// segment/status update belongs to — without this, a background job's
// progress renders into whatever the Record tab happens to have open.
function makeTranscribeSink(job, updateProgress) {
    return (evt) => {
        recordSendToRenderer({ ...evt, jobId: job.id, filePath: job.filePath });
        const label = transcribeStatusLabel(evt);
        if (label) updateProgress({ label });
    };
}

function recordHandleEvent(event) {
    if (event && event.type === 'meetingEnded') { onMeetingEnded('record'); return; }
    if (event && event.type === 'meetingResumed') { cancelAutoStop('record'); return; }
    // Re-anchor notes' elapsed-time origin to when audio capture actually
    // starts, not when record:start was called (mirrors liveHandleEvent).
    if (event && event.type === 'recording') recorder.notesStartedAt = Date.now();
    recordSendToRenderer(event);
}

function sanitizeRecordingName(name) {
    const cleaned = String(name || '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
    return cleaned || 'Recording';
}

function recordingTimestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    return `${pad(d.getHours())}-${pad(d.getMinutes())} ${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${yy}`;
}

function defaultRecordingStem(title) {
    const cleaned = sanitizeRecordingName(title);
    const stamp = recordingTimestamp();
    // 'Recording' is the placeholder used when the user didn't type a title
    // (see record:start handler). In that case the stem is just the timestamp.
    const isDefault = !cleaned || cleaned === 'Recording';
    return isDefault ? stamp : `${stamp} ${cleaned}`;
}

function defaultRecordingPath(title) {
    return path.join(RECORDINGS_FOLDER, `${defaultRecordingStem(title)}.wav`);
}

function spawnHelperWithJsonStdout(onEvent) {
    const helper = liveHelperPath();
    if (!fs.existsSync(helper)) {
        return { ok: false, error: `Live helper binary not found at ${helper}. Run 'npm run build:helper' first.` };
    }
    const proc = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    proc.stdout.setEncoding('utf-8');
    proc.stderr.setEncoding('utf-8');
    proc.stdout.on('data', (d) => {
        buf += d;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try { onEvent(JSON.parse(line)); }
            catch (err) { console.warn('record: bad JSON from helper:', line); }
        }
    });
    proc.stderr.on('data', (d) => {
        process.stderr.write(d);
        for (const line of String(d).split(/\r?\n/)) {
            const t = line.trim();
            if (t) onEvent({ type: 'helperLog', line: t });
        }
    });
    return { ok: true, proc };
}

ipcMain.handle('record:platformOK', () => process.platform === 'darwin');

ipcMain.handle('record:getFolder', () => RECORDINGS_FOLDER);

ipcMain.handle('record:start', async (_e, opts) => {
    if (process.platform !== 'darwin') {
        return { ok: false, error: 'Recording is macOS-only.' };
    }
    if (recorder.proc) return { ok: false, error: 'Recording already in progress.' };

    const perm = await ensureMacPermissions();
    if (!perm.ok) return { ok: false, error: perm.error };

    if (!fs.existsSync(RECORDINGS_FOLDER)) {
        fs.mkdirSync(RECORDINGS_FOLDER, { recursive: true });
    }

    const sources = Array.isArray(opts?.sources) && opts.sources.length
        ? opts.sources.filter(s => s === 'mic' || s === 'system')
        : ['mic', 'system'];

    const title = String(opts?.title || '').trim() || 'Recording';
    const stem = defaultRecordingStem(title);
    let outputPath = path.join(RECORDINGS_FOLDER, `${stem}.wav`);
    let n = 2;
    while (fs.existsSync(outputPath)) {
        outputPath = path.join(RECORDINGS_FOLDER, `${stem} (${n}).wav`);
        n++;
    }

    const spawnRes = spawnHelperWithJsonStdout((evt) => recordHandleEvent(evt));
    if (!spawnRes.ok) return { ok: false, error: spawnRes.error };

    recorder.proc = spawnRes.proc;
    recorder.outputPath = outputPath;
    recorder.notes = [];
    // Provisional fallback — overwritten precisely once the helper's
    // 'recording' event fires (recordHandleEvent above).
    recorder.notesStartedAt = Date.now();
    // Same reason as live:start — repaint any list still showing the previous
    // session's notes rather than waiting for the next add to correct it.
    broadcastNotesChanged();

    recorder.proc.on('exit', (code) => {
        // Before the key is dropped: an unexpected exit (crash, SIGKILL, disk
        // error) never reaches record:stop — its own `!recorder.proc` guard
        // fires first, and the renderer's stopAndSave bails on recordingActive.
        // Nulling outputPath below would also disarm the before-quit backstop,
        // stranding the notes with no path to key them to while the salvaged
        // .wav stays perfectly transcribable.
        flushNotesSidecar(recorder);
        recordSendToRenderer({ type: 'recorderExited', code });
        recorder.proc = null;
        recorder.outputPath = null;
        cancelAutoStop('record');
    });
    recorder.proc.on('error', (err) => {
        recordSendToRenderer({ type: 'error', message: `helper spawn error: ${err.message}` });
        recorder.proc = null;
        recorder.outputPath = null;
    });

    recorder.proc.stdin.write(JSON.stringify({
        cmd: 'record',
        outputPath,
        sources,
        // Auto-stop only for an active online meeting: both mic and system.
        autoStopOnMeetingEnd: autoStopEnabled() && sources.includes('mic') && sources.includes('system'),
    }) + '\n');

    return { ok: true, outputPath, sources };
});

ipcMain.handle('record:stop', async () => {
    if (!recorder.proc) return { ok: false, error: 'No recording in progress.' };
    flushNotesSidecar(recorder);
    try { recorder.proc.stdin.write(JSON.stringify({ cmd: 'stop' }) + '\n'); } catch { /* may already be closed */ }

    await new Promise((resolve) => {
        const t = setTimeout(() => {
            try { recorder.proc?.kill('SIGTERM'); } catch {}
            resolve();
        }, 5000);
        recorder.proc?.once('exit', () => { clearTimeout(t); resolve(); });
    });
    // Belt-and-braces clear of the proc handle: the on('exit') listener does
    // this too, but it runs asynchronously and a Transcribe click right after
    // Stop & save would otherwise hit the "Stop recording before transcribing"
    // guard. Synchronously nulling here closes that race.
    recorder.proc = null;
    recorder.outputPath = null;
    noteSessionFlushed('record');
    return { ok: true };
});

// Not called by any UI yet — the hook a later Record-tab "auto-enhance"
// toggle will call. Same platform gate as `record:transcribe`, checked here
// rather than left for the queue to discover a drain cycle later, and the
// same `canReadPath` confinement every renderer-supplied path gets.
ipcMain.handle('record:autoQueueTranscribe', (_e, filePath, language) => {
    if (process.platform !== 'darwin') {
        return { ok: false, error: 'Local transcription is macOS-only.' };
    }
    if (!canReadPath(filePath)) return { ok: false, error: 'File is not accessible.' };
    const job = queueAutoTranscribe(filePath, typeof language === 'string' ? language : '');
    return { ok: true, jobId: job.id };
});

ipcMain.handle('record:openScreenSettings', () => {
    if (process.platform !== 'darwin') return false;
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    return true;
});

ipcMain.handle('record:list', () => {
    try {
        if (!fs.existsSync(RECORDINGS_FOLDER)) return [];
        return fs.readdirSync(RECORDINGS_FOLDER)
            .filter(f => f.toLowerCase().endsWith('.wav'))
            .map(f => {
                const filePath = path.join(RECORDINGS_FOLDER, f);
                try {
                    const stat = fs.statSync(filePath);
                    if (!stat.isFile()) return null;
                    const transcriptPath = recordingTranscriptPath(filePath);
                    const hasTranscript = fs.existsSync(transcriptPath);
                    const summaryPath = hasTranscript ? findExistingSummaryPath(transcriptPath) : null;
                    return {
                        filename: f,
                        filePath,
                        createdAt: stat.birthtimeMs || stat.mtimeMs,
                        mtime: stat.mtimeMs,
                        size: stat.size,
                        hasTranscript,
                        transcriptPath,
                        hasSummary: Boolean(summaryPath),
                        summaryPath,
                    };
                } catch { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => b.createdAt - a.createdAt);
    } catch {
        return [];
    }
});

function recordingTranscriptPath(wavPath) {
    const base = path.basename(wavPath, path.extname(wavPath));
    return path.join(TRANSCRIPTS_FOLDER, `${base}.txt`);
}

function notesSidecarPath(wavPath) {
    const base = path.basename(wavPath, path.extname(wavPath));
    return path.join(RECORDINGS_FOLDER, `${base}.notes.json`);
}

// The sidecar is keyed purely on the wav stem, so it has to follow the wav
// everywhere the wav goes — and there are two renames that move a wav
// (`record:rename` from the Record tab, `transcripts:rename` from the Editor)
// plus two deletes. Left behind on a rename the notes silently vanish from the
// next transcription; left behind on a delete it outlives the recording and
// gets adopted by whatever later recording lands on that stem.
function moveNotesSidecar(oldWavPath, newWavPath) {
    const from = notesSidecarPath(oldWavPath);
    if (!fs.existsSync(from)) return;
    try { fs.renameSync(from, notesSidecarPath(newWavPath)); }
    catch { /* best-effort: a lost sidecar must not fail the rename */ }
}

function removeNotesSidecar(wavPath) {
    try { fs.unlinkSync(notesSidecarPath(wavPath)); } catch { /* nothing to remove */ }
}

// Notes are captured in memory, but `record:transcribe` is fully decoupled
// from the session that captured them — Re-transcribe and the batch flow know
// only a .wav path, possibly a different app launch later. So every session
// mirrors its notes to a sidecar next to the wav, with elapsed seconds already
// resolved. Live tees its audio into RECORDINGS_FOLDER under the same stem, so
// its notes survive re-transcription (and a crash) exactly like Record's.
function flushNotesSidecar(slot) {
    if (!slot.outputPath || !slot.notes.length) return;
    try {
        const notes = resolveNotes(slot.notes, slot.notesStartedAt);
        fs.writeFileSync(notesSidecarPath(slot.outputPath), JSON.stringify(notes), 'utf-8');
    } catch { /* best-effort — notes are an enhancement, never block stop/quit */ }
}

function readNotesSidecar(wavPath) {
    try {
        const notes = JSON.parse(fs.readFileSync(notesSidecarPath(wavPath), 'utf-8'));
        if (!Array.isArray(notes)) return [];
        // Everything here is re-validated rather than trusted: this file can be
        // hand-edited, synced from another machine, or written by an older
        // build. NaN starts are coerced, and the text is re-escaped — the
        // capture-time escape in notes:add doesn't cover a payload that never
        // went through it, and an unescaped "[04:12] Alice: …" in a note body
        // re-parses as a speaker turn and swallows the note.
        // Negative starts are legitimate (notes taken before audio began) and
        // are preserved for ordering; formatHms pins them to 00:00 on render.
        return notes
            .filter(n => n && typeof n.text === 'string')
            .map(n => ({ start: Number(n.start) || 0, text: escapeNoteText(n.text) }));
    } catch {
        return [];
    }
}

ipcMain.handle('record:delete', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !filePath.startsWith(RECORDINGS_FOLDER)) {
        return { ok: false, error: 'Refusing to delete file outside recordings folder.' };
    }
    const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Delete', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Delete this recording?',
        detail: 'The audio file will be permanently removed. The transcript and summary (if any) are kept.',
    });
    if (choice !== 0) return { ok: false, canceled: true };
    try {
        fs.unlinkSync(filePath);
        removeNotesSidecar(filePath);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

// Bulk-delete several recordings behind a single confirmation. Mirrors
// record:delete — only the .wav files are removed; transcripts and summaries
// (if any) are kept.
ipcMain.handle('record:deleteMany', async (_e, paths) => {
    if (!Array.isArray(paths)) {
        return { ok: false, error: 'Expected an array of recording paths.' };
    }
    const targets = paths.filter(p => typeof p === 'string' && p.startsWith(RECORDINGS_FOLDER));
    if (!targets.length) {
        return { ok: false, error: 'No valid recordings to delete.' };
    }
    const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Delete', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: targets.length === 1 ? 'Delete this recording?' : `Delete ${targets.length} recordings?`,
        detail: 'The audio files will be permanently removed. The transcripts and summaries (if any) are kept.',
    });
    if (choice !== 0) return { ok: false, canceled: true };
    const errors = [];
    let deleted = 0;
    for (const p of targets) {
        try {
            fs.unlinkSync(p);
            removeNotesSidecar(p);
            deleted++;
        } catch (err) {
            errors.push({ path: p, error: err.message });
        }
    }
    if (errors.length && deleted === 0) {
        return { ok: false, error: errors[0].error, errors };
    }
    return { ok: true, deleted, errors };
});

// Delete only the transcript paired with a given recording. The audio file
// and any summary stay on disk.
ipcMain.handle('record:deleteTranscript', async (_e, wavPath) => {
    if (typeof wavPath !== 'string' || !wavPath.startsWith(RECORDINGS_FOLDER)) {
        return { ok: false, error: 'Refusing to operate on a path outside the recordings folder.' };
    }
    const transcriptPath = recordingTranscriptPath(wavPath);
    if (!fs.existsSync(transcriptPath)) {
        return { ok: false, error: 'No transcript found for this recording.' };
    }
    const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Delete', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Delete the transcript?',
        detail: 'Only the .txt transcript will be removed. The audio file and summary (if any) are kept.',
    });
    if (choice !== 0) return { ok: false, canceled: true };
    try {
        fs.unlinkSync(transcriptPath);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

// Delete only the summary paired with a given recording. The audio file and
// transcript stay on disk.
ipcMain.handle('record:deleteSummary', async (_e, wavPath) => {
    if (typeof wavPath !== 'string' || !wavPath.startsWith(RECORDINGS_FOLDER)) {
        return { ok: false, error: 'Refusing to operate on a path outside the recordings folder.' };
    }
    const transcriptPath = recordingTranscriptPath(wavPath);
    if (!fs.existsSync(transcriptPath)) {
        return { ok: false, error: 'No transcript — no summary to delete.' };
    }
    const summaryPath = findExistingSummaryPath(transcriptPath);
    if (!summaryPath) {
        return { ok: false, error: 'No summary found for this recording.' };
    }
    const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Delete', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Delete the summary?',
        detail: 'Only the summary file will be removed. The audio file and transcript are kept.',
    });
    if (choice !== 0) return { ok: false, canceled: true };
    try {
        fs.unlinkSync(summaryPath);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('record:rename', async (_e, wavPath, newTitle) => {
    if (typeof wavPath !== 'string' || !wavPath.startsWith(RECORDINGS_FOLDER)) {
        return { ok: false, error: 'Refusing to operate on a path outside the recordings folder.' };
    }
    if (!fs.existsSync(wavPath)) return { ok: false, error: 'Recording not found.' };
    const trimmed = String(newTitle || '').trim();

    try {
        const oldStem = path.basename(wavPath, '.wav');

        // The popup pre-fills the field with the recording's current full name,
        // so treat the submitted title as the complete new name (the timestamp
        // is kept only if the user leaves it in). Mirrors transcript rename.
        const cleaned = sanitizeRecordingName(trimmed);
        const newStem = cleaned || oldStem;

        let newWavPath = path.join(RECORDINGS_FOLDER, `${newStem}.wav`);
        let n = 2;
        while (fs.existsSync(newWavPath) && newWavPath !== wavPath) {
            newWavPath = path.join(RECORDINGS_FOLDER, `${newStem} (${n}).wav`);
            n++;
        }

        const oldTranscriptPath = recordingTranscriptPath(wavPath);
        const hasTranscript = fs.existsSync(oldTranscriptPath);
        const oldSummaryPath = hasTranscript ? findExistingSummaryPath(oldTranscriptPath) : null;

        if (newWavPath !== wavPath) {
            fs.renameSync(wavPath, newWavPath);
            moveNotesSidecar(wavPath, newWavPath);
        }

        // A cut-short transcription leaves `<stem>.partial.txt` next to the real
        // transcript, keyed to the WAV's stem — and since that stem never
        // matches a WAV's own (the whole point of `.partial`), `Source:` in its
        // header is its *only* link back to the audio. Independent of
        // `hasTranscript`: a partial doesn't count as one.
        const oldPartialPath = oldTranscriptPath.replace(/\.txt$/, '.partial.txt');
        if (fs.existsSync(oldPartialPath)) {
            const titleLine = trimmed || oldStem;
            const partialContent = fs.readFileSync(oldPartialPath, 'utf-8');
            const updatedPartial = setHeaderLine(
                setHeaderLine(partialContent, 'Meeting', titleLine),
                'Source', newWavPath,
            );
            fs.writeFileSync(oldPartialPath, updatedPartial, 'utf-8');

            if (newWavPath !== wavPath) {
                const newPartialStem = path.basename(newWavPath, '.wav');
                let newPartialPath = path.join(TRANSCRIPTS_FOLDER, `${newPartialStem}.partial.txt`);
                let pn = 2;
                while (fs.existsSync(newPartialPath)) {
                    newPartialPath = path.join(TRANSCRIPTS_FOLDER, `${newPartialStem} (${pn}).partial.txt`);
                    pn++;
                }
                fs.renameSync(oldPartialPath, newPartialPath);
            }
        }

        if (hasTranscript) {
            const newTranscriptStem = path.basename(newWavPath, '.wav');
            const newTranscriptPath = path.join(TRANSCRIPTS_FOLDER, `${newTranscriptStem}.txt`);

            const content = fs.readFileSync(oldTranscriptPath, 'utf-8');
            const titleLine = trimmed || oldStem;
            const updated = setHeaderLine(content, 'Meeting', titleLine);
            fs.writeFileSync(oldTranscriptPath, updated, 'utf-8');

            if (newTranscriptPath !== oldTranscriptPath && !fs.existsSync(newTranscriptPath)) {
                fs.renameSync(oldTranscriptPath, newTranscriptPath);
            }

            const cfg = readConfig();
            if (cfg.summaryNames?.[oldTranscriptPath]) {
                cfg.summaryNames[newTranscriptPath] = cfg.summaryNames[oldTranscriptPath];
                delete cfg.summaryNames[oldTranscriptPath];
                writeConfig(cfg);
            }

            if (oldSummaryPath && fs.existsSync(oldSummaryPath)) {
                const actualTxt = fs.existsSync(newTranscriptPath) ? newTranscriptPath : oldTranscriptPath;
                const { mtimeMs } = readTranscriptInfoSync(actualTxt);
                const newSummaryBase = defaultSummaryBase(actualTxt, { title: titleLine }, mtimeMs);
                const summaryDir = path.dirname(oldSummaryPath);
                const newSummaryPath = path.join(summaryDir, newSummaryBase + '.summary.md');
                if (newSummaryPath !== oldSummaryPath && !fs.existsSync(newSummaryPath)) {
                    fs.renameSync(oldSummaryPath, newSummaryPath);
                }
            }
        }

        return { ok: true, newFilePath: newWavPath };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('record:showInFinder', (_e, filePath) => {
    if (typeof filePath !== 'string' || !canReadPath(filePath)) return false;
    shell.showItemInFolder(filePath);
    return true;
});

let recordingsWatcher = null;
let recordingsChangeTimer = null;
ipcMain.handle('record:watch', () => {
    if (recordingsWatcher) return;
    try {
        if (!fs.existsSync(RECORDINGS_FOLDER)) {
            fs.mkdirSync(RECORDINGS_FOLDER, { recursive: true });
        }
        recordingsWatcher = fs.watch(RECORDINGS_FOLDER, () => {
            clearTimeout(recordingsChangeTimer);
            recordingsChangeTimer = setTimeout(() => {
                mainWindow?.webContents.send('record:listChanged');
            }, 200);
        });
    } catch (err) {
        console.error('Recordings watch error:', err);
    }
});

// ─── Pick an external audio file to transcribe ───────────────────────────────
// Supports anything AVAudioFile can decode on macOS (wav, mp3, m4a, mp4, aac,
// aif/aiff, caf, flac). The swift helper's WAVReader already handles the
// resampling/downmixing — we just need a path.

ipcMain.handle('record:pickAudioFile', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose an audio file to transcribe',
        filters: [
            { name: 'Audio Files', extensions: ['wav', 'mp3', 'm4a', 'mp4', 'aac', 'aif', 'aiff', 'caf', 'flac'] },
            { name: 'All Files', extensions: ['*'] },
        ],
        properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    const filePath = result.filePaths[0];
    try {
        const stat = fs.statSync(filePath);
        registerReadablePath(filePath);
        return {
            ok: true,
            filePath,
            size: stat.size,
            createdAt: stat.birthtimeMs || stat.mtimeMs,
            mtime: stat.mtimeMs,
        };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

// ─── Transcribe a saved WAV ──────────────────────────────────────────────────

// Shared by the manual `record:transcribe` handler and any auto-queued
// re-transcription (queueAutoTranscribe) — both now run through the
// transcribe lane, so the queue guarantees only one of these is ever in
// flight at a time. Every clean success queues its own Enhance pass; see the
// return below.
async function runRecordTranscribeJob(opts, sendEvent) {
    if (process.platform !== 'darwin') {
        return { ok: false, error: 'Local transcription is macOS-only.' };
    }

    const filePath = String(opts?.filePath || '');
    if (!canReadPath(filePath)) return { ok: false, error: 'File is not accessible.' };
    if (!filePath || !fs.existsSync(filePath)) {
        return { ok: false, error: 'Recording not found.' };
    }
    const model    = String(opts?.model || 'openai_whisper-large-v3_turbo');
    const language = String(opts?.language || 'ru');

    // Record-tab settings. Sanitised here; the Swift helper treats each as
    // optional and falls back to its own defaults when a field is omitted.
    const diarize = opts?.diarize !== false; // default true
    const spkRaw = Number(opts?.numberOfSpeakers);
    const numberOfSpeakers = Number.isInteger(spkRaw) && spkRaw >= 1 && spkRaw <= 20
        ? spkRaw
        : undefined; // undefined → auto-detect
    const tempRaw = Number(opts?.temperature);
    const temperature = Number.isFinite(tempRaw)
        ? Math.min(1, Math.max(0, tempRaw))
        : undefined;
    const vadFilter = typeof opts?.vadFilter === 'boolean' ? opts.vadFilter : undefined;
    const initialPrompt = typeof opts?.initialPrompt === 'string'
        ? opts.initialPrompt.slice(0, 2000)
        : undefined;
    // Post-processing (not a model param): collapse consecutive same-speaker
    // segments into one bubble. Applied after diarization labels are resolved.
    const mergeAdjacent = opts?.mergeAdjacent !== false; // default true

    // Staleness guard (mirrors runEnhanceJob's own before/after content check):
    // snapshot the canonical transcript path now, at job start, so the write
    // far below can tell whether an editor's autosave — or a rename/delete —
    // landed on it while this (possibly minutes-long) transcription ran. Only
    // the non-partial path is snapshotted: an interrupted run writes to a
    // distinct `.partial.txt` name that nothing else is racing to touch.
    const targetTranscriptPath = recordingTranscriptPath(filePath);
    let transcriptSnapshot;
    try {
        transcriptSnapshot = fs.readFileSync(targetTranscriptPath, 'utf-8');
    } catch {
        transcriptSnapshot = null; // no transcript there yet
    }

    const segments = [];
    let diarSegments = null;
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });

    const spawnRes = spawnHelperWithJsonStdout((evt) => {
        sendEvent(evt);
        if (evt?.type === 'segment' && evt.final === true) segments.push(evt);
        if (evt?.type === 'diarizationComplete' && Array.isArray(evt.segments)) {
            diarSegments = evt.segments;
        }
        // The helper's command loop stays parked on `readLine()` after the
        // FileTranscriber task finishes, so `proc.exit` only fires when we
        // close stdin or SIGTERM the proc. Resolve on the `stopped` event
        // so the renderer's await unblocks the moment the work is actually
        // done; we tear the proc down right after.
        if (evt?.type === 'stopped') resolveDone(0);
    });
    if (!spawnRes.ok) return { ok: false, error: spawnRes.error };

    transcriber.proc = spawnRes.proc;
    // Cleared at the start of every run, so a cancel that lands on one run
    // can't mark the next one partial. Every exit path below is covered.
    transcriber.interrupted = false;

    transcriber.proc.on('exit', (code) => {
        sendEvent({ type: 'transcriberExited', code });
        transcriber.proc = null;
        resolveDone(code);
    });
    transcriber.proc.on('error', (err) => {
        sendEvent({ type: 'error', message: `helper spawn error: ${err.message}` });
        transcriber.proc = null;
        resolveDone(-1);
    });

    transcriber.proc.stdin.write(JSON.stringify({
        cmd: 'transcribeFile',
        path: filePath,
        model,
        modelDir: liveModelDir(),
        language,
        diarize,
        numberOfSpeakers,
        temperature,
        vadFilter,
        initialPrompt,
    }) + '\n');

    await done;

    // The helper might still be sitting in readLine(); shut it down so the
    // process doesn't linger after every transcription.
    if (transcriber.proc) {
        try { transcriber.proc.stdin.end(); } catch {}
        try { transcriber.proc.kill('SIGTERM'); } catch {}
        transcriber.proc = null;
    }

    if (!segments.length) {
        noteSessionFlushed('transcriber');
        return { ok: false, error: 'Transcription produced no text.' };
    }

    // Apply final diarization labels (mirrors LiveSession behaviour).
    if (diarSegments) {
        for (const seg of segments) {
            if (seg.source !== 'system') continue;
            let best = { overlap: 0, label: seg.speaker };
            for (const r of diarSegments) {
                const overlap = Math.max(0, Math.min(seg.end, r.end) - Math.max(seg.start, r.start));
                if (overlap > best.overlap) best = { overlap, label: r.speaker };
            }
            seg.speaker = best.label;
        }
    }

    // Notes taken while this wav was recorded. Read before the merge below,
    // because a merged block keeps only its *first* segment's start — so a
    // note taken deep inside a long same-speaker run would otherwise sort
    // after the entire block and read as a remark about whatever came next.
    const recordedNotes = readNotesSidecar(filePath);

    // Collapse consecutive same-speaker turns into a single bubble.
    let finalSegments = segments;
    if (mergeAdjacent && segments.length) {
        finalSegments = [];
        // The note cursor below only ever advances, so it needs `start` to be
        // non-decreasing across the pass. The helper emits final segments in
        // order today, but nothing enforces it — and an out-of-order arrival
        // (or a future diarization pass that reorders) would rewind past notes
        // the cursor had already stepped over, silently merging across them.
        // Sorting here makes the invariant the optimisation relies on true
        // rather than assumed; the transcript body is sorted by start anyway.
        const ordered = [...segments].sort((a, b) => a.start - b.start);
        // Both arrays now run ascending by `start`, so one advancing cursor
        // answers "is there a note in (prev.start, seg.start]" for the whole
        // pass — rescanning every note per segment would be O(segments × notes),
        // and a two-hour recording brings thousands of segments to this loop.
        const noteStarts = recordedNotes.map(n => n.start).sort((a, b) => a - b);
        let noteCursor = 0;
        for (const seg of ordered) {
            const prev = finalSegments[finalSegments.length - 1];
            // A note taken after the current block began but no later than
            // this turn starts has to render between them, so it ends the
            // block: the note can only land between blocks, and a merged block
            // sorts on its *first* segment's start. Keyed on prev.start, not
            // prev.end — turns are contiguous, so a gap-based test would never
            // fire and every note would drift past the whole run.
            let noteBetween = false;
            if (prev) {
                while (noteCursor < noteStarts.length && noteStarts[noteCursor] <= prev.start) {
                    noteCursor++;
                }
                noteBetween = noteCursor < noteStarts.length && noteStarts[noteCursor] <= seg.start;
            }
            if (prev && !noteBetween && prev.speaker === seg.speaker && prev.source === seg.source) {
                prev.end = seg.end;
                prev.text = `${String(prev.text || '').trim()} ${String(seg.text || '').trim()}`.trim();
            } else {
                finalSegments.push({ ...seg });
            }
        }
    }

    // A cut-short run yields a prefix of the transcript. Write it beside the
    // real path rather than at it: `record:list` keys `hasTranscript` on
    // `<stem>.txt`, so a partial parked there would mark the recording as done
    // and nothing would ever offer to re-run it.
    // Read-only here — the flag is cleared when a run starts, so the early
    // `no segments` return can't strand it set for the next one.
    const interrupted = transcriber.interrupted;
    const transcriptPath = interrupted
        ? recordingTranscriptPath(filePath).replace(/\.txt$/, '.partial.txt')
        : recordingTranscriptPath(filePath);
    try {
        if (!fs.existsSync(TRANSCRIPTS_FOLDER)) fs.mkdirSync(TRANSCRIPTS_FOLDER, { recursive: true });
        const title = path.basename(filePath, path.extname(filePath));
        const speakerParticipants = Array.from(new Set(
            finalSegments.map(s => humanizeSpeakerLabel(s.speaker)).filter(x => x && x !== '?' && x !== '…')
        ));
        // Calendar attendee names (if the picker supplied any) lead the list.
        const calendarParticipants = Array.isArray(opts?.participants)
            ? opts.participants.map(p => String(p).trim()).filter(Boolean)
            : [];
        const participants = mergeParticipants(calendarParticipants, speakerParticipants);
        // Source recording's creation time — let the transcript inherit it for
        // sort/group purposes so the entry doesn't jump to "today" just because
        // it was transcribed later.
        let recordedAtIso = null;
        try {
            const wavStat = fs.statSync(filePath);
            recordedAtIso = new Date(wavStat.birthtimeMs || wavStat.mtimeMs).toISOString();
        } catch { /* file vanished — fall back to generated time */ }
        const headerLines = [`Meeting: ${title}`];
        if (interrupted) headerLines.push('Status: PARTIAL — transcription was interrupted, re-run it for the full text');
        if (recordedAtIso) headerLines.push(`Recorded-At: ${recordedAtIso}`);
        headerLines.push(`Generated: ${new Date().toLocaleString()}`);
        if (participants.length) headerLines.push(`Participants: ${participants.join(', ')}`);
        if (language) headerLines.push(`Language: ${language}`);
        headerLines.push(`Source: ${filePath}`);
        const segBlocks = finalSegments.map(seg => {
            const t = formatHms(seg.start);
            const rawWho = seg.speaker && seg.speaker !== '?' && seg.speaker !== '…' ? seg.speaker : 'Speaker';
            const who = humanizeSpeakerLabel(rawWho);
            return { start: seg.start, block: `[${t}] ${who}:\n${String(seg.text || '').trim()}` };
        });
        // Read from the sidecar above, since this handler knows only the wav
        // path and may be running in a later app launch entirely. Already in
        // {start, text} form, so it shares the Live writer's block builder.
        const body = interleaveNotes(segBlocks, buildNoteBlocks(recordedNotes));
        const content = headerLines.join('\n') + '\n\n' + body + (body ? '\n' : '');

        // Re-check right before writing: only meaningful for the canonical
        // (non-partial) path — see the snapshot comment above.
        if (transcriptPath === targetTranscriptPath) {
            let currentContent;
            try {
                currentContent = fs.readFileSync(targetTranscriptPath, 'utf-8');
            } catch {
                currentContent = null;
            }
            if (currentContent !== transcriptSnapshot) {
                noteSessionFlushed('transcriber');
                return { ok: false, error: 'Transcript changed since transcription started — nothing was written.' };
            }
        }

        fs.writeFileSync(transcriptPath, content, 'utf-8');
        // Keep a partial out of Recent Documents — it isn't a document anyone
        // asked for, it's a salvage file.
        if (!interrupted) {
            app.addRecentDocument(transcriptPath);
            // A completed run supersedes any salvage from an earlier attempt —
            // including one a rename bumped to `<stem> (N).partial.txt` after a
            // same-named partial already at the plain name blocked it. Glob
            // rather than unlink the exact name, or a bumped one survives
            // and doubles up in the Transcripts list beside its own replacement.
            try {
                const stem = path.basename(transcriptPath, '.txt');
                const escapedStem = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const partialPattern = new RegExp(`^${escapedStem}( \\(\\d+\\))?\\.partial\\.txt$`);
                for (const name of fs.readdirSync(TRANSCRIPTS_FOLDER)) {
                    if (!partialPattern.test(name)) continue;
                    // `<stem> (N).partial.txt` is ambiguous: it's either our own
                    // salvage bumped by a rename collision, or a sibling
                    // recording's own partial (record:start/record:rename both
                    // hand out "<stem> (N)" for a genuinely different WAV). A
                    // WAV actually claiming that stem means it's the sibling's -
                    // leave it alone.
                    const candidateStem = name.slice(0, -'.partial.txt'.length);
                    if (candidateStem !== stem && fs.existsSync(path.join(RECORDINGS_FOLDER, `${candidateStem}.wav`))) continue;
                    fs.unlinkSync(path.join(TRANSCRIPTS_FOLDER, name));
                }
            } catch { /* none */ }
        }
        noteSessionFlushed('transcriber');
        if (interrupted) return { ok: false, error: 'Transcription interrupted.', transcriptPath };
        // Any clean transcription — manual, "Re-transcribe…", batch, or
        // auto-queued — chains an Enhance pass over its own result. Submitted
        // (not run inline) so it waits its turn behind whatever else is busy
        // in the enhance lane.
        queue.submit('enhance', transcriptPath, { title: path.basename(transcriptPath) });
        return { ok: true, transcriptPath };
    } catch (err) {
        noteSessionFlushed('transcriber');
        return { ok: false, error: err.message };
    }
}

queue.registerLane('transcribe', {
    run: (job, updateProgress) => runRecordTranscribeJob(job.extra, makeTranscribeSink(job, updateProgress)),
    cancel: () => {
        // Captured now: `transcriber` is a single shared object, and the
        // queue starts the NEXT transcribe job the instant this one settles
        // — so by the time the backstop below fires, `transcriber.proc` may
        // already be a different, unrelated helper process. Only ever act on
        // the one we actually meant to cancel.
        const proc = transcriber.proc;
        if (!proc) return;
        // Same prefix-not-a-transcript problem as the quit flush: the run
        // stops where it stops, so whatever gets written is partial.
        transcriber.interrupted = true;
        try { proc.stdin.write(JSON.stringify({ cmd: 'stop' }) + '\n'); } catch {}
        // Backstop, fire-and-forget: the queue doesn't wait on cancel() — it
        // waits for runRecordTranscribeJob's own promise (`await done`) to
        // settle, which the 'stopped' event above already unblocks in the
        // common case. Cleared on exit (mirrors the old record:cancelTranscribe
        // handler's own clearTimeout) so it can never reach into whatever the
        // next job started in the meantime.
        const t = setTimeout(() => {
            if (transcriber.proc === proc) { try { proc.kill('SIGTERM'); } catch {} }
        }, 5000);
        proc.once('exit', () => clearTimeout(t));
    },
});

// Submits and returns immediately — progress and the final transcriptPath
// arrive via `queue:changed`.
ipcMain.handle('record:transcribe', (_e, opts) => {
    const filePath = String(opts?.filePath || '');
    const job = queue.submit('transcribe', filePath, {
        title: path.basename(filePath || 'Recording'),
        extra: opts,
    });
    return { ok: true, jobId: job.id };
});

ipcMain.handle('record:getInstalledModels', () => {
    const base = path.join(
        app.getPath('userData'), 'models', 'whisperkit',
        'models', 'argmaxinc', 'whisperkit-coreml'
    );
    const known = [
        'openai_whisper-large-v3_turbo',
        'openai_whisper-large-v3',
        'openai_whisper-medium',
        'openai_whisper-small',
        'openai_whisper-base',
        'openai_whisper-tiny',
    ];
    return known.filter(m => fs.existsSync(path.join(base, m, 'AudioEncoder.mlmodelc')));
});

// Remove a WhisperKit model directory from disk. Renderer surfaces this
// from the model picker; on success the badge flips back to "↓ download"
// and the next Start re-downloads it.
ipcMain.handle('record:deleteModel', async (_e, modelName) => {
    try {
        // Tight allow-list on the name shape so an oddly-typed value can't
        // make path.join escape the cache directory.
        if (typeof modelName !== 'string' || !/^openai_whisper-[A-Za-z0-9._-]+$/.test(modelName)) {
            return { ok: false, error: 'invalid model name' };
        }
        const dir = path.join(
            app.getPath('userData'), 'models', 'whisperkit',
            'models', 'argmaxinc', 'whisperkit-coreml',
            modelName
        );
        if (!fs.existsSync(dir)) return { ok: true, removed: false };
        await fs.promises.rm(dir, { recursive: true, force: true });
        return { ok: true, removed: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

// Kill any record/transcribe helper if the app quits mid-flight.
app.on('before-quit', () => {
    if (quitFlushing) return;   // the flush above owns teardown while it's running
    // Backstop: the graceful paths (record:stop / live:saveTranscript) already
    // mirror their notes, this covers a slot the flush timeout had to reap.
    flushNotesSidecar(recorder);
    flushNotesSidecar(live);
    for (const slot of [recorder, transcriber]) {
        if (slot.proc) {
            try { slot.proc.kill('SIGTERM'); } catch {}
            slot.proc = null;
        }
    }
});

// ─── Notes (shared: Live floating window + Record inline control) ──────────
// Freeform timestamped notes, typed either into the Live tab's floating
// window or directly into the Record tab. Both go through the same
// notesApi/notes:add channel; a note lands on whichever of live/recorder is
// currently active (both, if both happen to be running at once).
//
// invoke, not send: with no session running there is nowhere to put the note,
// and the renderers must not paint a row that main threw away.
ipcMain.handle('notes:add', (_e, text) => {
    const clean = escapeNoteText(String(text || '').trim());
    if (!clean) return { ok: false, error: 'empty' };
    const note = { text: clean, at: Date.now() };
    let accepted = false;
    if (live.proc) { live.notes.push(note); accepted = true; }
    if (recorder.proc) { recorder.notes.push(note); accepted = true; }
    if (!accepted) return { ok: false, error: 'no recording in progress' };
    broadcastNotesChanged();
    return { ok: true, text: clean };
});

// Which session a window's note list is about. The floating panel is Live's;
// the main window hosts the Record tab.
function notesSlotFor(sender) {
    const fromNotesWindow = Boolean(notesWindow && !notesWindow.isDestroyed()
        && sender === notesWindow.webContents);
    return fromNotesWindow ? live : recorder;
}

// A note goes into every running slot, so one typed in the floating window
// belongs in the Record tab's list too (and vice versa) whenever both sessions
// are up. Neither window can know that on its own — each only repaints after
// its *own* successful add — so main tells both, and each re-reads its own
// slot. Without this the two lists each show half the notes while both
// transcripts get all of them, which reads as data loss.
function broadcastNotesChanged() {
    for (const win of [notesWindow, mainWindow]) {
        if (win && !win.isDestroyed()) win.webContents.send('notes:changed');
    }
}

// The floating window is closeable and reopenable mid-session, so it can't be
// the source of truth for what has been captured — main is. Hand it the
// session's notes on load so a reopened window shows the real list instead of
// an empty one that reads as data loss.
//
// Addressed by caller, not by preference: notes:add fans a note out to every
// running slot, so with Live and Record both going, "whichever is live" would
// hand the Record tab Live's notes on Live's clock — a list that matches
// neither what the user typed there nor the .txt that session will produce.
// The floating window belongs to Live; anything else is the main window, i.e.
// the Record tab.
ipcMain.handle('notes:list', (e) => {
    // Not gated on a running proc: after a helper crash the session is over but
    // the notes are still here, and being able to re-read them is the whole
    // point of reopening the panel then. An ended-and-saved session has already
    // cleared them, so this returns empty on its own.
    const slot = notesSlotFor(e.sender);
    return resolveNotes(slot.notes, slot.notesStartedAt);
});

// Floating notes window — Live tab only (the Record tab has an inline control
// in its own section instead). Modeled on showPromptWindow() below, but this
// one needs real keyboard focus for its text input, so — unlike that prompt —
// `focusable` is not set to false.
let notesWindow = null;

const NOTES_W = 300, NOTES_H = 380;
// Just tall enough for the header bar alone — used when the user collapses
// the window (mirrors the Chrome extension widget's collapse toggle).
const NOTES_COLLAPSED_H = 54;

function showNotesWindow() {
    if (notesWindow && !notesWindow.isDestroyed()) return;
    const wa = screen.getPrimaryDisplay().workArea;
    const W = NOTES_W, H = NOTES_H;
    notesWindow = new BrowserWindow({
        width: W,
        height: H,
        x: Math.round(wa.x + wa.width - W - 24),
        y: wa.y + 24,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        resizable: false,
        movable: true,
        // Unlike the transient call-detect prompt, this window sticks around
        // for a whole meeting, so it needs normal minimize/restore.
        minimizable: true,
        maximizable: false,
        fullscreenable: false,
        show: false,
        type: 'panel',
        acceptFirstMouse: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    notesWindow.setAlwaysOnTop(true, 'screen-saver');
    notesWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    notesWindow.loadFile(path.join(__dirname, 'renderer', 'notes', 'notes.html'));
    notesWindow.once('ready-to-show', () => {
        notesWindow.showInactive();
        if (process.platform === 'darwin') app.setActivationPolicy('regular');
    });
    notesWindow.on('closed', () => { notesWindow = null; });
}

function closeNotesWindow() {
    if (notesWindow && !notesWindow.isDestroyed()) {
        try { notesWindow.close(); } catch {}
    }
    notesWindow = null;
    if (process.platform === 'darwin') app.setActivationPolicy('regular');
}

ipcMain.on('notes:close', () => closeNotesWindow());

// Collapse toggle — shrinks the window down to just its header bar rather
// than hiding content inside a window that stays full-size, since this is a
// real OS window (not a DOM element the extension's widget can just resize
// via CSS). resizable:false only blocks user drag-resize, not this.
ipcMain.on('notes:setCollapsed', (_e, collapsed) => {
    if (!notesWindow || notesWindow.isDestroyed()) return;
    notesWindow.setSize(NOTES_W, collapsed ? NOTES_COLLAPSED_H : NOTES_H);
});

// Lets the Live tab bring the notes window back after the user closed it
// manually mid-session — showNotesWindow() is a no-op if it's already open.
// Also allowed once the session is over while notes are still held: that's the
// case after a helper crash, when re-reading what was jotted matters most.
// Returns whether anything opened so the caller can say so instead of looking
// broken.
ipcMain.handle('notes:reopen', () => {
    if (!live.proc && !live.notes.length) return { ok: false, error: 'no notes to show' };
    showNotesWindow();
    return { ok: true };
});

// ─── Call auto-detect (mic monitor + prompt) ────────────────────────────────
// Granola/meetily-style: a long-lived swift helper watches whether some *other*
// app is holding the microphone open (a call) — as opposed to mere playback
// (Spotify/YouTube, output only). When a call starts we offer to record it.
// macOS-only; the helper relies on Core Audio process taps.

let tray = null;
let promptWindow = null;
const callMonitor = { proc: null, cooldownUntil: 0 };
// After "Не сейчас" we stay quiet for a while so the same ongoing call (the mic
// stays open the whole time) doesn't trigger repeat prompts.
const PROMPT_COOLDOWN_MS = 5 * 60 * 1000;

function autoDetectEnabled() {
    // Default ON; only an explicit `false` disables it.
    return readConfig().autoDetect?.enabled !== false;
}

function setAutoDetectEnabled(on) {
    const cfg = readConfig();
    cfg.autoDetect = { ...(cfg.autoDetect || {}), enabled: Boolean(on) };
    writeConfig(cfg);
}

// Auto-stop a mic+system recording when the online meeting ends. Default ON;
// only an explicit `false` disables it. Toggled from both the tray menu and the
// in-app Settings modal — both read/write this same flag.
function autoStopEnabled() {
    return readConfig().autoStop?.enabled !== false;
}

function setAutoStopEnabled(on) {
    const cfg = readConfig();
    cfg.autoStop = { ...(cfg.autoStop || {}), enabled: Boolean(on) };
    writeConfig(cfg);
    refreshTrayMenu();
}

function startCallMonitor() {
    if (process.platform !== 'darwin' || callMonitor.proc) return;
    const res = spawnHelperWithJsonStdout((evt) => handleMonitorEvent(evt));
    if (!res.ok) { console.warn('call monitor:', res.error); return; }
    callMonitor.proc = res.proc;
    callMonitor.proc.on('exit', () => { callMonitor.proc = null; });
    callMonitor.proc.on('error', () => { callMonitor.proc = null; });
    try {
        callMonitor.proc.stdin.write(JSON.stringify({ cmd: 'monitorMic', debounceSec: 8 }) + '\n');
    } catch { /* will be retried on next toggle */ }
}

function stopCallMonitor() {
    closePromptWindow();
    if (!callMonitor.proc) return;
    try { callMonitor.proc.stdin.write(JSON.stringify({ cmd: 'stopMonitor' }) + '\n'); } catch {}
    try { callMonitor.proc.stdin.end(); } catch {}
    try { callMonitor.proc.kill('SIGTERM'); } catch {}
    callMonitor.proc = null;
}

function handleMonitorEvent(evt) {
    if (!evt || typeof evt.type !== 'string') return;
    if (evt.type === 'micActive') maybeShowPrompt(evt);
    else if (evt.type === 'micInactive') closePromptWindow(); // call ended first
}

function maybeShowPrompt(evt) {
    if (!autoDetectEnabled()) return;
    if (live.proc || recorder.proc) return;          // we're already capturing
    if (Date.now() < callMonitor.cooldownUntil) return;
    if (promptWindow) return;
    showPromptWindow({ app: evt.app || '' });
}

function showPromptWindow(data) {
    const wa = screen.getPrimaryDisplay().workArea;
    const W = 360, H = 132;
    promptWindow = new BrowserWindow({
        width: W,
        height: H,
        x: Math.round(wa.x + (wa.width - W) / 2),
        y: wa.y + 24,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        resizable: false,
        movable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        show: false,
        // Non-activating overlay: clicking a button must NOT bring the app to
        // the foreground. Otherwise the app activates on click and, when the
        // prompt closes, macOS promotes the main window to key — surfacing it
        // (the "Not now" bug). type:'panel' makes this an NSPanel, which does
        // not activate its owning app on click — so the main window is never
        // promoted. focusable:false keeps it from ever becoming key/active;
        // acceptFirstMouse:true still delivers the click to the buttons.
        type: 'panel',
        focusable: false,
        acceptFirstMouse: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    // Float above full-screen apps (e.g. a full-screen Zoom call).
    promptWindow.setAlwaysOnTop(true, 'screen-saver');
    promptWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    promptWindow.loadFile(path.join(__dirname, 'renderer', 'prompt', 'prompt.html'));
    promptWindow.once('ready-to-show', () => {
        promptWindow.webContents.send('prompt:data', data);
        promptWindow.showInactive();
        // Showing this non-activating NSPanel can drop the app to accessory mode
        // (the Dock icon vanishes). Re-assert 'regular' so the icon stays put for
        // the whole time the prompt is up. This only restores the Dock icon — it
        // does not focus/surface any window, so the main window is not promoted.
        if (process.platform === 'darwin') app.setActivationPolicy('regular');
    });
    promptWindow.on('closed', () => { promptWindow = null; });
}

function closePromptWindow() {
    if (promptWindow && !promptWindow.isDestroyed()) {
        try { promptWindow.close(); } catch {}
    }
    promptWindow = null;
    // Re-assert 'regular' so the Dock icon survives the prompt on every teardown
    // path (record / dismiss / keep recording / auto-stop timeout). This restores
    // only the Dock icon, NOT focus — the prompt was shown with showInactive(), so
    // destroying it never steals focus and the main window is not pulled forward.
    // The icon must disappear only on an explicit Quit, never on a closed window
    // or a dismissed prompt.
    if (process.platform === 'darwin') app.setActivationPolicy('regular');
}

// "Записать" → bring the app forward and open the Live tab so the user can
// start a session manually. Title is pre-filled from a calendar event
// happening right now, when there is one.
async function triggerAutoRecord() {
    closePromptWindow();
    // Restore the Dock icon in case the floating prompt dropped the app to
    // accessory mode; harmless if it didn't. Activation is wanted here anyway.
    if (process.platform === 'darwin') app.setActivationPolicy('regular');
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();

    const title = await currentCalendarTitle();
    const send = () => mainWindow.webContents.send('live:autoStart', { title });
    if (mainWindow.webContents.isLoading()) {
        mainWindow.webContents.once('did-finish-load', send);
    } else {
        send();
    }
}

// Title of a calendar event overlapping "now", or '' (renderer falls back to
// its timestamp-based default name). Reuses the one-shot calendar helper query.
async function currentCalendarTitle() {
    if (process.platform !== 'darwin') return '';
    try {
        const payload = { cmd: 'listCalendarEvents', windowBackMinutes: 30, windowForwardMinutes: 5 };
        const selected = readSelectedCalendarIds();
        if (selected) payload.calendarIds = selected;
        const res = await runCalendarQuery(payload, (e) =>
            e.type === 'calendarEvents' ? { ok: true, events: Array.isArray(e.events) ? e.events : [] } : null);
        if (!res.ok) return '';
        const now = Date.now();
        const hit = res.events.find((ev) => {
            const s = Date.parse(ev.start), end = Date.parse(ev.end);
            return Number.isFinite(s) && Number.isFinite(end) && s <= now + 5 * 60000 && end >= now;
        });
        return hit?.title ? String(hit.title) : '';
    } catch {
        return '';
    }
}

ipcMain.on('prompt:record', () => triggerAutoRecord());
ipcMain.on('prompt:dismiss', () => {
    callMonitor.cooldownUntil = Date.now() + PROMPT_COOLDOWN_MS;
    closePromptWindow();
    // The prompt is a non-activating NSPanel (type:'panel'), so clicking it
    // never brought the app forward — there is no activation to undo and the
    // main window stays where it was.
});

// ─── Auto-stop when the meeting ends (mic+system recordings) ─────────────────
// The helper emits `meetingEnded` when the conferencing app released the mic.
// We show a 15 s countdown prompt with a "Keep recording" escape hatch; if it
// isn't cancelled (manually, or by a `meetingResumed` from a reconnect), we
// drive the same graceful stop+save as the Stop button — delegated to the
// active renderer so Live keeps its transcript-save flow.
const AUTOSTOP_COUNTDOWN_SEC = 15;
let autoStopTimer = null;
// Which session's meeting ended — 'live' or 'record'. Live and a WAV recording
// can run at once, and one meeting ending says nothing about the other session.
let autoStopSlot = null;

// One countdown at a time (the overlay window is a singleton): while one
// session is counting down, the other's `meetingEnded` is dropped rather than
// queued, and nothing re-arms it — that session just keeps recording until it
// is stopped by hand. Fails safe, so a per-slot timer can wait.
function onMeetingEnded(slot) {
    if (autoStopTimer) return;                                   // already counting down
    if (!(slot === 'live' ? live.proc : recorder.proc)) return;  // that one isn't recording
    autoStopSlot = slot;
    showPromptWindow({ mode: 'autostop', seconds: AUTOSTOP_COUNTDOWN_SEC });
    autoStopTimer = setTimeout(() => {
        autoStopTimer = null;
        autoStopSlot = null;
        closePromptWindow();
        triggerAutoStop([slot]);
    }, AUTOSTOP_COUNTDOWN_SEC * 1000);
}

// `slot` scopes the cancel to the session that reported it (a resumed meeting
// or a dead helper says nothing about the other one). Omit it to cancel
// whatever is pending.
function cancelAutoStop(slot) {
    if (!autoStopTimer) return;
    if (slot && autoStopSlot !== slot) return;
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
    autoStopSlot = null;
    closePromptWindow();
}

// Delegate to the named renderers: each runs the same stop+save path as its
// Stop button (Live's transcript assembly lives in the renderer). The countdown
// passes the one slot whose meeting ended; the quit flush passes both.
function triggerAutoStop(slots) {
    if (slots.includes('live') && live.proc) liveSendToRenderer({ type: 'autoStop' });
    if (slots.includes('record') && recorder.proc) recordSendToRenderer({ type: 'autoStop' });
}

ipcMain.on('prompt:keepRecording', () => cancelAutoStop());

// "Stop now" — the same stop+save the countdown would have done, just
// immediately, and to the same single session.
ipcMain.on('prompt:stopNow', () => {
    const slot = autoStopSlot;
    if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
    autoStopSlot = null;
    closePromptWindow();
    if (slot) triggerAutoStop([slot]);
});

// "✕" — hide the overlay only. The countdown keeps running and stops us in the
// background, exactly as if the prompt were still on screen.
ipcMain.on('prompt:hide', () => closePromptWindow());

// ─── Tray (background presence) ─────────────────────────────────────────────
// Without a tray the app is gone once its window closes; the monitor needs the
// process alive to catch calls. macOS-only for now (the monitor is too).

function showMainWindow() {
    if (process.platform === 'darwin') app.setActivationPolicy('regular');
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else {
        // show() alone orders a miniaturized window front without deminiaturizing
        // it, so a Dock click on a minimized window would look like a no-op.
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }
}

// Menu-bar icon embedded as a data URL (36 px PNG of the app logo). It cannot
// be loaded from a file: nativeImage cannot decode our build/icon.icns at all
// (createFromPath returns an empty image → an invisible Tray, which is why the
// menu-bar icon never showed), and the raster icon.png/.ico are git-ignored, so
// they are absent from clean checkouts. Embedding the bytes removes that file
// dependency entirely. Not a template image — the logo is fully opaque, so a
// template would render as a solid black square.
const TRAY_ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAIAAABuYg/PAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAAeGVYSWZNTQAqAAAACAAEARoABQAAAAEAAAA+ARsABQAAAAEAAABGASgAAwAAAAEAAgAAh2kABAAAAAEAAABOAAAAAAAAAJAAAAABAAAAkAAAAAEAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAJKADAAQAAAABAAAAJAAAAAD4g1tdAAAACXBIWXMAABYlAAAWJQFJUiTwAAABy2lUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iWE1QIENvcmUgNi4wLjAiPgogICA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPgogICAgICA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIgogICAgICAgICAgICB4bWxuczpleGlmPSJodHRwOi8vbnMuYWRvYmUuY29tL2V4aWYvMS4wLyI+CiAgICAgICAgIDxleGlmOkNvbG9yU3BhY2U+MTwvZXhpZjpDb2xvclNwYWNlPgogICAgICAgICA8ZXhpZjpQaXhlbFhEaW1lbnNpb24+NTEyPC9leGlmOlBpeGVsWERpbWVuc2lvbj4KICAgICAgICAgPGV4aWY6UGl4ZWxZRGltZW5zaW9uPjUxMjwvZXhpZjpQaXhlbFlEaW1lbnNpb24+CiAgICAgIDwvcmRmOkRlc2NyaXB0aW9uPgogICA8L3JkZjpSREY+CjwveDp4bXBtZXRhPgoAheCYAAADUElEQVRIDe2VuS9tURTG3eOYHzHPoqKRKAxRqBAUoiPEP0Cnk6g0/AUqtUgUNJQKjahEJZEghhDzPM/e77798mXlXK96j+Ql91Rrr+k7a61v7R36+PiI+a7P+y6gME4U7J90O9rG/6+NPr+8tLS0uLgYGxvLgicmJnZ1daWmptpS5ubmVldXcXh/f8/Jyens7ETG4fb2dmpq6vHxMRQKWX+shYWFlZWVxcXFVh8DQH9/v1TkOj4+Rmm/lpYWOdTV1b2+vjrryspKXFycTAEhLy+vt7d3a2tLqcJsPDk5kV9RUVFaWpqOCC8vLxcXF9KUlJS4stCcn5+/vb3JFBCOjo7GxsaampoWFhacyaMzh4eH8svOzo6Pj9cR4e7ujqTSFBQUSCaQcB0/FTY3N3t6etbX17F6Dw8PZ2dn8qP2wACur69tZQEwBRKVnJz849fH4KVH2N3dHRoa4rd8wE5PT2VjsJKdgJXipLRg+/v70ufm5k5PT9MYNE9PT3BqeHj48vLSOczOzq6trfmcb25uFGNzOSVgBMshPz9f8sHBgeSsrKza2lqNACpC6b6+PtiBD7wdHR31mMf9/b1iIsHsRMkFXeUMBSSjDzCzra3NFep8JicnPegLld2ZvtMNxTvBgqWkpFCB0z8/P7MkciYwMGxM4i2y7/ve/Py8AhgsBNHRCXYw6enpWgya/yfiuEAGdHV1pWwNDQ2enQcGzwu+A3YwGRkZ0M3FA6b5o4lkFnVzuQistbXVo7M6w8yZmRkdnRDolSgAcRi7nC1xFOjYwZEeVlRU+M3NzbRbGUdGRiiuvb2dljID4G0bbUbuHS4XgUUyywaygpmZmR7ld3R0KIbmDAwMQOKamprq6ur6+vqNjQ1ZLZilYkJCgogjZ9t/1oB5hyc0ODhYVlYmJwT6w7XCx2LYC8kOJvDjluUulQXDmpSUFAbjIZiYmCgvL7d4n8q2MpsL4oilLpBp2dKp+zcYZvrGBcOLYHc2Es8uxvb2thygKCuoIwIk50qUBjCoEBJhnGFnZ2d5eXlvb0+brgAY1d3drb/h2cSZFPS5tLTUDp4QVn58fJw9g2U8Q1VVVY2NjUEwpf4KIbjCX4GhnFEwteJvhGgb/6Z7iv3WNv4EXcOgGigPg+oAAAAASUVORK5CYII=';

function buildTray() {
    if (process.platform !== 'darwin' || tray) return;
    let icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
    // Down to 18 px (= 18 pt @2x from the 36 px source) for the menu bar.
    if (!icon.isEmpty()) icon = icon.resize({ width: 18, height: 18 });
    else console.warn('[tray] embedded icon decoded empty — menu-bar icon may be invisible');
    tray = new Tray(icon);
    tray.setToolTip('Unlimeety');
    refreshTrayMenu();
}

function refreshTrayMenu() {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Открыть Unlimeety', click: () => showMainWindow() },
        { type: 'separator' },
        {
            label: 'Авто-детект созвонов',
            type: 'checkbox',
            checked: autoDetectEnabled(),
            click: (item) => {
                setAutoDetectEnabled(item.checked);
                if (item.checked) startCallMonitor();
                else stopCallMonitor();
            },
        },
        {
            label: 'Авто-стоп при завершении встречи',
            type: 'checkbox',
            checked: autoStopEnabled(),
            click: (item) => setAutoStopEnabled(item.checked),
        },
        { type: 'separator' },
        { label: 'Выход', click: () => app.quit() },
    ]));
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
    // Register unlimeety:// protocol so the Chrome extension can trigger opens
    // In dev (electron .), pass execPath + appPath so the protocol handler
    // launches "electron /path/to/app" rather than the bare Electron binary.
    app.setAsDefaultProtocolClient('unlimeety', process.execPath, [app.getAppPath()]);
    buildMenu();
    createWindow();
    buildTray();
    if (autoDetectEnabled()) startCallMonitor();

    // A window hidden by the close guard still counts as a window, so re-show
    // rather than only creating one when none exist.
    app.on('activate', () => showMainWindow());
});

app.on('before-quit', () => {
    // `quitting` is set by the flush's own completion, right before the real
    // app.quit() — not here, or it would go true on the very first (prevented)
    // before-quit and wedge the close guard shut for the rest of the session.
    stopCallMonitor();
});

app.on('window-all-closed', () => {
    // On macOS the tray keeps the app (and the call monitor) alive after the
    // window is closed, so we deliberately do NOT quit here.
    if (process.platform !== 'darwin') app.quit();
});
