/* UI Injection and DOM Monitoring Logic */

let isRecording = false;
let observer = null;

let currentLanguage = 'ru'; // Default option
let currentTheme = 'auto';  // 'auto' (follow OS) | 'light' | 'dark'

// Collect unique speaker names from the live transcript
const knownSpeakers = new Set();

// Wait for the DOM to load before injecting our UI
window.addEventListener('load', () => {
    injectUI();
});

window.addEventListener('beforeunload', () => {
    if (isRecording) {
        triggerAutoSave();
    }
});

function injectUI() {
    // Basic Tactiq-style widget
    const container = document.createElement('div');
    container.id = 'gmt-transcriber-widget';
    container.innerHTML = `
        <div class="gmt-header">
            <span class="gmt-brand">
                <span class="gmt-brand-mark" aria-hidden="true">un</span>
                <span class="gmt-brand-label">Unlimeety</span>
            </span>
            <span class="gmt-header-actions">
                <button id="gmt-theme-toggle" title="Theme">
                    <svg viewBox="0 0 24 24" id="gmt-icon-theme-auto"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18V4c4.41 0 8 3.59 8 8s-3.59 8-8 8z"/></svg>
                    <svg viewBox="0 0 24 24" id="gmt-icon-theme-light" style="display:none;"><path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0 .39-.39.39-1.03 0-1.41l-1.06-1.06zm1.06-10.96c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z"/></svg>
                    <svg viewBox="0 0 24 24" id="gmt-icon-theme-dark" style="display:none;"><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z"/></svg>
                </button>
                <button id="gmt-toggle-collapse" title="Collapse">
                    <svg viewBox="0 0 24 24" id="gmt-icon-collapse"><path d="M7 14l5-5 5 5z"/></svg>
                    <svg viewBox="0 0 24 24" id="gmt-icon-expand" style="display:none;"><path d="M7 10l5 5 5-5z"/></svg>
                </button>
            </span>
        </div>
        <div class="gmt-content" id="gmt-content-body">
            <div class="gmt-controls">
                <div>
                    <label class="gmt-field-label" for="gmt-language">Language</label>
                    <select id="gmt-language">
                        <option value="ru">Русский</option>
                        <option value="en">English</option>
                        <option value="sr">Srpski</option>
                    </select>
                </div>
                <div class="gmt-main-controls">
                    <button id="gmt-record-btn" title="Start Recording">
                        <svg viewBox="0 0 24 24" id="gmt-icon-play" style="display:none;"><path d="M8 5v14l11-7z"/></svg>
                        <svg viewBox="0 0 24 24" id="gmt-icon-stop" style="display:none;"><path d="M6 6h12v12H6z"/></svg>
                    </button>
                    <button id="gmt-save-btn" title="Save transcript">
                        <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                    </button>
                </div>
                <div>
                    <label class="gmt-field-label" for="gmt-notes-input">Note</label>
                    <input id="gmt-notes-input" type="text" placeholder="Type and press Enter…" disabled />
                </div>
                <div class="gmt-status" aria-live="polite">
                    <span class="gmt-status-dot"></span>
                    <span class="gmt-status-label"></span>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(container);

    // Initially disable the record button until meeting is confirmed active
    const recordBtn = document.getElementById('gmt-record-btn');
    recordBtn.disabled = true;
    recordBtn.title = currentLanguage === 'ru' ? 'Сначала присоединитесь к встрече' : 'Join the meeting first';

    // Poll meeting status and auto-start recording when meeting becomes active
    window.meetingStatusInterval = setInterval(() => {
        const btn = document.getElementById('gmt-record-btn');
        if (!btn || isRecording) return;
        const active = isMeetingActive();
        btn.disabled = !active;
        btn.title = active ? 'Start Recording' : (currentLanguage === 'ru' ? 'Сначала присоединитесь к встрече' : 'Join the meeting first');
        if (active) {
            clearInterval(window.meetingStatusInterval);
            startRecording();
        }
    }, 2000);

    // Theme toggle: cycle auto (follow OS) → light → dark. 'auto' removes the
    // data-theme attr so content-light.css's prefers-color-scheme block decides.
    const THEME_CYCLE = ['auto', 'light', 'dark'];
    function applyWidgetTheme(mode) {
        currentTheme = THEME_CYCLE.includes(mode) ? mode : 'auto';
        const w = document.getElementById('gmt-transcriber-widget');
        if (w) {
            if (currentTheme === 'auto') delete w.dataset.theme;
            else w.dataset.theme = currentTheme;
        }
        const icons = { auto: 'gmt-icon-theme-auto', light: 'gmt-icon-theme-light', dark: 'gmt-icon-theme-dark' };
        for (const k in icons) {
            const el = document.getElementById(icons[k]);
            if (el) el.style.display = (k === currentTheme) ? 'block' : 'none';
        }
        const btn = document.getElementById('gmt-theme-toggle');
        if (btn) btn.title = `Theme: ${currentTheme} (click to change)`;
    }
    chrome.storage.local.get('gmt-theme', (res) => applyWidgetTheme(res && res['gmt-theme']));
    document.getElementById('gmt-theme-toggle').addEventListener('click', () => {
        const next = THEME_CYCLE[(THEME_CYCLE.indexOf(currentTheme) + 1) % THEME_CYCLE.length];
        applyWidgetTheme(next);
        chrome.storage.local.set({ 'gmt-theme': next });
    });

    // Event Listeners
    let lastExpandedSize = null;
    document.getElementById('gmt-toggle-collapse').addEventListener('click', () => {
        const container = document.getElementById('gmt-transcriber-widget');
        const collapseIcon = document.getElementById('gmt-icon-collapse');
        const expandIcon = document.getElementById('gmt-icon-expand');
        const toggleBtn = document.getElementById('gmt-toggle-collapse');

        // Capture expanded size before collapsing so we can snap back into the viewport on the next expand.
        if (!container.classList.contains('collapsed')) {
            lastExpandedSize = { w: container.offsetWidth, h: container.offsetHeight };
        }

        const isCollapsed = container.classList.toggle('collapsed');

        if (isCollapsed) {
            collapseIcon.style.display = 'none';
            expandIcon.style.display = 'block';
            toggleBtn.title = "Expand";
        } else {
            collapseIcon.style.display = 'block';
            expandIcon.style.display = 'none';
            toggleBtn.title = "Collapse";

            // After expanding, if the widget was dragged out near the bottom/right edges
            // (anchored via left/top), pull it back so the expanded panel fits the viewport.
            if (container.style.left && lastExpandedSize) {
                const curLeft = parseFloat(container.style.left) || 0;
                const curTop = parseFloat(container.style.top) || 0;
                const maxLeft = Math.max(0, window.innerWidth - lastExpandedSize.w);
                const maxTop = Math.max(0, window.innerHeight - lastExpandedSize.h);
                const newLeft = Math.max(0, Math.min(curLeft, maxLeft));
                const newTop = Math.max(0, Math.min(curTop, maxTop));
                if (newLeft !== curLeft) container.style.left = newLeft + 'px';
                if (newTop !== curTop) container.style.top = newTop + 'px';
            }
        }
    });

    document.getElementById('gmt-language').addEventListener('change', (e) => {
        currentLanguage = e.target.value;
        // If captions are already on (i.e. we're recording), switch language immediately
        if (isRecording) {
            setCaptionLanguage();
        }
    });

    document.getElementById('gmt-record-btn').addEventListener('click', () => {
        if (!isRecording) {
            if (!isMeetingActive()) {
                return;
            }
            startRecording();
        } else {
            stopRecording();
        }
    });

    document.getElementById('gmt-save-btn').addEventListener('click', () => {
        chrome.runtime.sendMessage({
            action: 'saveTranscript',
            meetingTitle: getMeetingTitle(),
            participants: getParticipants(),
            language: currentLanguage
        });
        if (isRecording) {
            stopRecording();
        }
    });

    // Freeform notes, timestamped and marked up the same way as the desktop
    // app's Live/Record notes ("[time] Note:") so a shared summarizer prompt
    // can recognize either. See background.js's 'addNote' handler.
    document.getElementById('gmt-notes-input').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const input = e.target;
        const text = input.value.trim();
        if (!text) return;
        chrome.runtime.sendMessage({
            action: 'addNote',
            data: { time: new Date().toLocaleTimeString(), text }
        });
        input.value = '';
    });

    makeDraggable(container);
}

let gmtResizeHandler = null;

function makeDraggable(container) {
    const header = container.querySelector('.gmt-header');
    let offsetX, offsetY;
    let activePointerId = null;

    function clampPosition(left, top) {
        const w = container.offsetWidth;
        const h = container.offsetHeight;
        return {
            left: Math.max(0, Math.min(left, window.innerWidth - w)),
            top: Math.max(0, Math.min(top, window.innerHeight - h)),
        };
    }

    function onPointerMove(e) {
        if (e.pointerId !== activePointerId) return;
        const { left, top } = clampPosition(e.clientX - offsetX, e.clientY - offsetY);
        container.style.left = left + 'px';
        container.style.top = top + 'px';
    }

    function endDrag(e) {
        if (e && e.pointerId !== activePointerId) return;
        activePointerId = null;
        container.classList.remove('gmt-dragging');
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', endDrag);
        document.removeEventListener('pointercancel', endDrag);
    }

    header.addEventListener('pointerdown', (e) => {
        if (e.target.closest('#gmt-toggle-collapse')) return;
        if (e.target.closest('#gmt-theme-toggle')) return;
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();

        const rect = container.getBoundingClientRect();
        // Switch from bottom/right to top/left anchoring
        container.style.bottom = 'auto';
        container.style.right = 'auto';
        container.style.left = rect.left + 'px';
        container.style.top = rect.top + 'px';

        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        activePointerId = e.pointerId;

        container.classList.add('gmt-dragging');
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', endDrag);
        document.addEventListener('pointercancel', endDrag);
    });

    // Only register one window resize listener across re-injections.
    if (gmtResizeHandler) window.removeEventListener('resize', gmtResizeHandler);
    gmtResizeHandler = () => {
        if (!container.style.left) return;
        const left = parseFloat(container.style.left) || 0;
        const top = parseFloat(container.style.top) || 0;
        const { left: cl, top: ct } = clampPosition(left, top);
        container.style.left = cl + 'px';
        container.style.top = ct + 'px';
    };
    window.addEventListener('resize', gmtResizeHandler);
}

function updateRecordButtonUI(recording) {
    const playIcon = document.getElementById('gmt-icon-play');
    const stopIcon = document.getElementById('gmt-icon-stop');
    const langSelect = document.getElementById('gmt-language');
    const btn = document.getElementById('gmt-record-btn');
    const notesInput = document.getElementById('gmt-notes-input');

    if (recording) {
        playIcon.style.display = 'none';
        stopIcon.style.display = 'block';
        btn.title = "Stop Recording";
    } else {
        playIcon.style.display = 'block';
        stopIcon.style.display = 'none';
        btn.title = "Start Recording";
    }
    // Notes only make sense once there's a transcript running to align them to.
    notesInput.disabled = !recording;
}

function getMeetingTitle() {
    // 1. Try to get it from the DOM element that typically holds it (data attribute)
    const titleElement = document.querySelector('[data-meeting-title]');
    if (titleElement && titleElement.getAttribute('data-meeting-title')) {
        return titleElement.getAttribute('data-meeting-title');
    }

    // 2. Try another common selector (the one on the bottom left details)
    const bottomTitle = document.querySelector('.u9U8id, .Z67Sbc');
    if (bottomTitle && bottomTitle.innerText) {
        const text = bottomTitle.innerText.trim();
        if (text && text.length > 0) return text;
    }

    // 3. Fallback to document title, stripping " - Google Meet"
    let docTitle = document.title;
    if (docTitle.includes(' - Google Meet')) {
        docTitle = docTitle.replace(' - Google Meet', '');
    }
    if (docTitle === 'Google Meet' || docTitle === 'Meet' || !docTitle) {
        return 'Untitled Meeting';
    }
    return docTitle;
}

function getParticipants() {
    const participants = new Set();

    // 1. Primary source: speakers collected from the live transcript
    knownSpeakers.forEach(s => participants.add(s));

    // 2. Try DOM: elements with data-self-name or data-participant-id
    const dataParticipantElements = document.querySelectorAll('[data-self-name], [data-participant-id]');
    dataParticipantElements.forEach(el => {
        const raw = el.getAttribute('data-self-name') || el.innerText.trim();
        const name = cleanSpeakerName(raw);
        if (name && name.length > 1 && name.length < 50) {
            participants.add(name);
        }
    });

    // 3. Try DOM: participant names in video tiles (aria-label on participant containers)
    const tileNames = document.querySelectorAll('[data-requested-participant-id], [data-sender-name]');
    tileNames.forEach(el => {
        const raw = el.getAttribute('data-sender-name') || el.getAttribute('aria-label') || '';
        const cleanName = cleanSpeakerName(raw);
        if (cleanName && cleanName.length > 1 && cleanName.length < 50) {
            participants.add(cleanName);
        }
    });

    // Filter out common UI strings, self-references, and icon names
    const filterOut = ['You', 'Вы', 'Meeting details', 'People', 'Chat', 'Activities', 'Host controls', 'Speaker',
        'Your Meet call is in another window', 'Admit', 'Admit all'];
    const result = Array.from(participants).filter(p => {
        if (filterOut.includes(p)) return false;
        if (UI_LIGATURES.some(icon => p === icon || p.startsWith(icon))) return false;
        if (/\([⌘⌥⇧]/.test(p)) return false;
        if (/^summarize_auto/i.test(p)) return false;
        return true;
    });

    // Always use "You" as the canonical self-label regardless of caption language —
    // Meet itself emits "You" in DOM, so this keeps header and entries consistent
    // even if the user switches caption language mid-meeting.
    return ['You', ...result];
}

function isMeetingActive() {
    const leaveBtn = document.querySelector('button[aria-label*="Leave call"], button[aria-label*="Покинуть встречу"], button[aria-label*="Hang up"], [jsname="CQ01S"]');
    if (leaveBtn) return true;

    const hasCC = Array.from(document.querySelectorAll('button[aria-label]')).some(b => {
        const label = (b.getAttribute('aria-label') || '').toLowerCase();
        return label.includes('turn on captions') ||
            label.includes('turn off captions') ||
            label.includes('включить субтитры') ||
            label.includes('отключить субтитры');
    });

    return hasCC;
}

async function startRecording() {
    isRecording = true;
    updateRecordButtonUI(true);

    chrome.runtime.sendMessage({
        action: 'setMeetingTitle',
        meetingTitle: getMeetingTitle(),
        startedAt: new Date().toISOString()
    });

    const captionsReady = await enableCaptionsAndSetLanguage();
    if (!captionsReady) {
        isRecording = false;
        updateRecordButtonUI(false);
        console.warn("[GMT] Recording aborted: captions could not be activated.");
        return;
    }

    startObserver();

    // Periodically update participants while recording
    window.participantsInterval = setInterval(() => {
        if (isRecording) {
            chrome.runtime.sendMessage({
                action: 'updateParticipants',
                participants: getParticipants()
            });
        }
    }, 10000);
}

function stopRecording() {
    if (window.participantsInterval) {
        clearInterval(window.participantsInterval);
    }
    isRecording = false;
    updateRecordButtonUI(false);
    stopObserver();
}

let autoSaveTriggered = false;
function triggerAutoSave() {
    if (autoSaveTriggered) return;
    autoSaveTriggered = true;

    console.log("Triggering automatic save...");
    chrome.runtime.sendMessage({
        action: 'saveTranscript',
        meetingTitle: getMeetingTitle(),
        participants: getParticipants(),
        language: currentLanguage
    });

    if (isRecording) {
        stopRecording();
    }
}


// Strip annotation suffix added by Meet ("(Presenting)", "(Presenting, annotating)")
// and trim — used so the same speaker doesn't fork into multiple participants.
function cleanSpeakerName(name) {
    if (!name) return name;
    const stripped = String(name).replace(/\s*\([^)]*\)\s*$/, '').trim();
    return stripped || String(name).trim();
}

// Helper for delays
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(selector, { timeout = 1500, interval = 50 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const el = document.querySelector(selector);
        if (el) return el;
        await sleep(interval);
    }
    return null;
}

// Map our language codes to what Google Meet shows in the "Meeting language" listbox
const MEET_LANGUAGE_LABELS = {
    'ru': 'russian',
    'en': 'english',
    'sr': 'serbian'
};

async function enableCaptionsAndSetLanguage() {
    console.log("[GMT] Waiting for captions button, target language: " + currentLanguage);

    // Wait up to 8 s for the "Turn on captions" button to appear
    const turnOnBtn = await waitFor(
        'button[aria-label*="Turn on captions" i], button[aria-label*="Включить субтитры" i]',
        { timeout: 8000, interval: 300 }
    );
    if (turnOnBtn) {
        turnOnBtn.click();
        // Confirm captions activated (button label flips to "Turn off")
        const confirmed = await waitFor(
            'button[aria-label*="Turn off captions" i], button[aria-label*="Отключить субтитры" i]',
            { timeout: 3000, interval: 200 }
        );
        if (!confirmed) {
            console.warn("[GMT] Captions did not activate after click.");
            return false;
        }
        await sleep(500); // let the captions overlay fully mount
    } else {
        // Captions may already be on
        const alreadyOn = document.querySelector(
            'button[aria-label*="Turn off captions" i], button[aria-label*="Отключить субтитры" i]'
        );
        if (!alreadyOn) {
            console.warn("[GMT] Captions button not found within timeout.");
            return false;
        }
    }

    await setCaptionLanguage();
    return true;
}

async function setCaptionLanguage() {
    const target = MEET_LANGUAGE_LABELS[currentLanguage];
    if (!target) {
        console.warn("[GMT] No language mapping for: " + currentLanguage);
        return;
    }

    // The caption hover tray has a combobox: DIV[role="combobox"][aria-label="Meeting language"]
    // and a listbox: UL[role="listbox"][aria-label="Meeting language"] with LI[role="option"] items.
    let combobox = document.querySelector('[role="combobox"][aria-label="Meeting language"]');
    if (!combobox) {
        // Tray not open — try clicking the caption settings/options button to reveal it
        const settingsBtn = document.querySelector(
            'button[aria-label*="caption" i][aria-label*="setting" i], ' +
            'button[aria-label*="More caption" i], ' +
            'button[aria-label*="Caption setting" i], ' +
            'button[aria-label*="Настройки субтитр" i]'
        );
        if (settingsBtn) {
            settingsBtn.click();
            combobox = await waitFor('[role="combobox"][aria-label="Meeting language"]', { timeout: 1500 });
        }
    }
    if (!combobox) {
        console.warn("[GMT] Meeting language combobox not found. Caption tray may not be visible.");
        return;
    }

    // Click the combobox to expand the listbox
    combobox.click();
    await sleep(400);

    // Find the matching option in the listbox
    const listbox = document.querySelector('[role="listbox"][aria-label="Meeting language"]');
    if (!listbox) {
        console.warn("[GMT] Meeting language listbox not found after clicking combobox.");
        return;
    }

    const options = listbox.querySelectorAll('[role="option"]');
    let matched = null;
    for (const opt of options) {
        const text = (opt.innerText || opt.textContent || '').trim().toLowerCase();
        if (text.includes(target)) {
            matched = opt;
            break;
        }
    }

    if (matched) {
        matched.click();
        console.log("[GMT] Language set to: " + matched.innerText.trim());
        await sleep(300);
    } else {
        console.warn("[GMT] Could not find option matching '" + target + "' in listbox.");
        // Close the dropdown by clicking the combobox again
        combobox.click();
    }
}

// Keep track of the last processed text to avoid duplicates
let lastText = "";
let lastSpeaker = "";

// Material Design icon names that appear as text nodes in the Meet DOM
const UI_LIGATURES = [
    'more_vert', 'chevron_right', 'person_add', 'keyboard_arrow_down', 'domain_disabled',
    'frame_person', 'visual_effects', 'devices', 'close', 'add_reaction', 'mic', 'videocam',
    'computer_arrow_up', 'mood', 'closed_caption_off', 'back_hand', 'call_end', 'info',
    'chat', 'apps', 'lock_person',
    // Additional icons found in transcripts
    'keep_outline', 'keep', 'keep_off', 'mic_none', 'mic_off', 'warning_amber', 'present_to_all',
    'zoom_in', 'open_in_new', 'open_in_full', 'group',
    // Screen share / annotation toolbar icons
    'volume_off', 'remove_circle_outline', 'draw', 'swap_vert', 'front_hand', 'arrow_drop_up',
    'sticker', 'ink_pen', 'text_fields', 'sticky_note', 'shapes', 'rectangle', 'pen_size_2',
    'line_end_arrow_notch', 'ink_eraser', 'exit_to_app',
    // Video tile / framing notifications
    'aspect_ratio'
];

function startObserver() {
    if (observer) return;

    // Meet usually puts captions in a container that is added dynamically.
    // We observe the body for additions of new text nodes.
    const targetNode = document.body;
    const config = { childList: true, subtree: true, characterData: true };

    observer = new MutationObserver((mutationsList, obs) => {
        // Monitor for meeting end indicators
        monitorMeetingEnd();

        for (let mutation of mutationsList) {

            // We look for elements that look like subtitles.
            // In Google Meet, subtitle text spans often have specific classes, but
            // deeply nested inside recognizable containers.
            // A common heuristic: look for images with attribute "Google user" (the avatar of speaker) 
            // and the text next to it.

            // For a robust start, we'll watch for added nodes that contain text and might be captions.
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        extractSubtitleFromNode(node);
                    }
                });
            } else if (mutation.type === 'characterData') {
                extractSubtitleFromNode(mutation.target.parentNode);
            }
        }
    });

    observer.observe(targetNode, config);
    console.log("GMT Observer started");
}

function extractSubtitleFromNode(node) {
    if (!node) return;

    // Filter out obvious UI elements
    let currentElement = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!currentElement) return;

    // Extremely aggressive UI filtering for the Captions header specifically
    const isUIElement = currentElement.closest('button') ||
        currentElement.closest('nav') ||
        currentElement.closest('[role="button"]') ||
        currentElement.closest('[role="tooltip"]') ||
        currentElement.closest('[role="menu"]') ||
        currentElement.closest('[role="dialog"]') ||
        currentElement.closest('[role="alert"]') ||
        currentElement.closest('header') ||
        currentElement.closest('style') ||
        currentElement.closest('script');

    if (isUIElement) return;

    // Google Meet's actual transcript chunks are often in a container with 'data-sender-name'
    const senderBlock = currentElement.closest('[data-sender-name]');

    let speaker = "Speaker";
    let text = "";

    if (senderBlock) {
        speaker = senderBlock.getAttribute('data-sender-name') || "Speaker";
        text = senderBlock.innerText ? senderBlock.innerText.trim() : "";

        if (text.startsWith(speaker)) {
            text = text.substring(speaker.length).trim();
        } else if (speaker === "You" || speaker === "Вы") {
            // Localization fallback for the current user
            if (text.startsWith("You")) text = text.substring(3).trim();
            if (text.startsWith("Вы")) text = text.substring(2).trim();
        }
    } else {
        // Fallback when data-sender-name is missing.
        let targetElement = currentElement;
        let textContent = targetElement.innerText ? targetElement.innerText.trim() : "";

        if (!textContent || textContent.length < 2) return;

        let foundSpeaker = null;
        let p = targetElement;

        while (p && p.tagName !== 'BODY') {
            let pText = p.innerText ? p.innerText.trim() : "";
            if (pText.includes('\n')) {
                let parts = pText.split('\n');
                if (parts.length <= 6) { // reasonably small wrapper
                    let possibleSpeaker = parts[0].trim();
                    let isPossibleSpeaker = possibleSpeaker.length > 0 &&
                        possibleSpeaker.length < 40 &&
                        !possibleSpeaker.includes("Turn off") &&
                        !possibleSpeaker.includes("Video settings") &&
                        !possibleSpeaker.includes("More emojis") &&
                        !possibleSpeaker.includes("Leave call") &&
                        !possibleSpeaker.includes("Meeting details");
                    if (isPossibleSpeaker) {
                        foundSpeaker = possibleSpeaker;
                        // Sometimes the text spans themselves contain the speaker
                        if (textContent.startsWith(foundSpeaker + '\n')) {
                            textContent = textContent.substring(foundSpeaker.length).trim();
                        }
                        break;
                    }
                } else {
                    // It's a huge block (like the main captions tray)
                    break;
                }
            }
            p = p.parentElement;
        }

        if (foundSpeaker) {
            speaker = foundSpeaker;
            text = textContent;
        } else {
            text = textContent;
            speaker = lastSpeaker || "Speaker";
        }
    }

    if (!text || text.length < 2) return;

    const settingsLeakage = ['Russian', 'English', 'closed_caption', 'Live captions', 'format_size', 'Font size', 'circle', 'Font color', 'settings', 'Open caption settings', 'language', 'close'];
    const textWords = text.split(/\s+/);
    if (textWords.every(w => settingsLeakage.includes(w))) {
        return;
    }

    // Heavy lobbys/pre-call UI blocks and Meet system messages
    const preCallUI = [
        "Audio settings", "Turn off microphone", "Turn off camera", "Video settings", "Share screen", "Send a reaction",
        "Turn on captions", "Raise hand", "More options", "Leave call", "Meeting details",
        "Chat with everyone", "Meeting tools", "Host controls", "You’re continuously framed",
        "Press Down Arrow to open", "Developing an extension for Meet", "This call is open to anyone",
        "Others might still see your full video", "More emojis",
        // Picture-in-picture system notification
        "Your Meet call is in another window", "Using picture-in-picture", "Bring the call back here",
        // Participant panel UI
        "WAITING TO JOIN", "IN THE MEETING", "Add people", "Admit all", "Admit",
        "Waiting to be admitted", "Mute this participant", "Mute",
        // Permission / status messages
        "You can’t unmute someone else", "You can’t turn on the mic here",
        "This person isn’t signed in",
        // Caption settings panel
        "Turn on microphone", "Font color", "Font size",
        // Annotation / screen share toolbar
        "Presentation is starting", "Presentation audio",
        "Annotate in the Meet tab", "Everyone can see your annotations",
        "Scroll & zoom your presentation in Meet", "Enter Full Screen",
        "Stop annotating", "Let others annotate",
        "to your main screen",
        "presenting, annotating",
        // Video tile framing / meeting state
        "Others might see more of your background", "Click to view your full video",
        "No one else is in this meeting",
        // Background effects panel and raise-hand toast
        "Backgrounds and effects",
        "It sounds like you've said something",
        "Keep it raised",
        "your hand will be lowered",
        // Pin/layout toolbar
        "Pin to your main screen", "Open captions panel"
    ];
    let isPreCall = false;
    for (const str of preCallUI) {
        if (text.includes(str) || speaker.includes(str)) {
            isPreCall = true;
            break;
        }
    }
    if (isPreCall) return;

    // Caption-tray participant counter chip ("4 others", "12 others")
    if (/^\d+\s+others?$/i.test(text.trim())) return;

    if (text.includes("Open caption settings")) {
        const parts = text.split("Open caption settings");
        text = parts[parts.length - 1].trim();

        if (text.includes('\n')) {
            const subParts = text.split('\n');
            if (subParts[0].length < 30) {
                speaker = subParts[0].trim();
                text = subParts.slice(1).join(' ').trim();
            }
        }
    }

    // Explicitly block UI words from becoming the speaker name
    if (settingsLeakage.includes(speaker.trim()) || UI_LIGATURES.includes(speaker.trim()) || speaker.trim() === "Speaker") {
        return;
    }

    // The "Summarize captions" caption-bar button appears in DOM as a pseudo-speaker
    // named summarize_auto_<n> emitting the text "Summarize captions" plus a "Close" icon.
    if (/^summarize_auto/i.test(speaker.trim())) return;
    const trimmedTextForUi = text.trim();
    if (trimmedTextForUi === 'Summarize captions' || trimmedTextForUi === 'Close' || trimmedTextForUi === 'close') return;

    // Exact match ligature or starts-with (icon name concatenated with tooltip text)
    if (UI_LIGATURES.includes(text.trim())) return;
    if (UI_LIGATURES.some(icon => text.startsWith(icon))) return;

    // Keyboard shortcut hints (e.g. "Turn on microphone (⌘ + d)")
    if (/\([⌘⌥⇧]/.test(text) || /\(ctrl\s*\+/i.test(text)) return;

    // CSS leaked from annotation toolbar <style> elements (fallback for innerText captures)
    if (/[a-z-]+\s*:\s*[^;\n]+;/.test(text) && text.includes('{')) return;

    if (text === speaker || text.length < 2) return;

    // Drop presence/tile overlays: a caption whose entire text is just a participant's
    // name (e.g. someone joined, their name flashed in a tile, and we picked it up).
    // Restricted to "pure name" shapes — letters/spaces/dashes/apostrophes, no
    // terminal punctuation — so real utterances like "Yes, Boris." aren't dropped.
    const trimmedText = text.trim();
    if (/^[\p{L}][\p{L}\-' ]{1,49}$/u.test(trimmedText)) {
        const named = cleanSpeakerName(trimmedText);
        if (named && knownSpeakers.has(named)) return;
        const domNameEls = document.querySelectorAll('[data-sender-name], [data-self-name]');
        for (const el of domNameEls) {
            const n = cleanSpeakerName(el.getAttribute('data-sender-name') || el.getAttribute('data-self-name') || '');
            if (n && n === named) return;
        }
    }

    processSubtitle(speaker, text);
}

let lastUpdateTime = 0;

// Jaccard word-level similarity (0..1) — used to detect STT corrections
function wordSimilarity(a, b) {
    const clean = str => str.replace(/[^\p{L}\p{N}\s]/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const wA = new Set(clean(a).split(' ').filter(Boolean));
    const wB = new Set(clean(b).split(' ').filter(Boolean));
    if (!wA.size || !wB.size) return 0;
    let inter = 0;
    for (const w of wA) if (wB.has(w)) inter++;
    return inter / (wA.size + wB.size - inter);
}

function mergeText(oldText, newText) {
    if (!oldText) return newText;
    if (!newText) return oldText;

    // strip all punctuation and normalize for comparison
    const clean = str => str.replace(/[^\p{L}\p{N}\s]/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const cOld = clean(oldText);
    const cNew = clean(newText);

    if (cOld === cNew) return oldText;
    if (cOld.includes(cNew)) return oldText;
    if (cNew.includes(cOld)) return newText;

    // Find overlap down to the word level
    const oldWords = oldText.split(/\s+/);
    const newWords = newText.split(/\s+/);

    const cOldWords = cOld.split(' ');
    const cNewWords = cNew.split(' ');

    let maxOverlap = 0;
    let limit = Math.min(cOldWords.length, cNewWords.length);

    // Allow overlapping up to roughly a full sentence to prevent duplication
    for (let i = 1; i <= Math.min(limit, 30); i++) {
        let overlapOld = cOldWords.slice(cOldWords.length - i).join(' ');
        let overlapNew = cNewWords.slice(0, i).join(' ');
        if (overlapOld === overlapNew) {
            maxOverlap = i;
        }
    }

    if (maxOverlap > 0) {
        let remainingNewWords = newWords.slice(maxOverlap);
        return oldText + " " + remainingNewWords.join(" ");
    }

    // Detect real-time speech recognition corrections:
    // If the old and new text share a significant common prefix (≥50% of words),
    // the new text is likely a correction/refinement — keep the newer version.
    let commonPrefixLen = 0;
    for (let i = 0; i < limit; i++) {
        if (cOldWords[i] === cNewWords[i]) {
            commonPrefixLen++;
        } else {
            break;
        }
    }

    if (commonPrefixLen >= Math.max(cOldWords.length, cNewWords.length) * 0.5) {
        // It's a real-time correction — return the newer (latest) version
        return newText;
    }

    return null;
}

function processSubtitle(speaker, text) {
    text = text.trim();
    if (text.length <= 3) return;

    // Normalize speaker: strip "(Presenting)"-style suffixes and unify self-label.
    speaker = cleanSpeakerName(speaker);
    if (speaker === 'Вы') speaker = 'You';

    // Track speaker for participant list
    if (speaker && speaker !== 'Speaker') {
        knownSpeakers.add(speaker);
    }

    let isSameSpeaker = (speaker === lastSpeaker);
    if (!isSameSpeaker) {
        if (lastSpeaker && speaker.startsWith(lastSpeaker) && speaker.length < lastSpeaker.length + 15) {
            isSameSpeaker = true;
            speaker = lastSpeaker; // Normalize to the original
        } else if (lastSpeaker && lastSpeaker.startsWith(speaker) && lastSpeaker.length < speaker.length + 15) {
            isSameSpeaker = true;
        }
    }

    if (isSameSpeaker && lastText) {
        // Safe string stitching without losing data
        let merged = mergeText(lastText, text);
        if (merged) {
            if (merged === lastText) return; // exact duplicate, do nothing

            lastText = merged;
            lastSpeaker = speaker;
            lastUpdateTime = Date.now();
            chrome.runtime.sendMessage({
                action: 'updateLastTranscript',
                data: {
                    time: new Date().toLocaleTimeString(),
                    speaker: speaker,
                    text: merged
                }
            });
            return;
        }
        // If same speaker but no overlap, check similarity — ≥70% means STT correction
        if (wordSimilarity(lastText, text) >= 0.7) {
            lastText = text;
            lastSpeaker = speaker;
            lastUpdateTime = Date.now();
            chrome.runtime.sendMessage({
                action: 'updateLastTranscript',
                data: {
                    time: new Date().toLocaleTimeString(),
                    speaker: speaker,
                    text: text
                }
            });
            return;
        }
        // Otherwise truly different utterance — append as new line,
        // unless both reps are short backchannels emitted within ~5s of each other.
        if (text.length <= 20 && lastText.length <= 30 && Date.now() - lastUpdateTime <= 5000) {
            const merged = lastText + ", " + text;
            lastText = merged;
            lastSpeaker = speaker;
            lastUpdateTime = Date.now();
            chrome.runtime.sendMessage({
                action: 'updateLastTranscript',
                data: {
                    time: new Date().toLocaleTimeString(),
                    speaker: speaker,
                    text: merged
                }
            });
            return;
        }
    }

    lastText = text;
    lastSpeaker = speaker;
    lastUpdateTime = Date.now();

    chrome.runtime.sendMessage({
        action: 'addTranscript',
        data: {
            time: new Date().toLocaleTimeString(),
            speaker: speaker,
            text: text
        }
    });
}



function stopObserver() {
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    console.log("Observer stopped");
}

function monitorMeetingEnd() {
    if (!isRecording || autoSaveTriggered) return;

    // 1. Check for the leave button and attach listener
    const leaveBtn = document.querySelector('button[aria-label*="Leave call"], button[aria-label*="Покинуть встречу"], button[aria-label*="Hang up"], [jsname="CQ01S"]');
    if (leaveBtn && !leaveBtn.dataset.gmtListener) {
        leaveBtn.dataset.gmtListener = 'true';
        leaveBtn.addEventListener('click', () => {
            console.log("Leave button clicked.");
            // Delay slightly to allow any final captions to be processed
            setTimeout(triggerAutoSave, 500);
        });
    }

    // 2. Check for "Meeting ended" UI indicators in the DOM
    // These often appear in specific containers or as large text
    const endIndicators = [
        'You left the meeting',
        'Вы покинули встречу',
        'The meeting has ended',
        'Встреча завершена',
        'Return to home screen',
        'Вернуться на главный экран'
    ];

    // We only check a subset of the body to avoid performance issues, 
    // but innerText on body is usually fast enough for these small intervals
    const bodyText = document.body.innerText;
    if (endIndicators.some(indicator => bodyText.includes(indicator))) {
        console.log("Meeting end UI detected.");
        triggerAutoSave();
    }
}
