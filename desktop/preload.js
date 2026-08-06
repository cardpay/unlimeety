const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('transcriber', {
    // File operations
    openFile: () => ipcRenderer.invoke('file:open'),
    saveFile: (filePath, content) => ipcRenderer.invoke('file:save', filePath, content),
    // Blocking twin of saveFile, for beforeunload: the async path can lose the
    // race against process exit on ⌘Q.
    saveFileSync: (filePath, content) => ipcRenderer.sendSync('file:saveSync', filePath, content),
    saveAsFile: (content) => ipcRenderer.invoke('file:saveAs', content),
    exportPdf:  (html, defaultName) => ipcRenderer.invoke('export:pdf', html, defaultName),
    exportDocx: (payload)           => ipcRenderer.invoke('export:docx', payload),

    // Menu events (main → renderer)
    onMenuNew: (cb) => ipcRenderer.on('menu:new', (_e) => cb()),
    onMenuOpen: (cb) => ipcRenderer.on('menu:open', (_e) => cb()),
    onMenuSave: (cb) => ipcRenderer.on('menu:save', (_e) => cb()),
    onMenuSaveAs: (cb) => ipcRenderer.on('menu:saveAs', (_e) => cb()),

    // OS file open (Finder double-click, "Open with", recent docs menu)
    onFileOpened: (cb) => ipcRenderer.on('file:opened', (_e, data) => cb(data)),
    // The renderer can decline an open, so main only commits title/recent-docs
    // state once the file is actually loaded.
    fileAccepted: (filePath) => ipcRenderer.send('file:accepted', filePath),

    // Window title dirty flag
    setDirty: (dirty) => ipcRenderer.send('window:setDirty', dirty),

    // ── Summarization via Claude Code CLI ─────────────────────────────────────
    summarize:    (filePath, promptInstruction) => ipcRenderer.invoke('summarize:run', filePath, promptInstruction),
    chatAsk:      (filePath, messages)          => ipcRenderer.invoke('chat:ask', filePath, messages),
    saveSummary:  (filePath, text, folder)      => ipcRenderer.invoke('summary:save', filePath, text, folder),
    overwriteSummary: (filePath, text, folder)  => ipcRenderer.invoke('summary:overwrite', filePath, text, folder),
    loadSummary:  (filePath, folder)            => ipcRenderer.invoke('summary:load', filePath, folder),
    setSummaryName: (filePath, name)            => ipcRenderer.invoke('summary:setName', filePath, name),

    // ── Settings ──────────────────────────────────────────────────────────────
    getSummaryFolder: () => ipcRenderer.invoke('settings:getSummaryFolder'),
    setSummaryFolder: () => ipcRenderer.invoke('settings:setSummaryFolder'),
    pickFolder:       () => ipcRenderer.invoke('settings:pickFolder'),
    getSummarizer:    ()     => ipcRenderer.invoke('settings:getSummarizer'),
    setSummarizer:    (cfg)  => ipcRenderer.invoke('settings:setSummarizer', cfg),
    getAutoStop:      ()     => ipcRenderer.invoke('settings:getAutoStop'),
    setAutoStop:      (on)   => ipcRenderer.invoke('settings:setAutoStop', on),

    // ── Custom prompts ────────────────────────────────────────────────────────
    listPrompts:  ()       => ipcRenderer.invoke('prompts:list'),
    savePrompt:   (prompt) => ipcRenderer.invoke('prompts:save', prompt),
    deletePrompt: (id)     => ipcRenderer.invoke('prompts:delete', id),

    // ── Transcripts library ───────────────────────────────────────────────────
    getTranscriptsFolder: () => ipcRenderer.invoke('transcripts:getFolder'),
    listTranscripts: () => ipcRenderer.invoke('transcripts:list'),
    searchTranscripts: (q) => ipcRenderer.invoke('transcripts:search', q),
    watchTranscripts: () => ipcRenderer.invoke('transcripts:watch'),
    openFromLibrary: (filePath) => ipcRenderer.invoke('transcripts:openFile', filePath),
    deleteTranscript: (filePath) => ipcRenderer.invoke('transcripts:delete', filePath),
    deleteTranscriptOnly: (filePath) => ipcRenderer.invoke('transcripts:deleteTranscriptOnly', filePath),
    deleteSummaryOnly:    (filePath) => ipcRenderer.invoke('transcripts:deleteSummaryOnly', filePath),
    deleteAudioOnly:      (filePath) => ipcRenderer.invoke('transcripts:deleteAudioOnly', filePath),
    createTranscript: (payload) => ipcRenderer.invoke('transcripts:create', payload),
    renameTranscript: (filePath, newTitle) => ipcRenderer.invoke('transcripts:rename', filePath, newTitle),
    getAudioPath: (filePath) => ipcRenderer.invoke('transcripts:getAudioPath', filePath),
    onTranscriptsChanged: (cb) => ipcRenderer.on('transcripts:changed', () => cb()),

    // ── Follow-up draft ───────────────────────────────────────────────────────
    draftFollowup: (filePath)          => ipcRenderer.invoke('followup:draft', filePath),
    shareFollowup: (service, text, isSummary) => ipcRenderer.invoke('followup:share', service, text, isSummary),

    // ── Shell ─────────────────────────────────────────────────────────────────
    showInFinder: (p) => ipcRenderer.invoke('record:showInFinder', p),
});

