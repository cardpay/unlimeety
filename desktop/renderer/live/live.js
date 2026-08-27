/* ─────────────────────────────────────────────────────────────────────────────
 * Unlimeety Desktop — Live tab (isolated)
 *
 * Everything in this file lives behind `window.live` (exposed by preload.js)
 * and the #live-container DOM subtree. It has NO references to app.js state
 * or to any Editor-tab element outside of the tab switcher and the
 * `body.mode-*` class, which is the single contract between the two tabs.
 * ─────────────────────────────────────────────────────────────────────── */

(() => {
    const live = window.live;
    if (!live) {
        console.warn('[live] window.live is not exposed; live tab disabled');
        return;
    }

    // Reserved pseudo-speaker for the user's own typed notes. A real speaker
    // must never be renamed onto it. Shared with app.js via the notes module
    // so the two rename guards can't disagree about the label; defaulted for
    // the same reason app.js defaults it — this tab must not hard-depend on a
    // helper script's load order.
    const NOTE_LABEL = window.notesList?.NOTE_LABEL ?? 'Note';

    // ─── DOM refs ────────────────────────────────────────────────────────
    const $ = (id) => document.getElementById(id);
    const tabButtons = Array.from(document.querySelectorAll('#tab-switch .tab-btn'));
    const editorPanel = $('editor-container');
    const livePanel   = $('live-container');

    const unsupportedBanner = $('live-unsupported');
    const mainArea          = $('live-main');

    const setupSection      = $('live-setup');
    const recordingSection  = $('live-recording');

    const modelGrid      = $('live-model-grid');
    const languageSelect = $('live-language');
    const srcMicCheck    = $('live-src-mic');
    const srcSystemCheck = $('live-src-system');
    const titleInput     = $('live-title');
    const setupError     = $('live-setup-error');
    const startBtn       = $('live-btn-start');
    const openScreenSettingsBtn = $('live-open-screen-settings');
    const micStatusEl    = $('live-mic-status');

    const statusDot   = $('live-status-dot');
    const statusText  = $('live-status-text');
    const timerEl     = $('live-timer');
    const stopBtn     = $('live-btn-stop');
    const discardBtn  = $('live-btn-discard');
    const notesBtn      = $('live-btn-notes');
    const notesBtnLabel = $('live-btn-notes-label');
    const liveRecordingIndicator = document.getElementById('live-recording-indicator');

    const downloadBox = $('live-download');
    const progressBar = $('live-progress-bar');

    const streamEl = $('live-stream');
    const streamEmpty = $('live-stream-empty');
    const diagToggle = $('live-diag-toggle');
    const diagPanel  = $('live-diag-panel');
    const askAiBtn   = $('live-btn-ask-ai');
    const meters = {
        mic:    document.querySelector('.live-level-meter[data-meter="mic"]'),
        system: document.querySelector('.live-level-meter[data-meter="system"]'),
    };
    const meterContainers = {
        mic:    document.querySelector('.live-meter[data-source="mic"]'),
        system: document.querySelector('.live-meter[data-source="system"]'),
    };

    // ─── State ───────────────────────────────────────────────────────────
    const state = {
        running: false,
        // true after a successful save — the next click on the Live tab resets
        // back to the setup screen instead of showing the finished transcript.
        finished: false,
        startedAt: 0,
        timerInterval: null,
        finalizedSegments: [],       // final segments collected in order
        activePartials: new Map(),   // key source → { node, seg } for the rolling partial
        currentLanguage: languageSelect?.querySelector('.ts-seg.is-active')?.dataset.lang || 'ru',
        sources: ['mic', 'system'], // currently active sources
        meterPulse: null,            // setInterval handle for the fake activity meter
        lastSeenAt: { mic: 0, system: 0 }, // timestamps of last segment per source
        // Currently-selected WhisperKit model. Mirrors `.is-active` on a card
        // in #live-model-grid; initialized from whichever card carries the
        // class in the HTML so the UI and state never disagree on first load.
        model: (modelGrid?.querySelector('.ts-model-card.is-active')?.dataset.model)
            || 'openai_whisper-base',
        // Attendee names from the calendar event the user picked (if any).
        // There's no participants field in the Live UI, so we stash them here
        // and pass them to saveTranscript for the "Participants:" header line.
        calendarParticipants: [],
        // Manual speaker → real-name overrides, keyed by speaker key
        // ('Me' for the mic, raw diarization label 'S1'/'S2'/… for system).
        // Baked into the transcript on save; suggested from calendarParticipants.
        speakerNames: {},
    };

    // ─── Calendar pre-fill ───────────────────────────────────────────────
    // Shared by the picker (this tab's 📅 button) and the smart router
    // (calendar-smart.js), which routes here and pre-fills after switching tab.
    function applyCalendarPick({ title, participants }) {
        if (title) titleInput.value = title;
        state.calendarParticipants = Array.isArray(participants) ? participants : [];
    }
    window.calendarPicker?.attach({ button: $('live-cal-btn'), onPick: applyCalendarPick });
    window.liveTab = { applyCalendarPick };

    // ─── Model picker ────────────────────────────────────────────────────
    // Card grid mirrors the Record tab. One card is `.is-active` at all
    // times; clicking another moves the radio dot, repaints styles, and
    // updates state.model. The footer badge doubles as a download button
    // when the model is not on disk, and a trash icon appears beside the
    // "✓ installed" badge for cached models.

    // Repaint installed/download badges using the Record tab's API
    // (it's just a filesystem read of the shared WhisperKit cache, so
    // both tabs see the same models — fine to reuse here). Also sets
    // .is-installed on the card so the per-card delete icon shows up.
    async function refreshLiveModelBadges() {
        if (!modelGrid) return;
        const getter = window.recordApi?.getInstalledModels;
        if (typeof getter !== 'function') return;
        let installed;
        try { installed = new Set(await getter()); } catch { return; }
        for (const card of modelGrid.querySelectorAll('.ts-model-card')) {
            const badge = card.querySelector('.ts-badge-installed, .ts-badge-download');
            if (!badge) continue;
            const isInstalled = installed.has(card.dataset.model);
            card.classList.toggle('is-installed', isInstalled);
            // Don't repaint the badge while a download is mid-flight —
            // the in-progress handler owns its label until completion.
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

    async function handleDeleteModel(card) {
        const m = card.dataset.model;
        if (!m) return;
        if (!confirm(`Delete model "${m}" from disk?\n\nIt will be re-downloaded the next time you select it.`)) return;
        const res = await window.recordApi?.deleteModel?.(m);
        if (res && !res.ok) {
            alert('Delete failed: ' + (res.error || 'unknown'));
        }
        await refreshLiveModelBadges();
    }

    async function handleDownloadModel(card, badge) {
        const m = card.dataset.model;
        if (!m || card.classList.contains('is-downloading')) return;
        card.classList.add('is-downloading');
        const originalText = badge.textContent;
        badge.textContent = 'starting…';
        const res = await window.live?.downloadModel?.(m);
        card.classList.remove('is-downloading');
        if (!res || !res.ok) {
            badge.textContent = originalText;
            alert('Download failed: ' + (res?.error || 'unknown'));
        }
        await refreshLiveModelBadges();
    }

    if (modelGrid) {
        modelGrid.addEventListener('click', (ev) => {
            const deleteEl = ev.target.closest('[data-action="delete-model"]');
            if (deleteEl) {
                ev.stopPropagation();
                ev.preventDefault();
                const card = deleteEl.closest('.ts-model-card');
                if (card) handleDeleteModel(card);
                return;
            }
            const downloadEl = ev.target.closest('[data-action="download-model"]');
            if (downloadEl) {
                ev.stopPropagation();
                ev.preventDefault();
                const card = downloadEl.closest('.ts-model-card');
                if (card) handleDownloadModel(card, downloadEl);
                return;
            }
            const card = ev.target.closest('.ts-model-card');
            if (!card || !card.dataset.model) return;
            state.model = card.dataset.model;
            for (const c of modelGrid.querySelectorAll('.ts-model-card')) {
                const active = c === card;
                c.classList.toggle('is-active', active);
                const radio = c.querySelector('.ts-radio');
                if (radio) radio.innerHTML = active ? '<span class="ts-radio-dot"></span>' : '';
            }
        });

        refreshLiveModelBadges();
    }

    // ─── Language picker ─────────────────────────────────────────────────
    languageSelect.addEventListener('click', ev => {
        const seg = ev.target.closest('.ts-seg');
        if (!seg) return;
        const lang = seg.dataset.lang;
        if (!lang) return;
        for (const s of languageSelect.querySelectorAll('.ts-seg')) {
            s.classList.toggle('is-active', s === seg);
        }
        state.currentLanguage = lang;
    });

    // ─── Tab switching ───────────────────────────────────────────────────
    // Shared switcher — also drives the Record tab via its own #record-container.
    // Both live.js and record.js bind click handlers on the same buttons but
    // only this function ever toggles panel visibility, so there's no race.
    function switchTab(name) {
        // #transcribe-flow (record.js) is a top-level overlay independent of
        // which tab panel is showing — close it first so a tab switch (toolbar
        // click, ⌘R, a recording-indicator pill) can never leave it pinned on
        // top of the tab the user just switched to.
        window.recordTab?.closeTranscribeFlow?.();
        tabButtons.forEach(b => b.classList.toggle('tab-active', b.dataset.tab === name));
        editorPanel.classList.toggle('hidden', name !== 'editor');
        livePanel.classList.toggle('hidden',   name !== 'live');
        const recordPanel = document.getElementById('record-container');
        if (recordPanel) recordPanel.classList.toggle('hidden', name !== 'record');
        document.body.classList.toggle('mode-live',   name === 'live');
        document.body.classList.toggle('mode-record', name === 'record');
        // Clear the record-phase marker when leaving the Record tab so any
        // record-phase-specific CSS (e.g. hidden sidebars) does not leak into
        // other tabs.
        if (name !== 'record') {
            delete document.body.dataset.recordPhase;
        }
    }

    openScreenSettingsBtn?.addEventListener('click', () => {
        if (typeof live.openScreenSettings === 'function') live.openScreenSettings();
    });

    // Troubleshoot block: copy the `tccutil reset …` command to the clipboard
    // so the user can paste straight into Terminal. We deliberately read the
    // text from the DOM instead of duplicating the literal in JS — that way
    // the displayed and copied command can never drift apart.
    const copyTccBtn = $('live-copy-tcc-cmd');
    copyTccBtn?.addEventListener('click', async () => {
        const codeEl = document.getElementById('live-tcc-reset-cmd');
        if (!codeEl) return;
        const cmd = codeEl.textContent || '';
        try {
            await navigator.clipboard.writeText(cmd);
            const original = copyTccBtn.textContent;
            copyTccBtn.textContent = 'Copied ✓';
            setTimeout(() => { copyTccBtn.textContent = original; }, 1500);
        } catch (err) {
            // Clipboard access blocked (rare in Electron, but possible if
            // the renderer is sandboxed). Silently leave the label intact —
            // the command is still visible in the <pre> for manual copy.
        }
    });

    diagToggle?.addEventListener('click', () => {
        const open = diagPanel.classList.toggle('hidden') === false;
        diagToggle.setAttribute('aria-expanded', String(open));
    });

    // Rolling window of the last ~80 helper-stderr lines.
    const diagBuffer = [];
    function pushDiag(line) {
        const stamp = new Date().toLocaleTimeString();
        diagBuffer.push(`${stamp}  ${line}`);
        if (diagBuffer.length > 80) diagBuffer.shift();
        if (!diagPanel) return;
        diagPanel.textContent = diagBuffer.join('\n');
        diagPanel.scrollTop = diagPanel.scrollHeight;
    }

    // Tab switching during a Live session is intentionally unblocked: the
    // helper proc lives in main, events keep flowing via IPC, the DOM stream
    // is updated even while #live-container is hidden, the timer interval
    // doesn't pause. The toolbar's #live-recording-indicator pill is what
    // tells the user "Live is still running — click to return".
    tabButtons.forEach(btn => btn.addEventListener('click', () => {
        // Returning to Live after a finished-and-saved session should show a
        // fresh "new recording" setup screen, not the last transcript. The
        // `finished` flag is only set after a successful save (never during
        // startup), so a session that's still loading is never wiped.
        if (btn.dataset.tab === 'live' && state.finished && !state.running) {
            returnToSetup();
        }
        switchTab(btn.dataset.tab);
    }));

    // Toolbar pill: visible whenever Live is running, regardless of which tab
    // the user is currently on. Clicking it just routes the click through the
    // existing tab-switch handler — no need to call showSection() since the
    // Live tab's recordingSection stays visible throughout (we never hide it
    // on tab swap).
    function updateLiveRecordingIndicator() {
        if (!liveRecordingIndicator) return;
        liveRecordingIndicator.classList.toggle('hidden', !state.running);
    }
    liveRecordingIndicator?.addEventListener('click', () => {
        document.querySelector('[data-tab="live"]')?.click();
    });

    // ─── Platform gating ─────────────────────────────────────────────────
    (async () => {
        const ok = await live.platformOK();
        if (ok) {
            unsupportedBanner.classList.add('hidden');
            mainArea.classList.remove('hidden');
        } else {
            unsupportedBanner.classList.remove('hidden');
            mainArea.classList.add('hidden');
        }
    })();

    // The hint below this used to always say "First launch: macOS will ask…"
    // regardless of whether that had already happened. Real Microphone status
    // replaces the guesswork for the two states worth reporting; Screen
    // Recording is left as-is (see live.css) — that OS API is known to cache
    // and lie right after a fresh grant, unlike this one. 'not-determined' —
    // macOS hasn't even asked yet — is left blank rather than shown as denied;
    // the static copy below already covers that case. Re-run on return to
    // setup too: the very first Start click is what triggers the real prompt,
    // so the answer is only known *after* it, not at module load.
    async function refreshMicStatus() {
        const status = await live?.micStatus?.();
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

    // ─── Setup → start ───────────────────────────────────────────────────
    startBtn.addEventListener('click', async () => {
        setupError.classList.add('hidden');
        setupError.textContent = '';

        const sources = [];
        if (srcMicCheck.checked)    sources.push('mic');
        if (srcSystemCheck.checked) sources.push('system');

        if (!sources.length) {
            showSetupError('Choose at least one audio source.');
            return;
        }

        const config = {
            model:    state.model,
            language: state.currentLanguage,
            sources,
            // Raw user title (possibly empty). main.js uses this to name the
            // WAV file under RECORDINGS_FOLDER — empty falls back to a pure
            // timestamp stem, matching the Record tab. The transcript header
            // still uses defaultTitle() further down for the human-facing
            // "Meeting:" line when the user typed nothing.
            title: titleInput.value.trim(),
        };
        state.currentLanguage = config.language;

        // Switch to recording UI before start, so the user sees progress immediately.
        resetRecordingUI();
        configureLanes(sources);
        setupSection.classList.add('hidden');
        recordingSection.classList.remove('hidden');
        setStatus('loading', 'Loading model…');

        const res = await live.start(config);
        if (!res?.ok) {
            setupSection.classList.remove('hidden');
            recordingSection.classList.add('hidden');
            showSetupError(res?.error || 'Failed to start');
            // Back on setup after main's own mic-permission gate ran (and,
            // most likely, just triggered the real OS prompt for the first
            // time) — re-read the answer instead of showing what was true
            // before the click.
            refreshMicStatus();
            return;
        }

        state.running = true;
        state.startedAt = Date.now();
        state.sources = sources;
        startTimer();
        startMeterPulse();
        updateLiveRecordingIndicator();
    });

    // ─── Auto-detect → open Live tab ─────────────────────────────────────
    // Fired by main when the user accepts the "call detected" prompt. Surface
    // the Live tab and pre-fill the title from the calendar (if any); the user
    // presses Start manually.
    live.onAutoStart?.(({ title } = {}) => {
        document.querySelector('.tab-btn[data-tab="live"]')?.click();
        if (title && !titleInput.value.trim()) titleInput.value = title;
    });

    // ─── Stop → save ─────────────────────────────────────────────────────
    // Shared by the Stop button and the auto-stop trigger (main fires a
    // `autoStop` event when the meeting ended and the countdown elapsed).
    async function stopAndSave() {
        if (!state.running) return;
        stopBtn.disabled = true;
        stopBtn.querySelector('span:last-child').textContent = 'Saving…';
        setStatus('loading', 'Finalizing…');

        await live.stop();
        stopTimer();
        stopMeterPulse();
        state.running = false;
        updateLiveRecordingIndicator();

        // Snapshot segments from our local record (the main process also keeps
        // its own copy, but we pass ours so the rendered order is canonical).
        const segments = state.finalizedSegments.map(s => ({
            source: s.source,
            speaker: s.speaker,
            start: s.start,
            end: s.end,
            text: s.text,
        }));

        const title = titleInput.value.trim() || defaultTitle();

        const result = await live.saveTranscript({
            title,
            language: state.currentLanguage,
            segments,
            calendarParticipants: state.calendarParticipants,
            speakerNames: state.speakerNames,
        });

        if (result?.ok) {
            setStatus('idle', `Saved to ${result.filePath}`);
            stopBtn.classList.add('hidden');
            discardBtn.classList.remove('hidden');
            discardBtn.textContent = 'New recording';
            state.finished = true;
            // Mirror the Record tab: jump to the Transcripts tab and open the
            // freshly saved transcript (app.js listens for this event).
            document.dispatchEvent(new CustomEvent('transcript:created', {
                detail: { filePath: result.filePath },
            }));
        } else {
            setStatus('idle', `Save failed: ${result?.error || 'unknown'}`);
            stopBtn.disabled = false;
            stopBtn.querySelector('span:last-child').textContent = 'Stop & save';
        }
    }

    stopBtn.addEventListener('click', stopAndSave);

    discardBtn.addEventListener('click', () => {
        if (state.running) return;
        returnToSetup();
    });

    // Re-shows the floating notes window if the user closed it manually
    // mid-session, or after the helper died while notes are still held.
    // Main refuses when there is genuinely nothing to show — say so rather
    // than leaving the click looking broken.
    // The label, not the tooltip: a native tooltip needs a hover dwell to
    // appear and the pointer is already down on the button, so a title swap
    // is feedback the user never sees. The original text is captured once, at
    // load — reading it back inside the handler meant a second click within
    // the timeout captured the *message* and restored that forever.
    const NOTES_BTN_LABEL = notesBtnLabel?.textContent || 'Notes';
    let notesBtnResetTimer = null;
    notesBtn?.addEventListener('click', async () => {
        const res = await window.notesApi?.reopen();
        if (res?.ok) return;
        if (!notesBtnLabel) return;
        notesBtnLabel.textContent = 'No notes yet';
        clearTimeout(notesBtnResetTimer);
        notesBtnResetTimer = setTimeout(() => {
            notesBtnLabel.textContent = NOTES_BTN_LABEL;
        }, 2500);
    });

    // ─── Helper events ───────────────────────────────────────────────────
    live.onEvent((event) => {
        if (!event || typeof event.type !== 'string') return;

        // Mirror everything we receive into the diagnostics buffer too —
        // the line gets a structured tag so it's easier to scan.
        if (event.type === 'helperLog') {
            pushDiag(event.line || '');
        } else if (event.type === 'audioLevel') {
            // skip — too noisy to log
        } else {
            const compact = JSON.stringify(event);
            pushDiag(`event ${compact.length > 200 ? compact.slice(0, 200) + '…' : compact}`);
        }

        switch (event.type) {
            case 'autoStop':
                // Meeting ended + countdown elapsed → same as pressing Stop.
                stopAndSave();
                break;
            case 'ready':
                // Helper process is up; waiting for our "start" to take effect.
                setStatus('loading', 'Connecting to helper…');
                break;

            case 'modelDownload': {
                const pct = Math.max(0, Math.min(1, Number(event.progress) || 0));
                downloadBox.classList.remove('hidden');
                progressBar.style.width = (pct * 100).toFixed(1) + '%';
                if (pct >= 1) {
                    // Files on disk; WhisperKit still has to load them into
                    // memory and start the audio engines. Show that step
                    // separately and wait for the helper's `recording` event.
                    downloadBox.classList.add('hidden');
                    setStatus('loading', 'Loading model into memory…');
                } else {
                    setStatus('loading', `Downloading model… ${Math.round(pct * 100)}%`);
                }
                break;
            }

            case 'modelDownloadProgress': {
                // Standalone pre-fetch from the model picker (no live session).
                // Update the matching card's footer badge in place.
                const card = modelGrid?.querySelector(`.ts-model-card[data-model="${event.model}"]`);
                if (!card) break;
                const badge = card.querySelector('.ts-badge-installed, .ts-badge-download');
                if (!badge) break;
                const pct = Math.max(0, Math.min(1, Number(event.progress) || 0));
                badge.textContent = `↓ ${Math.round(pct * 100)}%`;
                break;
            }

            case 'recording':
                setStatus('recording', 'Recording');
                break;

            case 'helperLog':
                // Already pushed to the diagnostics buffer above; nothing else to do.
                break;

            case 'audioLevel': {
                // Real RMS from the helper, ~10 Hz per source. Drives the
                // topbar level meter directly; we also note the timestamp so
                // the fallback pulse stays quiet when real data is flowing.
                const src = event.source === 'mic' ? 'mic' : 'system';
                const lvl = Math.max(0, Math.min(1, Number(event.level) || 0));
                setLevelMeter(src, lvl);
                state.lastLevelAt = state.lastLevelAt || { mic: 0, system: 0 };
                state.lastLevelAt[src] = Date.now();
                break;
            }

            case 'segment':
                handleSegment(event);
                break;

            case 'diarizing':
                setStatus('loading', 'Labeling speakers…');
                break;

            case 'diarizationComplete':
                applyDiarization(Array.isArray(event.segments) ? event.segments : []);
                break;

            case 'diarizationUpdate':
                // Periodic in-session diarization tick from the helper. Same payload
                // shape as `diarizationComplete` but emitted while still recording —
                // do NOT touch status text, the user is still in the "Recording" state.
                applyDiarization(Array.isArray(event.segments) ? event.segments : []);
                break;

            case 'diarizationUnavailable':
                // SpeakerKit failed to load; surface this as a soft warning so the
                // user understands why every system segment stays "S?". Render once
                // — the helper only emits this event a single time per session.
                appendDiarizationWarning(event.message || 'speaker labeling unavailable');
                break;

            case 'error':
                appendError(event.message || 'Unknown error');
                break;

            case 'stopped':
                // The helper confirmed clean shutdown — nothing else to do here;
                // the stop-button handler already drove the save flow.
                break;

            case 'exited':
                if (state.running) {
                    state.running = false;
                    stopTimer();
                    setStatus('idle', `Helper exited (code ${event.code})`);
                    updateLiveRecordingIndicator();
                }
                break;
        }
    });

    // ─── Segment rendering ───────────────────────────────────────────────
    function handleSegment(seg) {
        // The first real segment means model loaded and audio is flowing.
        if (!downloadBox.classList.contains('hidden')) downloadBox.classList.add('hidden');
        if (statusDot.classList.contains('dot-loading')) setStatus('recording', 'Recording');

        streamEmpty?.classList.add('hidden');

        const source = (seg.source === 'mic' || seg.source === 'system') ? seg.source : 'system';
        const key = source; // one rolling partial per source

        const existing = state.activePartials.get(key);

        if (seg.final) {
            const node = existing?.node || makeSegmentNode(seg);
            updateSegmentNode(node, seg, false);
            state.activePartials.delete(key);
            if (!existing) streamEl.appendChild(node);
            state.finalizedSegments.push(seg);
        } else {
            const node = existing?.node || makeSegmentNode(seg);
            updateSegmentNode(node, seg, true);
            if (!existing) streamEl.appendChild(node);
            state.activePartials.set(key, { node, seg });
        }

        state.lastSeenAt[source] = Date.now();
        updateAskAiAvailability();

        const nearBottom = streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight < 80;
        if (nearBottom) streamEl.scrollTop = streamEl.scrollHeight;
    }

    function makeSegmentNode(seg) {
        // Single chronological stream — colour identity now comes from a
        // per-source class on the segment itself (.src-mic / .src-system).
        const source = seg.source === 'mic' ? 'mic' : 'system';
        const div = document.createElement('div');
        div.className = `live-segment src-${source}`;
        div.innerHTML = `
            <div class="live-seg-meta">
                <span class="live-seg-speaker"></span>
                <span class="live-seg-time"></span>
            </div>
            <div class="live-seg-text"></div>
        `;
        return div;
    }

    function updateSegmentNode(node, seg, partial) {
        node.classList.toggle('partial', partial);
        const label = speakerLabel(seg);
        // System segments before diarization wear a "speaker-pending" class so
        // their speaker chip uses the neutral grey style.
        const pending = seg.source !== 'mic' && (label === 'S?' || label === '…');
        node.classList.toggle('speaker-pending', pending);
        // Stamp a stable rename key (mic → 'Me', diarized system → raw label);
        // pending/unknown segments get no key so they can't be renamed yet.
        setSpeakerKey(node, seg);
        applySpeakerClass(node, seg);
        node.querySelector('.live-seg-speaker').textContent = label;
        node.querySelector('.live-seg-time').textContent = formatHms(seg.start);
        node.querySelector('.live-seg-text').textContent = seg.text || '';
    }

    // Greek phonetic alphabet — same mapping as humanizeSpeakerLabel in
    // main.js: S0 → Alpha, S1 → Beta, …, S23 → Omega. After Omega the
    // letters recycle with a numeric suffix (Alpha 2, Beta 2, …).
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

    // Rename key for a segment: 'Me' for the mic, the raw diarization label for
    // a labeled system segment, or '' when there's no stable speaker yet.
    function speakerKeyOf(seg) {
        if (seg.source === 'mic') return 'Me';
        if (seg.speaker && seg.speaker !== '?' && seg.speaker !== '…') return seg.speaker;
        return '';
    }

    function setSpeakerKey(node, seg) {
        const key = speakerKeyOf(seg);
        if (key) node.dataset.speakerKey = key;
        else delete node.dataset.speakerKey;
    }

    // Display label for a rename key, honouring manual overrides.
    function labelForKey(key) {
        if (state.speakerNames[key]) return state.speakerNames[key];
        return key === 'Me' ? 'Me' : humanizeSpeakerLabel(key);
    }

    function speakerLabel(seg) {
        const key = speakerKeyOf(seg);
        if (key) return labelForKey(key);
        return 'S?';
    }

    // Re-render every visible speaker chip from the current name overrides.
    function refreshSpeakerChips() {
        for (const node of streamEl.querySelectorAll('.live-segment')) {
            const key = node.dataset.speakerKey;
            if (!key) continue;
            node.querySelector('.live-seg-speaker').textContent = labelForKey(key);
        }
    }

    // Click a speaker chip to bind a real name to that speaker. Applies to every
    // line of that speaker; suggestions come from the picked calendar event.
    streamEl.addEventListener('click', (e) => {
        const chip = e.target.closest('.live-seg-speaker');
        if (!chip) return;
        const key = chip.closest('.live-segment')?.dataset.speakerKey;
        if (!key) return; // no stable label yet (pending / S?)
        window.speakerRename?.open({
            anchor: chip,
            current: state.speakerNames[key] || chip.textContent,
            suggestions: state.calendarParticipants,
            // Side-effect free (see speaker-rename.js). live:saveTranscript
            // filters this out of the names map too — that's the real guard,
            // since it covers every rename path — but refusing here means the
            // chip never shows a name the transcript won't honour. "Note" is
            // the reserved marker for the user's own typed notes.
            validate: (name) => (name.trim() === NOTE_LABEL
                ? `"${NOTE_LABEL}" is reserved for your own typed notes`
                : null),
            onCommit: (name) => {
                if (name) state.speakerNames[key] = name;
                else delete state.speakerNames[key];
                refreshSpeakerChips();
            },
        });
    });

    // Pick the per-speaker CSS class slug (e.g. "speaker-alpha"). Returns
    // null for placeholder / mic segments — those get their colour from
    // .src-mic / .speaker-pending instead.
    function speakerClassSlug(seg) {
        if (seg.source === 'mic') return null;
        const raw = seg.speaker;
        if (!raw || raw === '?' || raw === '…') return null;
        const m = String(raw).match(/^S(\d+)$/i);
        if (!m) return null;
        const idx = parseInt(m[1], 10);
        if (Number.isNaN(idx) || idx < 0) return null;
        const base = PHONETIC_LETTERS[idx % PHONETIC_LETTERS.length];
        return `speaker-${base.toLowerCase()}`;
    }

    function applySpeakerClass(node, seg) {
        // Strip any prior speaker-XXX class (but leave speaker-pending alone —
        // that's a state flag, not a colour slot).
        for (const c of Array.from(node.classList)) {
            if (c.startsWith('speaker-') && c !== 'speaker-pending') {
                node.classList.remove(c);
            }
        }
        const slug = speakerClassSlug(seg);
        if (slug) node.classList.add(slug);
    }

    // Replace system-segment speaker labels with the values produced by
    // batch diarization. Match by time overlap (same heuristic as the helper).
    function applyDiarization(ranges) {
        if (!ranges.length) return;

        for (const seg of state.finalizedSegments) {
            if (seg.source !== 'system') continue;

            let bestOverlap = 0;
            let bestLabel = seg.speaker;
            for (const r of ranges) {
                const overlap = Math.max(0, Math.min(seg.end, r.end) - Math.max(seg.start, r.start));
                if (overlap > bestOverlap) {
                    bestOverlap = overlap;
                    bestLabel = r.speaker;
                }
            }
            seg.speaker = bestLabel;
        }

        // Walk DOM in order, lining up final system-source nodes with the
        // updated finalized segments and rewriting their speaker chip.
        const nodes = streamEl.querySelectorAll('.live-segment.src-system');
        let idx = 0;
        const systemSegments = state.finalizedSegments.filter(s => s.source === 'system');
        for (const node of nodes) {
            if (idx >= systemSegments.length) break;
            if (node.classList.contains('partial')) continue;
            const seg = systemSegments[idx++];
            const label = speakerLabel(seg);
            const pending = label === 'S?' || label === '…';
            node.classList.toggle('speaker-pending', pending);
            setSpeakerKey(node, seg);
            applySpeakerClass(node, seg);
            node.querySelector('.live-seg-speaker').textContent = label;
        }
    }

    // ─── UI helpers ──────────────────────────────────────────────────────
    // Swap the recording view for the setup screen and wipe session state.
    // Shared by the "New recording" button and the auto-reset on tab re-entry.
    function returnToSetup() {
        setupSection.classList.remove('hidden');
        recordingSection.classList.add('hidden');
        resetRecordingUI();
        refreshMicStatus();
    }

    function resetRecordingUI() {
        state.finished = false;
        state.finalizedSegments = [];
        state.activePartials.clear();
        diarizationWarningShown = false;
        // Wipe everything except the empty placeholder.
        streamEl.querySelectorAll('.live-segment').forEach(n => n.remove());
        if (streamEmpty) {
            streamEmpty.classList.remove('hidden');
            if (streamEmpty.parentElement !== streamEl) streamEl.appendChild(streamEmpty);
        }
        downloadBox.classList.add('hidden');
        progressBar.style.width = '0%';
        stopBtn.disabled = false;
        stopBtn.querySelector('span:last-child').textContent = 'Stop & save';
        stopBtn.classList.remove('hidden');
        discardBtn.classList.add('hidden');
        timerEl.textContent = '00:00';
        for (const source of ['mic', 'system']) setLevelMeter(source, 0);
        updateAskAiAvailability();
        updateLiveRecordingIndicator();
    }

    // ─── Ask AI ──────────────────────────────────────────────────────────
    // The bubble is enabled as soon as any segment (partial or final) has
    // landed; on click it hands a fresh snapshot of the transcript to the
    // shared chat modal. The renderer re-snapshots on every send so anything
    // dictated while AI is replying is in the next question's context.
    function updateAskAiAvailability() {
        if (!askAiBtn) return;
        const has = state.finalizedSegments.length > 0 || state.activePartials.size > 0;
        askAiBtn.disabled = !has;
    }

    function buildLiveTranscriptText() {
        const segs = [...state.finalizedSegments];
        for (const { seg } of state.activePartials.values()) segs.push(seg);
        segs.sort((a, b) => (a.start || 0) - (b.start || 0));

        const title = titleInput.value.trim() || defaultTitle();
        const participants = Array.from(new Set(segs.map(s => {
            if (s.source === 'mic') return 'Me';
            return s.speaker && s.speaker !== '?' && s.speaker !== '…'
                ? humanizeSpeakerLabel(s.speaker)
                : null;
        }).filter(Boolean)));

        const headerLines = [`Meeting: ${title}`];
        if (participants.length) headerLines.push(`Participants: ${participants.join(', ')}`);
        if (state.currentLanguage) headerLines.push(`Language: ${state.currentLanguage}`);
        headerLines.push('Status: live (still in progress)');
        const body = segs.map(seg => {
            const t = formatHms(seg.start);
            const who = seg.source === 'mic'
                ? 'Me'
                : (seg.speaker && seg.speaker !== '?' && seg.speaker !== '…'
                    ? humanizeSpeakerLabel(seg.speaker)
                    : 'Speaker');
            return `[${t}] ${who}:\n${String(seg.text || '').trim()}`;
        }).join('\n\n');
        return headerLines.join('\n') + (body ? '\n\n' + body : '');
    }

    askAiBtn?.addEventListener('click', () => {
        if (askAiBtn.disabled) return;
        if (typeof window.appChat?.openLive !== 'function') return;
        const title = titleInput.value.trim() || defaultTitle();
        window.appChat.openLive(title, buildLiveTranscriptText);
    });

    function configureLanes(sources) {
        // Hide the meter for any source that wasn't selected.
        for (const source of ['mic', 'system']) {
            const c = meterContainers[source];
            if (!c) continue;
            c.classList.toggle('hidden', !sources.includes(source));
        }
    }

    function setStatus(kind, text) {
        statusDot.classList.remove('dot-loading', 'dot-recording');
        if (kind === 'recording') statusDot.classList.add('dot-recording');
        if (kind === 'loading')   statusDot.classList.add('dot-loading');
        statusText.textContent = text;
    }

    function showSetupError(msg) {
        setupError.textContent = msg;
        setupError.classList.remove('hidden');
    }

    function appendError(msg) {
        const div = document.createElement('div');
        div.className = 'live-segment';
        div.innerHTML = `
            <div class="live-seg-meta">
                <span class="live-seg-speaker" style="background:rgba(239,68,68,0.16);color:#fca5a5;border-color:rgba(239,68,68,0.4)">error</span>
                <span class="live-seg-time"></span>
            </div>
            <div class="live-seg-text" style="color:#fca5a5"></div>
        `;
        div.querySelector('.live-seg-text').textContent = msg;
        streamEl.appendChild(div);
        streamEmpty?.classList.add('hidden');
    }

    let diarizationWarningShown = false;
    function appendDiarizationWarning(msg) {
        if (diarizationWarningShown) return;
        diarizationWarningShown = true;
        const div = document.createElement('div');
        div.className = 'live-segment';
        div.innerHTML = `
            <div class="live-seg-meta">
                <span class="live-seg-speaker" style="background:rgba(234,179,8,0.16);color:#fde68a;border-color:rgba(234,179,8,0.4)">no speakers</span>
                <span class="live-seg-time"></span>
            </div>
            <div class="live-seg-text" style="color:#fde68a"></div>
        `;
        div.querySelector('.live-seg-text').textContent = `Speaker labeling unavailable: ${msg}. System segments will stay labeled "S?".`;
        streamEl.appendChild(div);
        streamEmpty?.classList.add('hidden');
    }

    // ─── Timer ──────────────────────────────────────────────────────────
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

    // ─── Level meter ───────────────────────────────────────────────────
    // The Swift helper does not (yet) emit per-chunk RMS values, so the meter
    // is a *soft* activity indicator: while we are receiving partial/final
    // segments for a given source the bars dance; once segments stop coming
    // (>1.2 s gap) the bars fall to the floor. The contract is intentionally
    // loose so we can swap in real RMS data later without UI changes.
    function setLevelMeter(source, ratio01) {
        const meter = meters[source];
        if (!meter) return;
        const bars = meter.children;
        const active = Math.round(Math.max(0, Math.min(1, ratio01)) * bars.length);
        for (let i = 0; i < bars.length; i++) {
            bars[i].classList.toggle('active', i < active);
        }
    }

    // Fallback "soft activity" — only kicks in if the helper hasn't sent a
    // real `audioLevel` event for >700 ms, which means either the helper is
    // older than the RMS protocol or audio is genuinely silent. In the
    // silent case we still want a tiny baseline shimmer so the user doesn't
    // mistake "idle" for "frozen".
    function startMeterPulse() {
        stopMeterPulse();
        state.lastLevelAt = state.lastLevelAt || { mic: 0, system: 0 };
        state.meterPulse = setInterval(() => {
            const now = Date.now();
            for (const source of ['mic', 'system']) {
                if (!state.sources.includes(source)) {
                    setLevelMeter(source, 0);
                    continue;
                }
                const sinceLevel = now - (state.lastLevelAt[source] || 0);
                if (sinceLevel < 700) continue; // real RMS in flight, leave it alone
                // No real data — tiny baseline so the user can tell the UI is alive.
                setLevelMeter(source, 0.08);
            }
        }, 250);
    }

    function stopMeterPulse() {
        if (state.meterPulse) clearInterval(state.meterPulse);
        state.meterPulse = null;
        for (const source of ['mic', 'system']) setLevelMeter(source, 0);
    }

    function formatHms(sec) {
        const s = Math.max(0, Math.floor(Number(sec) || 0));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const r = s % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return h > 0 ? `${pad(h)}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
    }

    function defaultTitle() {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `Live recording — ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
    }
})();
