/* ─────────────────────────────────────────────────────────────────────────────
 * Unlimeety Desktop — Record tab (isolated)
 *
 * Lives behind `window.recordApi` (exposed by preload.js). Has NO references
 * to app.js or live.js internals; the only shared contract is the tab
 * switcher (handled by live.js) and the `.tab-btn` markup in index.html.
 *
 * Four high-level states:
 *   idle               → setup form + past recordings (Start)
 *   recording          → big pulse + timer + meters (Stop & save)
 *   transcribeSettings → batch model/lang/diarize config (Transcribe / Cancel)
 *   transcribing       → progress + streaming segments (Cancel)
 * ─────────────────────────────────────────────────────────────────────── */

(() => {
    const api = window.recordApi;
    if (!api) {
        console.warn('[record] window.recordApi is not exposed; Record tab disabled');
        return;
    }
    const queueApi = window.queueApi;

    // ─── DOM refs ────────────────────────────────────────────────────────
    const $ = (id) => document.getElementById(id);

    const unsupportedBanner = $('record-unsupported');
    const mainArea          = $('record-main');

    const setupSection      = $('record-setup');
    const recordingSection  = $('record-recording');
    const tsSection         = $('record-transcribe-settings');
    const transcribeSection = $('record-transcribing');
    // Wraps ts/transcribe sections — a top-level panel of its own (see
    // record.css), shown independently of which tab is active underneath.
    const transcribeFlowWrap = $('transcribe-flow');

    const srcMicCheck       = $('record-src-mic');
    const srcSystemCheck    = $('record-src-system');
    const titleInput        = $('record-title');
    const startBtn          = $('record-btn-start');
    const importBtn         = $('record-btn-import');
    const setupError        = $('record-setup-error');
    const openScreenSettingsBtn = $('record-open-screen-settings');
    const micStatusEl       = $('record-mic-status');

    const statusDot   = $('record-status-dot');
    const statusText  = $('record-status-text');
    const timerEl     = $('record-timer');
    const outputPathEl = $('record-output-path');
    const stopBtn     = $('record-btn-stop');
    // Language for the transcription that fires on Stop & save, offered twice:
    // on the setup screen for when you already know it, and on the recording
    // screen for when you find out mid-call. Not extra state — both read and
    // write `batchSettings.language`, the same value #ts-lang-seg edits.
    const setupLangSeg = $('record-setup-lang-seg');
    const recLangSeg   = $('record-rec-lang-seg');
    // Every language picker this tab owns. One list, so adding another one is a
    // single edit and cannot half-wire itself.
    const langSegs = [setupLangSeg, recLangSeg];

    const notesListEl  = $('record-notes-list');
    const notesEmptyEl = $('record-notes-empty');
    const notesInputEl = $('record-notes-input');

    // Transcribe-settings screen (Variant C) refs.
    const tsBatchCount   = $('ts-batch-count');
    const tsBatchSub     = $('ts-batch-sub');
    const tsBatchList    = $('ts-batch-list');
    const tsModelGrid    = $('ts-model-grid');
    const tsLangSeg      = $('ts-lang-seg');
    const tsDiarizeToggle = $('ts-diarize-toggle');
    const tsDiaInner     = $('ts-dia-inner');
    const tsSpkPills     = $('ts-spk-pills');
    const tsMergeAdjacent = $('ts-merge-adjacent');
    const tsInitialPrompt = $('ts-initial-prompt');
    const tsTemperature  = $('ts-temperature');
    const tsTemperatureVal = $('ts-temperature-val');
    const tsVadFilter    = $('ts-vad-filter');
    const tsEtaTotal     = $('ts-eta-total');
    const tsEtaSub       = $('ts-eta-sub');
    const tsBtnTranscribe = $('ts-btn-transcribe');
    const tsBtnTranscribeLabel = $('ts-btn-transcribe-label');
    const tsBtnCancel    = $('ts-btn-cancel');
    const tsBtnSavePreset = $('ts-btn-save-preset');
    const tsEditSelection = $('ts-edit-selection');
    const tsPresetSelect = $('ts-preset-select');
    const tsPresetStatus = $('ts-preset-status');
    const tsPresetDelete = $('ts-preset-delete');
    const tsError        = $('ts-error');

    const MODEL_INFO = {
        'openai_whisper-large-v3_turbo': { label: 'large-v3 turbo', realtime: 6 },
        'openai_whisper-large-v3':       { label: 'large-v3',       realtime: 3 },
        'openai_whisper-medium':         { label: 'medium',         realtime: 4 },
        'openai_whisper-small':          { label: 'small',          realtime: 8 },
        'openai_whisper-base':           { label: 'base',           realtime: 12 },
        'openai_whisper-tiny':           { label: 'tiny',           realtime: 20 },
    };

    const transDot    = $('record-trans-dot');
    const transStatus = $('record-trans-status');
    const transDownload = $('record-trans-download');
    const transProgressBar = $('record-trans-progress-bar');
    const transStream = $('record-trans-stream');
    const cancelTransBtn         = $('record-btn-cancel-trans');
    const newRecordingFromTransBtn = $('record-btn-new-recording');
    const tsBtnClose             = $('ts-btn-close');
    const transActiveBanner      = $('record-trans-active-banner');
    const viewQueueBtn           = $('record-btn-view-queue');

    document.getElementById('recording-indicator')
        ?.addEventListener('click', () => {
            document.querySelector('[data-tab="record"]')?.click();
            if (state.recordingActive) {
                showSection('recording');
                // Coming back to a running session: repaint from main, or the
                // list sits empty while recorder.notes holds everything — the
                // same "your notes are gone" state the floating window avoids.
                refreshNotes();
            }
        });

    const meters = {
        mic:    document.querySelector('#record-container .live-level-meter[data-meter="mic"]'),
        system: document.querySelector('#record-container .live-level-meter[data-meter="system"]'),
    };
    const meterContainers = {
        mic:    document.querySelector('#record-container [data-source="mic"]'),
        system: document.querySelector('#record-container [data-source="system"]'),
    };

    // ─── State ───────────────────────────────────────────────────────────
    const state = {
        phase: 'idle',  // 'idle' | 'recording' | 'transcribeSettings' | 'transcribing'
        // True while audio is being captured to disk. Independent of `phase`:
        // recording can keep running while the user is in transcribeSettings /
        // transcribing sections (parallel transcription, commit b987b18).
        recordingActive: false,
        startedAt: 0,
        timerInterval: null,
        outputPath: null,
        activeSources: [],
        // Attendee names from a calendar event picked on the setup screen. Used
        // for the transcript's "Participants:" line when transcribing in the
        // same session (no participants field exists in the Record UI).
        calendarParticipants: [],
        batchSettings: {
            model: 'openai_whisper-large-v3',
            language: 'auto',
            diarize: true,
            expectedSpeakers: '3',
            mergeAdjacent: true,
            initialPrompt: '',
            temperature: 0,
            // VAD chunking skips audio it scores as silence; on real meeting
            // recordings it drops ~40% of speech (incl. whole openings), so it
            // stays OFF by default. Users can still opt in via the toggle.
            vadFilter: false,
        },
        // True only for the short window where runBatchTranscribe is still
        // firing off its submit calls — guards against a double-click queuing
        // the same batch twice. Not a transcribing indicator any more (the
        // queue is): see anyTranscribeActive below.
        batchRunning: false,
        // Set when the user enters the settings screen: holds the file paths
        // queued for the eventual batch run. Cleared when the batch finishes
        // or the user backs out via Cancel.
        pendingBatchTargets: null,
    };

    // The recordings the transcribe-settings screen renders its batch rows
    // from. The list itself lives in the Meetings sidebar (app.js) now; this
    // tab keeps a copy only to label the batch it is about to run.
    let currentItems = [];

    // ─── Job queue ───────────────────────────────────────────────────────
    // The single source of truth for "is this file transcribing" — replaces
    // the old locally-tracked `transcribingPaths` set, which could only ever
    // reflect a run this renderer itself started sequentially. A submit now
    // returns immediately, and a transcribe can just as well be an
    // auto-chained re-transcription this tab never asked for.
    let queueJobs = [];
    // The job this tab's own "transcribing" screen (single-file flow) is
    // currently watching — what the Cancel button on that screen targets.
    let currentTranscribeJobId = null;

    function anyTranscribeActive() {
        return queueJobs.some((j) => j.type === 'transcribe' && (j.status === 'queued' || j.status === 'running'));
    }

    // ─── Transcribe presets + auto-persisted settings (localStorage) ─────────
    // There's no main-process settings store; the renderer owns this. We keep
    // the working batchSettings in localStorage (auto-memory) plus a list of
    // named presets the user can select / overwrite / delete.
    const LS_SETTINGS = 'record.batchSettings';
    const LS_PRESETS  = 'record.transcribePresets';
    const LS_ACTIVE   = 'record.activePreset';
    const LS_VER      = 'record.batchSettingsVer';
    const SETTINGS_VER = '2'; // bump when a default must be force-reset on existing installs

    // Restore last-used settings so the panel reopens where the user left it.
    try {
        const saved = JSON.parse(localStorage.getItem(LS_SETTINGS) || 'null');
        if (saved && typeof saved === 'object') {
            state.batchSettings = { ...state.batchSettings, ...saved };
        }
    } catch (_) {}

    // One-time migration: earlier builds shipped vadFilter ON by default and
    // auto-persisted it, which silently dropped ~40% of transcribed speech.
    // Force it back off once for installs that predate this fix, then stamp
    // the version so we never override the user's later choice again.
    try {
        if (localStorage.getItem(LS_VER) !== SETTINGS_VER) {
            state.batchSettings.vadFilter = false;
            localStorage.setItem(LS_SETTINGS, JSON.stringify(state.batchSettings));
            localStorage.setItem(LS_VER, SETTINGS_VER);
        }
    } catch (_) {}

    let presets = [];
    try { presets = JSON.parse(localStorage.getItem(LS_PRESETS) || '[]') || []; } catch (_) { presets = []; }
    let activePreset = localStorage.getItem(LS_ACTIVE) || null;
    let presetDirty = false;

    function persistBatchSettings() {
        try { localStorage.setItem(LS_SETTINGS, JSON.stringify(state.batchSettings)); } catch (_) {}
    }
    function persistPresets() {
        try { localStorage.setItem(LS_PRESETS, JSON.stringify(presets)); } catch (_) {}
    }
    function setActivePreset(name) {
        activePreset = name;
        try {
            if (name) localStorage.setItem(LS_ACTIVE, name);
            else localStorage.removeItem(LS_ACTIVE);
        } catch (_) {}
    }
    // Called after every user-driven settings edit: refresh auto-memory and
    // flag the active preset as diverged from its saved snapshot.
    function onBatchSettingsChanged() {
        persistBatchSettings();
        if (activePreset) { presetDirty = true; renderPresetSelect(); }
    }
    function renderPresetSelect() {
        if (!tsPresetSelect) return;
        const cur = activePreset && presets.some(p => p.name === activePreset) ? activePreset : '';
        if (!cur) activePreset = null;
        tsPresetSelect.innerHTML = '';
        const custom = document.createElement('option');
        custom.value = '';
        custom.textContent = 'Custom (unsaved)';
        tsPresetSelect.appendChild(custom);
        for (const p of presets) {
            const opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = p.name;
            tsPresetSelect.appendChild(opt);
        }
        tsPresetSelect.value = cur;
        if (tsPresetStatus) tsPresetStatus.textContent = cur && presetDirty ? '• modified' : '';
        if (tsPresetDelete) tsPresetDelete.disabled = !cur;
    }
    function applyPreset(name) {
        const p = presets.find(x => x.name === name);
        if (!p) return;
        state.batchSettings = { ...state.batchSettings, ...p.settings };
        setActivePreset(name);
        presetDirty = false;
        persistBatchSettings();
        applyBatchSettingsToScreen();
        recomputeTsEta();
        renderPresetSelect();
    }

    // ── auto-transcribe ──
    // Two pure helpers, kept together and free of module state so
    // test/record-auto-transcribe.test.js can drive them directly.

    // A recording this short holds no speech worth a large-v3 run — the job
    // would spend minutes to fail with "produced no text". Below the threshold
    // the wav is still saved and still listed under "To transcribe", so nothing
    // is lost; it just is not queued automatically.
    const MIN_AUTO_TRANSCRIBE_SEC = 1;

    /// What to hand `autoQueueTranscribe` when a recording is saved, or null
    /// when there is nothing worth transcribing. `event.path` is main's
    /// canonical answer; `st.outputPath` is the one start() reported, used when
    /// a `recordSaved` arrives without one.
    function autoTranscribeArgs(event, st) {
        const filePath = (event && event.path) || st.outputPath || '';
        if (!filePath) return null;
        // Absent duration (an older helper) must not block the queue — only a
        // duration we have and know to be too short does.
        const durationSec = Number(event && event.durationSec);
        if (Number.isFinite(durationSec) && durationSec > 0 && durationSec < MIN_AUTO_TRANSCRIBE_SEC) {
            return null;
        }
        return {
            filePath,
            language: st.batchSettings.language,
            participants: Array.isArray(st.calendarParticipants) ? st.calendarParticipants : [],
        };
    }

    /// Paint every language picker from one value. Both pickers go through
    /// here, so the recording screen and the settings screen cannot disagree
    /// about which language is selected. `aria-checked` rides along: the pills
    /// are a radio group built from buttons, so it is the only thing that tells
    /// a screen reader which one is chosen.
    function paintLangSegs(containers, lang) {
        for (const box of containers) {
            if (!box) continue;
            for (const seg of box.querySelectorAll('.ts-seg')) {
                const on = seg.dataset.lang === lang;
                seg.classList.toggle('is-active', on);
                seg.setAttribute('aria-checked', on ? 'true' : 'false');
            }
        }
    }
    // ── end auto-transcribe ──

    // The settings screen paints itself when it opens (renderTsScreen), but the
    // Record tab's own two pickers would otherwise show the markup default until
    // then — wrong for anyone whose persisted language is not Russian.
    paintLangSegs([tsLangSeg, ...langSegs], state.batchSettings.language);

    // ─── Platform gating ─────────────────────────────────────────────────
    (async () => {
        const ok = await api.platformOK();
        if (ok) {
            unsupportedBanner.classList.add('hidden');
            mainArea.classList.remove('hidden');
        } else {
            unsupportedBanner.classList.remove('hidden');
            mainArea.classList.add('hidden');
        }
        // Always populate history — even pre-existing files from a prior
        // macOS install may still be valuable.
        refreshHistory();
        api.watch();
    })();

    // The hint below this used to always say "First launch: macOS will ask…"
    // regardless of whether that had already happened. Real Microphone status
    // replaces the guesswork for the two states worth reporting; Screen
    // Recording is left as-is (see live.css) — that OS API is known to cache
    // and lie right after a fresh grant, unlike this one. 'not-determined' —
    // macOS hasn't even asked yet — is left blank rather than shown as denied;
    // the static copy below already covers that case. Re-run every time the
    // idle screen shows (see showSection): the very first Start click is what
    // triggers the real prompt, so the answer is only known *after* it.
    async function refreshMicStatus() {
        const status = await api.micStatus?.();
        if (!micStatusEl || !status) return;
        if (status === 'granted') {
            micStatusEl.textContent = 'Microphone: granted. ';
            micStatusEl.classList.remove('is-denied');
        } else if (status === 'denied' || status === 'restricted') {
            micStatusEl.textContent = 'Microphone: not granted. ';
            micStatusEl.classList.add('is-denied');
        } else {
            micStatusEl.textContent = '';
            micStatusEl.classList.remove('is-denied');
        }
    }
    refreshMicStatus();

    api.onListChanged(() => refreshHistory());

    // The idle-screen "transcription in progress" banner reads `queueJobs` —
    // refresh it on every broadcast, not just when this
    // tab itself submitted the job (an auto-chained re-transcription from
    // Live is just as much "transcribing" as one this tab started). Hydrated
    // once up front too, or a reload leaves them stale until the next
    // unrelated broadcast happens to arrive.
    function onQueueJobsChanged(jobs) {
        queueJobs = jobs;
        updateTransActiveBanner();
    }
    queueApi?.onChanged(onQueueJobsChanged);
    queueApi?.list().then(onQueueJobsChanged);

    // ─── Show/hide sections ──────────────────────────────────────────────
    function showSection(name) {
        state.phase = name;
        setupSection.classList.toggle('hidden',      name !== 'idle');
        recordingSection.classList.toggle('hidden',  name !== 'recording');
        tsSection.classList.toggle('hidden',         name !== 'transcribeSettings');
        transcribeSection.classList.toggle('hidden', name !== 'transcribing');
        transcribeFlowWrap?.classList.toggle('hidden', name !== 'transcribeSettings' && name !== 'transcribing');
        updateTransActiveBanner();
        if (name === 'idle') refreshMicStatus();
    }

    // #transcribe-flow is a top-level overlay now, not gated by the tab
    // switcher — so live.js calls this on every tab-button click (Live,
    // Record, or the recording-indicator pill) to make sure it can't stay
    // pinned on top of a tab the user just switched away to. A pending batch
    // config (not yet submitted) is abandoned like Cancel; an already-running
    // transcription is left alone — same as the "New recording" button here,
    // it keeps going in the queue, just off screen.
    function closeTranscribeFlow() {
        if (state.phase === 'transcribeSettings') cancelTranscribeSettings();
        else if (state.phase === 'transcribing') showSection('idle');
    }

    // Escape closes #transcribe-flow, matching every other dismissible
    // surface in the app (modals, popovers, context menus).
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!transcribeFlowWrap || transcribeFlowWrap.classList.contains('hidden')) return;
        e.preventDefault();
        closeTranscribeFlow();
    });

    // Toolbar pill follows `state.recordingActive`, NOT the current section.
    // Recording can continue while the user is in transcribeSettings/transcribing
    // (parallel transcription) — the pill must stay visible and labelled
    // "Recording" the whole time.
    function updateRecordingIndicator() {
        const indicator = document.getElementById('recording-indicator');
        if (!indicator) return;
        indicator.classList.toggle('hidden', !state.recordingActive);
        const label = indicator.querySelector('span:not(.rec-indicator-dot)');
        if (label) label.textContent = 'Recording';
        const dot = indicator.querySelector('.rec-indicator-dot');
        if (dot) dot.style.removeProperty('animation');
        indicator.title = 'Recording in progress — click to return';
    }

    function updateTransActiveBanner() {
        const active = anyTranscribeActive() || state.batchRunning;
        transActiveBanner?.classList.toggle('hidden', !active || state.phase !== 'idle');
    }

    openScreenSettingsBtn?.addEventListener('click', () => api.openScreenSettings());

    // Troubleshoot block: copy the `tccutil reset …` command to the clipboard so
    // the user can paste straight into Terminal. Read from the DOM rather than
    // duplicated as a literal here, so the displayed and copied command cannot
    // drift apart. Mirrors live.js's handler for the Live tab's own copy.
    const copyTccBtn = $('record-copy-tcc-cmd');
    const COPY_TCC_LABEL = 'Copy command';
    copyTccBtn?.addEventListener('click', async () => {
        const cmd = $('record-tcc-reset-cmd')?.textContent || '';
        if (!cmd) return;
        try {
            await navigator.clipboard.writeText(cmd);
            // Restore from the constant, not from whatever the label reads now:
            // a second click inside the window would otherwise capture
            // "Copied ✓" as the original and leave it there for good.
            copyTccBtn.textContent = 'Copied ✓';
            clearTimeout(copyTccBtn._restore);
            copyTccBtn._restore = setTimeout(() => { copyTccBtn.textContent = COPY_TCC_LABEL; }, 1500);
        } catch (_) {
            // Clipboard blocked — the command is still visible in the <pre>
            // for manual copy, so leave the label alone.
        }
    });

    // ─── Import an existing audio file ───────────────────────────────────
    // Skips the selection flow: the imported file is not in the recordings
    // folder, so no card exists for it; we treat it as a one-element batch and
    // go straight to the transcription-settings screen.
    importBtn?.addEventListener('click', async () => {
        setupError.classList.add('hidden');
        setupError.textContent = '';

        const res = await api.pickAudioFile();
        if (res?.canceled) return;
        if (!res?.ok) {
            setupError.textContent = res?.error || 'Could not open file.';
            setupError.classList.remove('hidden');
            return;
        }

        state.outputPath = res.filePath;
        enterTranscribeSettings([res.filePath], { size: res.size || 0 });
    });

    // ─── Start recording ─────────────────────────────────────────────────
    // Calendar pre-fill: title flows into the WAV filename (→ "Meeting:");
    // participants are stashed for the transcribe step's "Participants:" line.
    // Shared by the picker (this tab's 📅 button) and the smart router
    // (calendar-smart.js), which routes here and pre-fills after switching tab.
    // An absent half is left alone. Only an explicit `clear` empties the field:
    // a nameless calendar event reaches the smart router as `title: ''` and must
    // not wipe a title typed by hand.
    function applyCalendarPick({ title, participants, clear }) {
        if (clear) titleInput.value = '';
        else if (title) titleInput.value = title;
        if (Array.isArray(participants)) state.calendarParticipants = participants;
    }
    window.calendarPicker?.attach({ button: $('record-cal-btn'), onPick: applyCalendarPick });
    // Re-read on every visit to this tab (live.js owns the switcher, so this is
    // a listener of our own): the field used to keep whatever the calendar said
    // the first time it was filled, so a meeting that ended hours ago was still
    // pre-selected — and its title names the WAV file.
    const calPrefill = window.calendarPicker?.autoPrefill({
        input: titleInput,
        onPick: applyCalendarPick,
        // Also re-checked after the calendar read: a refresh started on the setup
        // screen must not land once recording or transcribing is on screen.
        active: () => state.phase === 'idle',
    });
    document.querySelector('#tab-switch .tab-btn[data-tab="record"]')
        ?.addEventListener('click', () => { if (state.phase === 'idle') calPrefill?.refresh(); });
    window.recordTab = { applyCalendarPick, enterTranscribeSettings, closeTranscribeFlow };

    startBtn.addEventListener('click', async () => {
        setupError.classList.add('hidden');
        setupError.textContent = '';

        const sources = [];
        if (srcMicCheck.checked)    sources.push('mic');
        if (srcSystemCheck.checked) sources.push('system');
        if (!sources.length) {
            setupError.textContent = 'Choose at least one audio source.';
            setupError.classList.remove('hidden');
            return;
        }

        // Switch to recording UI before the IPC roundtrip so the user sees
        // immediate feedback — if start() fails we fall back to setup.
        showSection('recording');
        state.activeSources = sources;
        configureLanes(sources);
        setStatus('loading', 'Preparing…');
        timerEl.textContent = '00:00';
        outputPathEl.textContent = '';
        resetNotesList();

        const res = await api.start({
            sources,
            title: titleInput.value.trim(),
        });

        if (!res?.ok) {
            showSection('idle');
            setupError.textContent = res?.error || 'Failed to start recording.';
            setupError.classList.remove('hidden');
            return;
        }
        state.recordingActive = true;
        updateRecordingIndicator();
        state.outputPath = res.outputPath;
        outputPathEl.textContent = res.outputPath;
        buildWaveform();
        fillRecordFileCard();
    });

    // ─── Inline notes (freeform, timestamped) ───────────────────────────────
    // Sent through the same window.notesApi channel as the Live tab's floating
    // notes window, and rendered by the same shared helper
    // (renderer/notes-list.js) so the two lists can't drift apart.
    //
    // Main is the source of truth for both the text and the elapsed time: this
    // section is on screen from the moment Start is clicked, well before the
    // helper's `recording` event sets the clock, so anything computed here from
    // a local anchor would be wrong exactly when the user types first.
    const NOTES_PLACEHOLDER = 'Note… (Enter to save)';

    // Clearing is just "render nothing" — the shared renderer owns how a row is
    // built and how the placeholder is toggled, so a second copy of that rule
    // here would silently miss any change to it.
    const resetNotesList = () => window.notesList.render(notesListEl, notesEmptyEl, []);
    const refreshNotes = () => window.notesList.refresh(notesListEl, notesEmptyEl);

    // Repaint on main's broadcast: a note added from the Live tab's floating
    // window lands in this session too when both are running, and a new
    // session clears the list. The disposer is unused on purpose — this list
    // is part of the main window and lives as long as the renderer does.
    window.notesList.watch(notesListEl, notesEmptyEl);

    window.notesList.attachInput({
        input: notesInputEl,
        container: notesListEl,
        emptyEl: notesEmptyEl,
        placeholder: NOTES_PLACEHOLDER,
        rejectedMessage: 'Not recording — note not saved',
    });

    let waveRaf = null;
    function buildWaveform() {
        if (waveRaf) { cancelAnimationFrame(waveRaf); waveRaf = null; }
        const host = $('record-waveform');
        if (!host) return;
        host.innerHTML = '';
        const bars = [];
        for (let i = 0; i < 64; i++) {
            const bar = document.createElement('div');
            bar.className = 'record-waveform-bar';
            host.appendChild(bar);
            bars.push(bar);
        }
        let phase = 0;
        let envelope = 0.75;
        const noise = new Float32Array(bars.length);
        function tick() {
            phase += 0.05;
            // Slow random-walk amplitude envelope — mimics natural speech bursts.
            envelope = Math.max(0.55, Math.min(1.0, envelope + (Math.random() - 0.5) * 0.04));
            // Occasional spike on a random bar — like loud consonants.
            if (Math.random() < 0.1) {
                noise[(Math.random() * bars.length) | 0] = 0.8 + Math.random() * 0.7;
            }
            for (let i = 0; i < bars.length; i++) {
                noise[i] = noise[i] * 0.82 + (Math.random() - 0.5) * 0.55;
                const wave = Math.sin(i * 0.4 + phase) * 0.3
                           + Math.cos(i * 0.18 + phase * 1.4) * 0.2;
                const h = 4 + Math.abs(wave + noise[i]) * envelope * 56;
                bars[i].style.height = Math.max(3, Math.min(54, h)) + 'px';
            }
            waveRaf = requestAnimationFrame(tick);
        }
        tick();
    }

    function fillRecordFileCard() {
        const path = state.outputPath || '';
        const fileName = path.split('/').pop() || '—';
        const dir = path.split('/').slice(0, -1).join('/') || '—';
        const fileEl = $('record-file-name');
        const pathEl = $('record-output-path');
        const sizeEl = $('record-file-size');
        const spkEl = $('record-file-speakers');
        if (fileEl) fileEl.textContent = fileName;
        if (pathEl) pathEl.textContent = dir;
        if (sizeEl) sizeEl.textContent = '—';
        if (spkEl) {
            spkEl.innerHTML = '';
            const srcs = state.activeSources || [];
            if (srcs.includes('mic')) {
                const c = document.createElement('span');
                c.className = 'record-spk-chip';
                c.textContent = 'You · mic';
                spkEl.appendChild(c);
            }
            if (srcs.includes('system')) {
                const c = document.createElement('span');
                c.className = 'record-spk-chip';
                c.textContent = 'S?';
                spkEl.appendChild(c);
            }
            if (!spkEl.children.length) spkEl.textContent = '—';
        }
    }

    // ─── Stop recording ──────────────────────────────────────────────────
    // Shared by the Stop button and the auto-stop trigger (main fires an
    // `autoStop` event when the meeting ended and the countdown elapsed).
    async function stopAndSave() {
        // Guard on the session, not the visible section: recording keeps going
        // while the user is in transcribeSettings/transcribing (see the
        // recording-indicator note above), and a stop must still work there.
        if (!state.recordingActive) return;
        stopBtn.disabled = true;
        stopBtn.querySelector('span:last-child').textContent = 'Saving…';
        setStatus('loading', 'Finalizing WAV…');
        await api.stop();
        stopTimer();
        if (waveRaf) { cancelAnimationFrame(waveRaf); waveRaf = null; }
        // Reset stop button for next session.
        stopBtn.disabled = false;
        stopBtn.querySelector('span:last-child').textContent = 'Stop & save';
        // We'll get a `recordSaved` event with the canonical path & duration.
    }

    stopBtn.addEventListener('click', stopAndSave);

    // ─── Transcribe-settings screen actions ──────────────────────────────
    tsBtnTranscribe?.addEventListener('click', async () => {
        const targets = state.pendingBatchTargets?.length
            ? state.pendingBatchTargets.slice()
            : (state.outputPath ? [state.outputPath] : []);
        if (!targets.length) return;
        if (targets.length === 1) {
            const fp = targets[0];
            state.pendingBatchTargets = null;
            // The banner follows the queue now (see queueApi.onChanged
            // below) — no local bookkeeping needed.
            await startTranscription(fp);
        } else {
            await runBatchTranscribe(targets);
        }
    });

    // Shared by the footer Cancel button and the header close (✕) — both back
    // out of the batch the same way.
    function cancelTranscribeSettings() {
        state.outputPath = null;
        state.pendingBatchTargets = null;
        if (tsError) {
            tsError.classList.add('hidden');
            tsError.textContent = '';
        }
        showSection('idle');
        refreshHistory();
    }

    tsBtnCancel?.addEventListener('click', cancelTranscribeSettings);
    tsBtnClose?.addEventListener('click', cancelTranscribeSettings);

    tsEditSelection?.addEventListener('click', () => {
        // Back to library — user adjusts checkboxes and hits Transcribe again.
        state.pendingBatchTargets = null;
        showSection('idle');
    });

    tsBtnSavePreset?.addEventListener('click', () => openSavePresetPopover());

    tsPresetSelect?.addEventListener('change', () => {
        const v = tsPresetSelect.value;
        if (!v) { setActivePreset(null); presetDirty = false; renderPresetSelect(); return; }
        applyPreset(v);
    });

    tsPresetDelete?.addEventListener('click', () => {
        if (!activePreset) return;
        if (!window.confirm(`Delete preset "${activePreset}"?`)) return;
        presets = presets.filter(p => p.name !== activePreset);
        setActivePreset(null);
        presetDirty = false;
        persistPresets();
        renderPresetSelect();
    });

    // Inline name popover (Electron has no window.prompt). Reuses the
    // rename-popup styling from the library list. Upsert by name: a new name
    // creates a preset, an existing name overwrites it after confirmation.
    function openSavePresetPopover() {
        if (document.querySelector('.rename-popup[data-preset-save]')) return;
        const overlay = document.createElement('div');
        overlay.className = 'rename-overlay';
        const popup = document.createElement('div');
        popup.className = 'rename-popup';
        popup.dataset.presetSave = '1';
        const input = document.createElement('input');
        input.className = 'rename-popup-input';
        input.type = 'text';
        input.placeholder = 'Preset name';
        input.value = activePreset || '';
        const actions = document.createElement('div');
        actions.className = 'rename-popup-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'rename-popup-btn';
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Cancel';
        const okBtn = document.createElement('button');
        okBtn.className = 'rename-popup-btn primary';
        okBtn.type = 'button';
        okBtn.textContent = 'Save';
        actions.appendChild(cancelBtn);
        actions.appendChild(okBtn);
        popup.appendChild(input);
        popup.appendChild(actions);
        function cleanup() { overlay.remove(); popup.remove(); }
        function save() {
            const name = input.value.trim();
            if (!name) { input.focus(); return; }
            const idx = presets.findIndex(p => p.name === name);
            if (idx >= 0) {
                if (!window.confirm(`Overwrite preset "${name}"?`)) return;
                presets[idx] = { name, settings: { ...state.batchSettings } };
            } else {
                presets.push({ name, settings: { ...state.batchSettings } });
            }
            setActivePreset(name);
            presetDirty = false;
            persistPresets();
            cleanup();
            renderPresetSelect();
            flashSavePresetBtn();
        }
        cancelBtn.addEventListener('click', cleanup);
        okBtn.addEventListener('click', save);
        overlay.addEventListener('click', cleanup);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); save(); }
            else if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
        });
        document.body.appendChild(overlay);
        document.body.appendChild(popup);
        const r = tsBtnSavePreset.getBoundingClientRect();
        popup.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 296))}px`;
        popup.style.top = `${Math.max(8, r.top - 92)}px`;
        input.focus();
        input.select();
    }
    function flashSavePresetBtn() {
        if (!tsBtnSavePreset) return;
        const orig = tsBtnSavePreset.textContent;
        tsBtnSavePreset.textContent = 'Saved ✓';
        tsBtnSavePreset.disabled = true;
        setTimeout(() => { tsBtnSavePreset.textContent = orig; tsBtnSavePreset.disabled = false; }, 1400);
    }

    cancelTransBtn.addEventListener('click', async () => {
        if (!currentTranscribeJobId) return;
        cancelTransBtn.disabled = true;
        cancelTransBtn.querySelector('span:last-child').textContent = 'Cancelling…';
        await queueApi.cancel(currentTranscribeJobId);
        // We'll get a `transcriberExited` event; the settings screen is
        // restored from there.
    });

    // Now that this screen opens over whichever tab launched it (usually
    // Transcripts), "New recording" has to take the user to the Record tab
    // itself, not just clear this screen — switching tabs is what closes it
    // (see closeTranscribeFlow, called from live.js's switchTab).
    newRecordingFromTransBtn?.addEventListener('click', () => {
        document.querySelector('.tab-btn[data-tab="record"]')?.click();
    });

    // The on-page NOW/NEXT queue widget is gone — the header panel (app.js)
    // is the one place that shows everything queued/running across every tab.
    viewQueueBtn?.addEventListener('click', () => window.queuePanel?.open());

    // ─── Helper events ───────────────────────────────────────────────────
    api.onEvent((event) => {
        if (!event || typeof event.type !== 'string') return;
        // Transcribe events are tagged with the producing job's id (see
        // makeTranscribeSink in main.js) — several transcribe jobs can exist
        // at once (one running, others queued), so a background job's
        // segment/status events must not render into whatever this tab
        // happens to have open. Recorder-lifecycle events (recording,
        // audioLevel, recordSaved, …) carry no jobId and always pass through.
        if (event.jobId && event.jobId !== currentTranscribeJobId) return;

        switch (event.type) {
            case 'autoStop':
                // Meeting ended + countdown elapsed → same as pressing Stop.
                stopAndSave();
                break;
            case 'recording':
                state.recordingActive = true;
                updateRecordingIndicator();
                if (state.phase !== 'recording') showSection('recording');
                setStatus('recording', 'Recording');
                state.startedAt = Date.now();
                startTimer();
                break;

            case 'audioLevel': {
                const src = event.source === 'mic' ? 'mic' : 'system';
                const lvl = Math.max(0, Math.min(1, Number(event.level) || 0));
                setLevelMeter(src, lvl);
                break;
            }

            case 'recordSaved': {
                state.recordingActive = false;
                updateRecordingIndicator();
                stopTimer();
                state.outputPath = event.path || state.outputPath;
                // Leave the recording screen FIRST. The submit below is the only
                // thing here that can throw synchronously (a missing bridge
                // method would), and a throw must not strand the user on a
                // recording screen for a session that already ended.
                // Only from the recording section: a stop that lands while a
                // parallel transcription is on screen must not yank the user
                // off it.
                if (state.phase === 'recording') showSection('idle');
                refreshHistory();
                // Stop & save goes straight into transcription: nothing is left
                // to decide, so the wav is queued here rather than parked under
                // "To transcribe" for a manual trip through the settings screen.
                // Fixed large-v3 + diarization + a chained Enhance all live in
                // main's queueAutoTranscribe; the language is the one thing this
                // tab picks. Progress belongs to the header queue panel and the
                // idle screen's banner, so there is no screen to switch to.
                const auto = autoTranscribeArgs(event, state);
                // Whatever a previous stop failed with is stale now.
                setupError.textContent = '';
                setupError.classList.add('hidden');
                // The finished meeting's title names the next WAV, so refresh it
                // against the calendar whatever came of this recording — a stop
                // too short to queue (autoTranscribeArgs → null) ends a session
                // just the same.
                calPrefill?.refresh();
                if (auto) {
                    // Calendar attendees belong to the session that just ended.
                    // Consumed here, or recording #2 inherits recording #1's
                    // guest list into an unattended transcript header.
                    state.calendarParticipants = [];
                    const failed = (message) => {
                        setupError.textContent = message || 'Could not start transcription.';
                        setupError.classList.remove('hidden');
                    };
                    Promise.resolve()
                        .then(() => api.autoQueueTranscribe(auto.filePath, auto.language, auto.participants))
                        .then((res) => { if (!res?.ok) failed(res?.error); })
                        // A rejection here means the IPC itself failed — the
                        // handler threw, or the bridge is gone. Silence would
                        // read as "transcription started" while nothing runs.
                        .catch((err) => failed(err?.message));
                }
                break;
            }

            case 'recorderExited':
                state.recordingActive = false;
                updateRecordingIndicator();
                if (state.phase === 'recording') {
                    // Helper died unexpectedly. Surface as setup error.
                    showSection('idle');
                    setupError.textContent = `Recorder exited unexpectedly (code ${event.code}).`;
                    setupError.classList.remove('hidden');
                    refreshHistory();
                }
                break;

            // ─── Transcription events ─────────────────────────────────────
            case 'transcribeStarted':
                setTransStatus('loading', 'Loading model…');
                transStream.innerHTML = '';
                cancelTransBtn.disabled = false;
                cancelTransBtn.querySelector('span:last-child').textContent = 'Cancel';
                break;

            case 'modelDownload': {
                const pct = Math.max(0, Math.min(1, Number(event.progress) || 0));
                transDownload.classList.remove('hidden');
                transProgressBar.style.width = (pct * 100).toFixed(1) + '%';
                if (pct >= 1) {
                    transDownload.classList.add('hidden');
                    setTransStatus('loading', 'Loading model into memory…');
                } else {
                    setTransStatus('loading', `Downloading model… ${Math.round(pct * 100)}%`);
                }
                break;
            }

            case 'loaded': {
                const dur = Number(event.durationSec) || 0;
                setTransStatus('loading', `Audio loaded · ${formatHms(dur)}`);
                break;
            }

            case 'transcribing':
                setTransStatus('loading', 'Transcribing…');
                break;

            case 'segment':
                if (state.phase === 'transcribing') appendTranscriptionSegment(event);
                break;

            case 'diarizing':
                setTransStatus('loading', 'Labeling speakers…');
                break;

            case 'diarizationComplete':
                applyDiarization(Array.isArray(event.segments) ? event.segments : []);
                setTransStatus('loading', 'Saving transcript…');
                break;

            case 'diarizationFailed':
                // Non-fatal — text is preserved, speakers stay as S?.
                setTransStatus('loading', 'Speaker labels unavailable · saving transcript…');
                break;

            case 'transcriberExited':
                // Final flow handled in startTranscription's await.
                break;

            case 'error':
                // Errors are surfaced contextually based on phase.
                if (state.phase === 'transcribing') {
                    setTransStatus('idle', event.message || 'Transcription failed');
                } else if (state.phase === 'recording') {
                    setStatus('idle', event.message || 'Recorder error');
                }
                break;
        }
    });

    // Resolves once `jobId` leaves the queue (done/failed/canceled), with the
    // same { ok, transcriptPath } / { ok: false, error } shape the direct
    // record:transcribe call used to resolve with — record:transcribe now
    // only submits, so this is what actually waits for the result.
    function waitForQueueJob(jobId) {
        return new Promise((resolve) => {
            let dispose;
            const check = (jobs) => {
                const job = jobs.find((j) => j.id === jobId);
                if (!job) {
                    // The only way a submitted job vanishes outright (rather
                    // than settling to a terminal status) is a cancel while
                    // it was still `queued` — job-queue.js drops those
                    // instead of marking them. Without this the promise would
                    // never resolve and this screen would hang forever.
                    dispose?.();
                    resolve({ ok: false, canceled: true });
                    return;
                }
                if (job.status === 'queued') {
                    setTransStatus('loading', 'Waiting for another transcription to finish…');
                    return;
                }
                if (job.status === 'running') return; // per-event progress covers this (api.onEvent below)
                dispose?.();
                resolve(job.result || (job.error ? { ok: false, error: job.error } : { ok: false }));
            };
            dispose = queueApi.onChanged(check);
            queueApi.list().then(check);
        });
    }

    // Both single-file and batch flows go through the same settings screen —
    // so the saved batchSettings are the source of truth for either.
    function buildTranscribeOpts(filePath) {
        const bs = state.batchSettings;
        // Expected-speakers pill → integer count; 'auto' and '6+' mean
        // "let the model decide" (no fixed count), so only a pure-digit
        // value sets a concrete count.
        const numberOfSpeakers = /^\d+$/.test(bs.expectedSpeakers)
            ? parseInt(bs.expectedSpeakers, 10)
            : null;
        return {
            filePath,
            model: bs.model,
            language: bs.language,
            participants: state.calendarParticipants,
            diarize: bs.diarize,
            numberOfSpeakers,
            initialPrompt: bs.initialPrompt,
            temperature: bs.temperature,
            vadFilter: bs.vadFilter,
            mergeAdjacent: bs.mergeAdjacent,
        };
    }

    // Single-file flow only — batch submits directly via runBatchTranscribe
    // and never shows this screen (see its own comment for why).
    async function startTranscription(filePath) {
        showSection('transcribing');
        setTransStatus('loading', 'Starting…');
        transStream.innerHTML = '';
        transDownload.classList.add('hidden');
        transProgressBar.style.width = '0%';

        const submitRes = await api.transcribe(buildTranscribeOpts(filePath));

        const fail = (message) => {
            setTransStatus('idle', message || 'Transcription failed');
            // Surface a recovery affordance: a back button reusing cancel slot.
            cancelTransBtn.querySelector('span:last-child').textContent = 'Back';
            cancelTransBtn.disabled = false;
            cancelTransBtn.onclick = () => {
                cancelTransBtn.onclick = null;
                cancelTransBtn.querySelector('span:last-child').textContent = 'Cancel';
                showSection('transcribeSettings');
            };
        };

        if (!submitRes?.ok) { fail(submitRes?.error); return; }

        currentTranscribeJobId = submitRes.jobId;
        const res = await waitForQueueJob(submitRes.jobId);
        currentTranscribeJobId = null;

        if (!res?.ok) { fail(res?.error); return; }

        showSection('idle');
        refreshHistory();

        // Announce the freshly created transcript so the Transcripts tab
        // (app.js) can jump to it and open it.
        if (res.transcriptPath) {
            document.dispatchEvent(new CustomEvent('transcript:created', {
                detail: { filePath: res.transcriptPath },
            }));
        }
        return res.transcriptPath;
    }

    // ─── Recordings, for the transcribe-settings screen only ─────────────
    function formatRelativeDay(epochMs) {
        const d = new Date(epochMs);
        const now = new Date();
        const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const startOfWeek = midnight - 6 * 86400 * 1000;
        if (epochMs >= midnight) return 'today';
        if (epochMs >= startOfWeek) return 'earlier';
        return 'older';
    }

    let _refreshToken = 0;
    // The recordings list is the Meetings sidebar's job now (app.js). This
    // refresh exists only so the transcribe-settings screen can label its batch
    // rows with a title, size and timestamp.
    async function refreshHistory() {
        // Nothing on this tab reads `currentItems` unless the settings screen is
        // up, and app.js runs its own record:list on every folder event — a
        // third scan per event for a screen nobody is looking at is waste.
        if (state.phase !== 'transcribeSettings') return;
        const token = ++_refreshToken;
        const items = await api.list();
        // Stale response — a newer refreshHistory() is in flight; drop this one
        // so we don't overwrite the latest view with older data.
        if (token !== _refreshToken) return;
        currentItems = items;
        renderTsScreen();
    }

    // Switch into the transcribe-settings screen pre-filled with the queued
    // recordings — a Meetings-sidebar selection, one row's Transcribe… , or a
    // single imported file. The same screen handles N≥1; single is the
    // degenerate case of a 1-element batch.
    function enterTranscribeSettings(filePaths, opts = {}) {
        // The settings/transcribing panel lives on the Transcripts tab now — an
        // overlay of its own (see #transcribe-flow in record.css), not part of
        // Record's tab panel. Make sure Transcripts is the tab shown underneath,
        // regardless of which tab this was triggered from (e.g. Record's own
        // "Import audio file…" button).
        document.querySelector('.tab-btn[data-tab="editor"]')?.click();
        state.pendingBatchTargets = filePaths.slice();
        state.outputPath = filePaths[0] || null;
        renderTsScreen({ importedSize: opts.size });
        showSection('transcribeSettings');
        // Same "move focus into the thing that just opened" convention as this
        // app's modals (e.g. the New Transcript dialog). The close button is a
        // safe, always-present landing spot — the screen has no single obvious
        // first field the way a modal with one text input does.
        tsBtnClose?.focus();
        // Only now is the phase right for refreshHistory to run: the rows above
        // are labelled from whatever `currentItems` still held, and this fills
        // in size and timestamp for anything it did not know.
        refreshHistory();
    }

    // One submit per file — every one is accepted immediately and drained in
    // order by the transcribe lane; the header panel (app.js) is what shows
    // progress and failures now, not this screen. Replaces the old
    // sequential await-per-file loop and its on-page NOW/NEXT queue widget.
    async function runBatchTranscribe(filePaths) {
        if (state.batchRunning) return;
        state.batchRunning = true;
        try {
            // record:transcribe only ever submits (it can't refuse — see
            // job-queue.js) so there is no submit-failure path to handle here;
            // a bad file/path still fails, just later, as a failed job the
            // header panel shows.
            for (const fp of filePaths) {
                await api.transcribe(buildTranscribeOpts(fp));
            }
        } finally {
            state.batchRunning = false;
            state.pendingBatchTargets = null;
            updateTransActiveBanner();
            showSection('idle');
            refreshHistory();
        }
    }
    // ─── Transcribe-settings screen wiring ──────────────────────────────
    function renderTsScreen({ importedSize } = {}) {
        const targets = state.pendingBatchTargets || [];
        const n = targets.length;

        if (tsBatchCount) tsBatchCount.textContent = String(n);
        if (tsBtnTranscribeLabel) {
            tsBtnTranscribeLabel.textContent =
                n === 0 ? 'Transcribe' :
                n === 1 ? 'Transcribe 1 recording' :
                          `Transcribe ${n} recordings`;
        }
        if (tsBtnTranscribe) tsBtnTranscribe.disabled = n === 0;

        // Map targets back to library items so we can render titles & meta.
        const byPath = new Map(currentItems.map(it => [it.filePath, it]));
        let totalSec = 0;
        let totalKnownSec = true;
        if (tsBatchList) {
            tsBatchList.innerHTML = '';
            if (!n) {
                const empty = document.createElement('div');
                empty.className = 'ts-batch-empty';
                empty.textContent = 'No recordings selected. Pick them in the Meetings list.';
                tsBatchList.appendChild(empty);
            }
            for (const fp of targets) {
                const item = byPath.get(fp);
                const fileName = (fp.split('/').pop() || fp).replace(/\.wav$/i, '');
                const durationSec = item?.durationSec || 0;
                if (!item || !item.durationSec) totalKnownSec = false;
                totalSec += durationSec;
                const sizeBytes = item?.size || (targets.length === 1 ? importedSize || 0 : 0);
                const whenMs = item?.createdAt || item?.mtime;
                const when = whenMs ? formatRelativeWhen(whenMs) : '';

                const row = document.createElement('div');
                row.className = 'ts-batch-row';
                const dot = document.createElement('span');
                dot.className = 'ts-batch-dot';
                const title = document.createElement('span');
                title.className = 'ts-batch-row-title';
                title.textContent = humanizeRecordingTitle(fileName);
                const dur = document.createElement('span');
                dur.className = 'ts-batch-row-meta';
                dur.textContent = durationSec ? formatHms(durationSec) : (sizeBytes ? formatBytes(sizeBytes) : '—');
                const meta = document.createElement('span');
                meta.className = 'ts-batch-row-meta-dim';
                meta.textContent = when || '';
                row.append(dot, title, dur, meta);
                tsBatchList.appendChild(row);
            }
        }
        if (tsBatchSub) {
            if (!n) {
                tsBatchSub.textContent = '— · pick recordings to populate the batch';
            } else if (totalKnownSec && totalSec > 0) {
                tsBatchSub.textContent = `${formatDurationLong(totalSec)} of audio · processed sequentially`;
            } else {
                tsBatchSub.textContent = `${n} ${n === 1 ? 'recording' : 'recordings'} · processed sequentially`;
            }
        }

        applyBatchSettingsToScreen();
        recomputeTsEta(totalSec);
        refreshModelBadges();
    }

    async function refreshModelBadges() {
        if (!tsModelGrid || !api.getInstalledModels) return;
        let installed;
        try { installed = new Set(await api.getInstalledModels()); } catch { return; }
        for (const card of tsModelGrid.querySelectorAll('.ts-model-card')) {
            const badge = card.querySelector('.ts-badge-installed, .ts-badge-download');
            if (!badge) continue;
            const isInstalled = installed.has(card.dataset.model);
            // Card-level flag drives the trash icon's visibility via CSS.
            card.classList.toggle('is-installed', isInstalled);
            // Don't touch the badge while a pre-fetch is mid-flight — the
            // download handler owns its label (e.g. "↓ 42%") until done.
            if (card.classList.contains('is-downloading')) continue;
            if (isInstalled) {
                badge.className = 'ts-badge-installed';
                badge.removeAttribute('data-action');
                badge.removeAttribute('title');
                badge.textContent = '✓ installed';
            } else {
                badge.className = 'ts-badge-download';
                badge.setAttribute('data-action', 'download-model');
                badge.setAttribute('title', 'Download model');
                badge.textContent = '↓ download';
            }
        }
    }

    async function handleDeleteRecordModel(card) {
        const m = card.dataset.model;
        if (!m) return;
        if (!confirm(`Delete model "${m}" from disk?\n\nIt will be re-downloaded the next time it's used.`)) return;
        const res = await api.deleteModel?.(m);
        if (res && !res.ok) {
            alert('Delete failed: ' + (res.error || 'unknown'));
        }
        await refreshModelBadges();
    }

    async function handleDownloadRecordModel(card, badge) {
        const m = card.dataset.model;
        if (!m || card.classList.contains('is-downloading')) return;
        card.classList.add('is-downloading');
        const originalText = badge.textContent;
        badge.textContent = 'starting…';
        // Reuse the Live tab's pre-fetch IPC — it's the same shared
        // WhisperKit cache, so the implementation is identical.
        const res = await window.live?.downloadModel?.(m);
        card.classList.remove('is-downloading');
        if (!res || !res.ok) {
            badge.textContent = originalText;
            alert('Download failed: ' + (res?.error || 'unknown'));
        }
        await refreshModelBadges();
    }

    // Live-tab event channel carries modelDownloadProgress for the shared
    // helper. Subscribe here so Record cards can mirror the % readout.
    if (typeof window.live?.onEvent === 'function') {
        window.live.onEvent((evt) => {
            if (!evt || evt.type !== 'modelDownloadProgress') return;
            if (!tsModelGrid) return;
            const card = tsModelGrid.querySelector(`.ts-model-card[data-model="${evt.model}"]`);
            if (!card) return;
            const badge = card.querySelector('.ts-badge-installed, .ts-badge-download');
            if (!badge) return;
            const pct = Math.max(0, Math.min(1, Number(evt.progress) || 0));
            badge.textContent = `↓ ${Math.round(pct * 100)}%`;
        });
    }

    function applyBatchSettingsToScreen() {
        const bs = state.batchSettings;
        // Model grid
        if (tsModelGrid) {
            for (const card of tsModelGrid.querySelectorAll('.ts-model-card')) {
                const active = card.dataset.model === bs.model;
                card.classList.toggle('is-active', active);
                const radio = card.querySelector('.ts-radio');
                if (radio) {
                    radio.innerHTML = active ? '<span class="ts-radio-dot"></span>' : '';
                }
            }
        }
        // Language segmented — both pickers, one value.
        paintLangSegs([tsLangSeg, ...langSegs], bs.language);
        // Diarize switch + inner state
        if (tsDiarizeToggle) tsDiarizeToggle.checked = !!bs.diarize;
        if (tsDiaInner) tsDiaInner.classList.toggle('is-disabled', !bs.diarize);
        if (tsSpkPills) {
            for (const pill of tsSpkPills.querySelectorAll('.ts-spk-pill')) {
                pill.classList.toggle('is-active', pill.dataset.spk === String(bs.expectedSpeakers));
            }
        }
        if (tsMergeAdjacent) tsMergeAdjacent.checked = !!bs.mergeAdjacent;
        if (tsInitialPrompt && document.activeElement !== tsInitialPrompt) {
            tsInitialPrompt.value = bs.initialPrompt;
        }
        if (tsTemperature) {
            tsTemperature.value = String(bs.temperature);
            updateSliderFill(tsTemperature);
        }
        if (tsTemperatureVal) tsTemperatureVal.textContent = `· ${Number(bs.temperature).toFixed(1)}`;
        if (tsVadFilter) tsVadFilter.checked = !!bs.vadFilter;
    }

    function updateSliderFill(input) {
        const min = Number(input.min) || 0;
        const max = Number(input.max) || 1;
        const val = Number(input.value);
        const pct = max === min ? 0 : ((val - min) / (max - min)) * 100;
        input.style.backgroundSize = `${pct}% 100%`;
    }

    function recomputeTsEta(maybeTotalSec) {
        const bs = state.batchSettings;
        const targets = state.pendingBatchTargets || [];
        const byPath = new Map(currentItems.map(it => [it.filePath, it]));
        let totalSec = typeof maybeTotalSec === 'number' ? maybeTotalSec : 0;
        if (typeof maybeTotalSec !== 'number') {
            for (const fp of targets) totalSec += byPath.get(fp)?.durationSec || 0;
        }
        const info = MODEL_INFO[bs.model] || { label: bs.model, realtime: 6 };
        const diarizeMul = bs.diarize ? 1.3 : 1.0;
        const etaSec = totalSec > 0 ? Math.round((totalSec / info.realtime) * diarizeMul) : 0;
        if (tsEtaTotal) tsEtaTotal.textContent = etaSec ? formatDurationLong(etaSec) : '—';
        if (tsEtaSub) {
            const spk = bs.diarize ? `diarize ${bs.expectedSpeakers} spk` : 'no diarization';
            tsEtaSub.textContent = `${targets.length} ${targets.length === 1 ? 'recording' : 'recordings'} · ${info.label} · ${bs.language} · ${spk} · ~${info.realtime}× realtime`;
        }
    }

    // Wire interactive elements on the settings screen (one-time bindings).
    if (tsModelGrid) {
        tsModelGrid.addEventListener('click', (ev) => {
            const deleteEl = ev.target.closest('[data-action="delete-model"]');
            if (deleteEl) {
                ev.stopPropagation();
                ev.preventDefault();
                const card = deleteEl.closest('.ts-model-card');
                if (card) handleDeleteRecordModel(card);
                return;
            }
            const downloadEl = ev.target.closest('[data-action="download-model"]');
            if (downloadEl) {
                ev.stopPropagation();
                ev.preventDefault();
                const card = downloadEl.closest('.ts-model-card');
                if (card) handleDownloadRecordModel(card, downloadEl);
                return;
            }
            const card = ev.target.closest('.ts-model-card');
            if (!card) return;
            const m = card.dataset.model;
            if (!m) return;
            state.batchSettings.model = m;
            onBatchSettingsChanged();
            applyBatchSettingsToScreen();
            recomputeTsEta();
        });
    }
    // One handler for both pickers: they write the same setting, so a second
    // copy of this could only ever drift from the first.
    for (const box of [tsLangSeg, ...langSegs]) {
        box?.addEventListener('click', (ev) => {
            const lang = ev.target.closest('.ts-seg')?.dataset.lang;
            if (!lang) return;
            state.batchSettings.language = lang;
            onBatchSettingsChanged();
            applyBatchSettingsToScreen();
            recomputeTsEta();
        });
    }
    if (tsDiarizeToggle) {
        tsDiarizeToggle.addEventListener('change', () => {
            state.batchSettings.diarize = tsDiarizeToggle.checked;
            if (tsDiaInner) tsDiaInner.classList.toggle('is-disabled', !tsDiarizeToggle.checked);
            onBatchSettingsChanged();
            recomputeTsEta();
        });
    }
    if (tsSpkPills) {
        tsSpkPills.addEventListener('click', (ev) => {
            const pill = ev.target.closest('.ts-spk-pill');
            if (!pill) return;
            state.batchSettings.expectedSpeakers = pill.dataset.spk;
            onBatchSettingsChanged();
            applyBatchSettingsToScreen();
            recomputeTsEta();
        });
    }
    tsMergeAdjacent?.addEventListener('change', () => { state.batchSettings.mergeAdjacent = tsMergeAdjacent.checked; onBatchSettingsChanged(); });
    tsInitialPrompt?.addEventListener('input', () => { state.batchSettings.initialPrompt = tsInitialPrompt.value; onBatchSettingsChanged(); });
    tsTemperature?.addEventListener('input', () => {
        const v = Number(tsTemperature.value);
        state.batchSettings.temperature = v;
        if (tsTemperatureVal) tsTemperatureVal.textContent = `· ${v.toFixed(1)}`;
        updateSliderFill(tsTemperature);
        onBatchSettingsChanged();
    });
    tsVadFilter?.addEventListener('change', () => { state.batchSettings.vadFilter = tsVadFilter.checked; onBatchSettingsChanged(); });

    // Build the preset dropdown once from persisted presets / active selection.
    renderPresetSelect();

    function humanizeRecordingTitle(baseTitle) {
        const newFmt = /^(\d{2})-(\d{2}) (\d{2}-\d{2}-\d{2})(?: (.+?))?( \(\d+\))?$/;
        const m = baseTitle.match(newFmt);
        return m
            ? `${m[1]}:${m[2]} ${m[3]}` + (m[4] ? ` — ${m[4]}` : '') + (m[5] || '')
            : baseTitle;
    }
    function formatRelativeWhen(epochMs) {
        const time = new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const bucket = formatRelativeDay(epochMs);
        const word = bucket === 'today' ? 'today' : bucket === 'earlier' ? 'earlier' : 'older';
        return `${word} · ${time}`;
    }
    function formatDurationLong(sec) {
        const s = Math.max(0, Math.floor(Number(sec) || 0));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const r = s % 60;
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${String(r).padStart(2, '0')}s`;
        return `${r}s`;
    }

    // ─── Transcribing UI ──────────────────────────────────────────────────
    function setTransStatus(kind, text) {
        transDot.classList.remove('dot-loading', 'dot-recording');
        if (kind === 'recording') transDot.classList.add('dot-recording');
        if (kind === 'loading')   transDot.classList.add('dot-loading');
        transStatus.textContent = text;
    }

    function appendTranscriptionSegment(seg) {
        const src = seg.source === 'mic' ? 'mic' : 'system';
        const div = document.createElement('div');
        div.className = `live-segment src-${src}`;
        const rawSpeaker = seg.speaker && seg.speaker !== '?' && seg.speaker !== '…'
            ? seg.speaker
            : (src === 'mic' ? 'Me' : 'S?');
        const speaker = humanizeSpeakerLabel(rawSpeaker);
        const pending = src !== 'mic' && (rawSpeaker === 'S?' || rawSpeaker === '…');
        if (pending) div.classList.add('speaker-pending');
        div.innerHTML = `
            <div class="live-seg-meta">
                <span class="live-seg-speaker"></span>
                <span class="live-seg-time"></span>
            </div>
            <div class="live-seg-text"></div>
        `;
        div.querySelector('.live-seg-speaker').textContent = speaker;
        div.querySelector('.live-seg-time').textContent = formatHms(seg.start);
        div.querySelector('.live-seg-text').textContent = seg.text || '';
        transStream.appendChild(div);
        const nearBottom = transStream.scrollHeight - transStream.scrollTop - transStream.clientHeight < 80;
        if (nearBottom) transStream.scrollTop = transStream.scrollHeight;
    }

    function applyDiarization(ranges) {
        if (!ranges.length) return;
        const nodes = transStream.querySelectorAll('.live-segment.src-system');
        nodes.forEach((node, idx) => {
            const tNode = node.querySelector('.live-seg-time');
            const sec = parseHms(tNode?.textContent || '');
            if (sec == null) return;
            // Find the range overlapping this segment's start.
            const r = ranges.find(rr => rr.start <= sec + 0.001 && rr.end >= sec - 0.001);
            const label = r?.speaker || node.querySelector('.live-seg-speaker').textContent;
            if (!label) return;
            node.classList.remove('speaker-pending');
            node.querySelector('.live-seg-speaker').textContent = humanizeSpeakerLabel(label);
        });
    }

    // Renderer-side mirror of main.js humanizeSpeakerLabel — keep both in sync.
    const PHONETIC_LETTERS = [
        'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta',
        'Iota', 'Kappa', 'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron', 'Pi',
        'Rho', 'Sigma', 'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega',
    ];
    function humanizeSpeakerLabel(raw) {
        if (raw == null) return raw;
        const s = String(raw);
        if (!s || s === '?' || s === '…' || s === 'Me' || s === 'Speaker' || s === 'S?') return s;
        const m = s.match(/^S(\d+)$/i);
        if (!m) return s;
        const idx = parseInt(m[1], 10);
        if (Number.isNaN(idx) || idx < 0) return s;
        const base = PHONETIC_LETTERS[idx % PHONETIC_LETTERS.length];
        const cycle = Math.floor(idx / PHONETIC_LETTERS.length);
        return cycle === 0 ? base : `${base} ${cycle + 1}`;
    }

    function parseHms(s) {
        if (!s) return null;
        const parts = s.split(':').map(Number);
        if (parts.some(Number.isNaN)) return null;
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        return parts[0];
    }

    // ─── UI helpers ──────────────────────────────────────────────────────
    function configureLanes(sources) {
        for (const source of ['mic', 'system']) {
            const c = meterContainers[source];
            if (!c) continue;
            c.classList.toggle('hidden', !sources.includes(source));
            setLevelMeter(source, 0);
        }
    }

    function setStatus(kind, text) {
        statusDot.classList.remove('dot-loading', 'dot-recording');
        if (kind === 'recording') statusDot.classList.add('dot-recording');
        if (kind === 'loading')   statusDot.classList.add('dot-loading');
        statusText.textContent = text;
    }

    function setLevelMeter(source, ratio01) {
        const meter = meters[source];
        if (!meter) return;
        const bars = meter.children;
        const active = Math.round(Math.max(0, Math.min(1, ratio01)) * bars.length);
        for (let i = 0; i < bars.length; i++) {
            bars[i].classList.toggle('active', i < active);
        }
    }

    function startTimer() {
        stopTimer();
        state.timerInterval = setInterval(() => {
            const sec = Math.floor((Date.now() - state.startedAt) / 1000);
            timerEl.textContent = formatHms(sec);
        }, 500);
    }

    function stopTimer() {
        if (state.timerInterval) clearInterval(state.timerInterval);
        state.timerInterval = null;
    }

    function formatHms(sec) {
        const s = Math.max(0, Math.floor(Number(sec) || 0));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const r = s % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return h > 0 ? `${pad(h)}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
    }

    function formatBytes(b) {
        if (!b) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        let i = 0;
        let n = b;
        while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
        return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
    }

    function estimateWavSize(durationSec) {
        // 16 kHz mono * 2 bytes/sample + 44-byte header.
        return Math.floor(durationSec * 16_000 * 2) + 44;
    }
})();