// ─── Live tab (isolated namespace) ──────────────────────────────────────────
// Exposed under its own object so the rest of the renderer has no reason to
// touch it. Removing this block and the main.js live block disables the
// feature without affecting the Editor tab.
contextBridge.exposeInMainWorld('live', {
    platformOK:         ()      => ipcRenderer.invoke('live:platformOK'),
    start:              (opts)  => ipcRenderer.invoke('live:start', opts),
    stop:               ()      => ipcRenderer.invoke('live:stop'),
    saveTranscript:     (data)  => ipcRenderer.invoke('live:saveTranscript', data),
    downloadModel:      (name)  => ipcRenderer.invoke('live:downloadModel', name),
    openScreenSettings: ()      => ipcRenderer.invoke('live:openScreenSettings'),
    onEvent:            (cb)    => ipcRenderer.on('live:event', (_e, evt) => cb(evt)),
    // Auto-detect: main asks the Live tab to start a session for a detected call.
    onAutoStart:        (cb)    => ipcRenderer.on('live:autoStart', (_e, data) => cb(data)),
});

// ─── Calendar (isolated namespace) ──────────────────────────────────────────
// macOS EventKit lookup used to pre-fill the meeting title + participants.
// Self-contained: remove this block and the main.js calendar handlers to drop
// the feature without touching Live/Record.
contextBridge.exposeInMainWorld('calendar', {
    platformOK:    ()     => ipcRenderer.invoke('calendar:platformOK'),
    list:          (opts) => ipcRenderer.invoke('calendar:list', opts),
    listCalendars: ()     => ipcRenderer.invoke('calendar:listCalendars'),
    getSelected:   ()     => ipcRenderer.invoke('calendar:getSelected'),
    setSelected:   (ids)  => ipcRenderer.invoke('calendar:setSelected', ids),
    openSettings:  ()     => ipcRenderer.invoke('calendar:openSettings'),
});

// ─── Record tab (isolated namespace) ────────────────────────────────────────
// Record-only mode (save raw audio) and on-demand local transcription of
// saved recordings. Independent of the Live namespace above.
contextBridge.exposeInMainWorld('recordApi', {
    platformOK:         ()       => ipcRenderer.invoke('record:platformOK'),
    getFolder:          ()       => ipcRenderer.invoke('record:getFolder'),
    start:              (opts)   => ipcRenderer.invoke('record:start', opts),
    stop:               ()       => ipcRenderer.invoke('record:stop'),
    openScreenSettings: ()       => ipcRenderer.invoke('record:openScreenSettings'),
    list:               ()       => ipcRenderer.invoke('record:list'),
    watch:              ()       => ipcRenderer.invoke('record:watch'),
    delete:             (p)      => ipcRenderer.invoke('record:delete', p),
    deleteMany:         (paths)  => ipcRenderer.invoke('record:deleteMany', paths),
    deleteTranscript:   (p)      => ipcRenderer.invoke('record:deleteTranscript', p),
    deleteSummary:      (p)      => ipcRenderer.invoke('record:deleteSummary', p),
    rename:             (p, t)   => ipcRenderer.invoke('record:rename', p, t),
    showInFinder:       (p)      => ipcRenderer.invoke('record:showInFinder', p),
    pickAudioFile:      ()       => ipcRenderer.invoke('record:pickAudioFile'),
    transcribe:         (opts)   => ipcRenderer.invoke('record:transcribe', opts),
    cancelTranscribe:   ()       => ipcRenderer.invoke('record:cancelTranscribe'),
    getInstalledModels: ()       => ipcRenderer.invoke('record:getInstalledModels'),
    deleteModel:        (name)   => ipcRenderer.invoke('record:deleteModel', name),
    onEvent:            (cb)     => ipcRenderer.on('record:event', (_e, evt) => cb(evt)),
    onListChanged:      (cb)     => ipcRenderer.on('record:listChanged', () => cb()),
});

// ─── Call-detection prompt (isolated namespace) ─────────────────────────────
// Used only by the small frameless prompt window (renderer/prompt/). Harmless
// to the main window, which simply never calls it.
contextBridge.exposeInMainWorld('promptApi', {
    onData:  (cb) => ipcRenderer.on('prompt:data', (_e, data) => cb(data)),
    record:  ()   => ipcRenderer.send('prompt:record'),
    dismiss: ()   => ipcRenderer.send('prompt:dismiss'),
    // Auto-stop countdown: user chose to keep recording → cancel the stop.
    keepRecording: () => ipcRenderer.send('prompt:keepRecording'),
    // Auto-stop countdown: stop right now instead of waiting it out.
    stopNow: () => ipcRenderer.send('prompt:stopNow'),
    // Auto-stop countdown: hide the overlay, but let the countdown run out.
    hide: () => ipcRenderer.send('prompt:hide'),
});

// ─── Notes (isolated namespace) ──────────────────────────────────────────────
// Freeform timestamped notes captured during a Live or Record session. Shared
// across the floating notes window (Live) and the inline Record-tab control —
// both call the same two methods.
contextBridge.exposeInMainWorld('notesApi', {
    // invoke, not send: main is the one that knows whether a session is running
    // to attach the note to, and the UI must not claim a note was saved when it
    // wasn't. Resolves { ok, text } — `text` is the stored (escaped) form.
    add:          (text)      => ipcRenderer.invoke('notes:add', text),
    // Notes captured so far in the active session, so a reopened floating
    // window shows the real list instead of a misleading empty one.
    list:         ()          => ipcRenderer.invoke('notes:list'),
    close:        ()          => ipcRenderer.send('notes:close'),
    reopen:       ()          => ipcRenderer.send('notes:reopen'),
    setCollapsed: (collapsed) => ipcRenderer.send('notes:setCollapsed', collapsed),
});
