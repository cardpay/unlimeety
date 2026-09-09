'use strict';
// node test/calendar-prefill.test.js
//
// The "From calendar" prefill used to go stale: the picker pre-selected the
// OLDEST event in its window when nothing was ongoing (its fallback was index
// 0, and the window reaches two hours back), and once a title had been filled
// in, nothing ever re-read the calendar — the field kept a finished meeting's
// name until the app restarted, so the auto-record prompt and the next
// recording both inherited it.
//
// calendar-picker.js is a classic <script> IIFE, so it is loaded here the way
// the browser loads it, against a DOM stub thin enough to get through
// injectStyles().

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'calendar-picker.js'), 'utf-8');
const LIVE_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'live', 'live.js'), 'utf-8');

const iso = (minutesFromNow) => new Date(Date.now() + minutesFromNow * 60000).toISOString();
const ev = (title, fromMin, toMin, participants = []) =>
    ({ title, start: iso(fromMin), end: iso(toMin), participants });

// Loads the picker with `events` behind window.calendar.list(). `asked`
// collects the options it queried with; `events` as a function stands in for a
// calendar that cannot be read (it is called instead of returning a list).
// `out.body` comes back as the document-body stub, so a test can reach the
// popover the picker appends to it and read what got rendered.
function load(events, asked = [], out = {}) {
    // Enough of an element to get through injectStyles() and renderEvents():
    // children are recorded, and assigning innerHTML wipes them the way the
    // real one does — that is how the picker clears "Loading…".
    const el = () => ({
        style: {}, className: '', textContent: '', children: [], _html: '',
        set innerHTML(v) { this._html = v; this.children.length = 0; },
        get innerHTML() { return this._html; },
        appendChild(c) { this.children.push(c); return c; },
        addEventListener() {}, removeEventListener() {},
        querySelector: () => el(), remove() {}, contains: () => false,
    });
    const body = el();
    out.body = body;
    const sandbox = {
        console,
        document: {
            createElement: el, head: el(), body,
            addEventListener() {}, removeEventListener() {},
        },
    };
    sandbox.window = sandbox;
    sandbox.calendar = {
        platformOK: async () => true,
        list: async (opts) => {
            asked.push(opts);
            if (typeof events === 'function') return events();
            return { ok: true, events };
        },
    };
    vm.runInNewContext(SRC, sandbox, { filename: 'renderer/calendar-picker.js' });
    return sandbox.calendarPicker;
}

function loadAutoStartHandler(calPrefill) {
    const start = LIVE_SRC.indexOf('    live.onAutoStart?.(');
    const end = LIVE_SRC.indexOf('\n\n    // ─── Stop → save', start);
    assert.notStrictEqual(start, -1, 'live auto-start handler not found');
    assert.notStrictEqual(end, -1, 'live auto-start handler end not found');
    const region = LIVE_SRC.slice(start, end);
    let handler;
    let clicked = false;
    new Function('live', 'document', 'calPrefill', region)(
        { onAutoStart: (callback) => { handler = callback; } },
        { querySelector: () => ({ click: () => { clicked = true; } }) },
        calPrefill,
    );
    assert.strictEqual(typeof handler, 'function', 'live auto-start callback must be registered');
    return { handler, wasClicked: () => clicked };
}

// Run the actual lifecycle callbacks together: popup acceptance clicks the
// actual tab handler, and a successful stop/save sets the completion boundary.
// Only DOM painting and the audio/filesystem bridges are stubbed.
function loadLiveLifecycle(events = [], { calendarAvailable = true } = {}) {
    const region = (from, to) => {
        const start = LIVE_SRC.indexOf(from);
        const end = LIVE_SRC.indexOf(to, start);
        assert(start >= 0 && end > start, `Live lifecycle region missing: ${from}`);
        return LIVE_SRC.slice(start, end);
    };
    const element = () => {
        const classes = new Set();
        const listeners = {};
        const label = {};
        return {
            value: '', style: {}, dataset: {},
            classList: {
                add: (c) => classes.add(c), remove: (c) => classes.delete(c),
                contains: (c) => classes.has(c),
            },
            addEventListener: (type, callback) => { listeners[type] = callback; },
            click: () => listeners.click?.(),
            querySelector: () => label, querySelectorAll: () => [],
        };
    };
    const box = {
        console, Date,
        state: {
            running: false, finished: false, stopping: false, crashed: null,
            finalizedSegments: [], activePartials: new Map(),
            calendarParticipants: [], speakerNames: {}, currentLanguage: 'en',
        },
        diarizationWarningShown: false, streamEmpty: null,
        srcMicCheck: { checked: true }, srcSystemCheck: { checked: false },
        configureLanes() {}, setStatus() {}, showSetupError() {},
        startTimer() {}, startMeterPulse() {}, stopTimer() {}, stopMeterPulse() {},
        refreshMicStatus() {}, setLevelMeter() {}, updateAskAiAvailability() {},
        updateLiveRecordingIndicator() {}, switchTab() {}, defaultTitle: () => 'Timestamp fallback',
        CustomEvent: function (type, options) { Object.assign(this, { type }, options); },
        started: [], saved: [], saveResult: { ok: true, filePath: '/synthetic/transcript.txt' },
    };
    for (const key of ['titleInput', 'setupSection', 'recordingSection', 'setupError',
        'startBtn', 'stopBtn', 'discardBtn', 'streamEl', 'downloadBox', 'progressBar', 'timerEl']) {
        box[key] = element();
    }
    const liveButton = element();
    liveButton.dataset.tab = 'live';
    box.tabButtons = [liveButton];
    box.document = { querySelector: () => liveButton, dispatchEvent() {} };
    box.$ = element;
    box.live = {
        start: async (config) => { box.started.push(config); return { ok: true }; },
        stop: async () => ({ ok: true }),
        saveTranscript: async (payload) => { box.saved.push(payload); return box.saveResult; },
        onAutoStart: (callback) => { box.popup = callback; },
    };
    box.window = { calendarPicker: calendarAvailable ? load(events) : undefined };
    vm.runInNewContext([
        region('    function applyCalendarPick(', '    // ─── Model picker'),
        region("    tabButtons.forEach(btn => btn.addEventListener('click'", '    // Toolbar pill:'),
        region("    startBtn.addEventListener('click'", '    // Re-shows the floating notes window'),
        region('    function returnToSetup()', '    // ─── Ask AI'),
        'this.prefill = calPrefill;',
    ].join('\n'), box, { filename: 'renderer/live/live.js lifecycle' });
    box.visit = () => liveButton.click();
    return box;
}

const settle = () => new Promise(setImmediate);

async function completedSession(box, route = 'picker', title = 'Previous review') {
    const pick = { title, participants: ['previous@example.com'] };
    if (route === 'manual') {
        box.titleInput.value = title;
        box.state.calendarParticipants = pick.participants;
    } else if (route === 'automatic') box.prefill.put(pick);
    else box.window.liveTab.applyCalendarPick(pick); // picker and smart banner share this sink
    box.state.speakerNames = { S1: 'Previous speaker' };
    await box.startBtn.click();
    assert.strictEqual(box.titleInput.value, title, 'starting capture preserves setup metadata');
    await box.stopBtn.click();
    assert.strictEqual(box.state.finished, true, 'successful save marks the actual session complete');
    assert.strictEqual(box.saved[0].title, title);
}

// ─── which event counts as "current" ────────────────────────────────────────
{
    const { currentEvent } = load([]);

    const past = ev('Standup', -90, -60);
    const ongoing = ev('Retro', -10, 20);
    const soon = ev('1-1', 10, 40);
    const later = ev('Planning', 300, 360);
    const allDay = ev('PTO', -400, 1000);

    // The regression: a window holding only finished meetings pre-selected the
    // oldest one. Nothing is current now.
    assert.strictEqual(currentEvent([past, ev('Sync', -50, -40)]), null);
    assert.strictEqual(currentEvent([]), null);

    assert.strictEqual(currentEvent([past, ongoing, soon]), ongoing);
    assert.strictEqual(currentEvent([past, soon, later]), soon, 'nearest upcoming inside the cap');
    assert.strictEqual(currentEvent([past, later]), null, 'five hours out is not "current"');
    // An all-day entry is ongoing all day long and must not outrank the meeting.
    assert.strictEqual(currentEvent([allDay, soon]), soon);
    assert.strictEqual(currentEvent([allDay]), null);
    // Garbage dates are skipped, not picked.
    assert.strictEqual(currentEvent([{ title: 'x', start: 'nope', end: 'nope' }]), null);
    // Overlapping meetings: the shortest one is the one being recorded — a
    // 4-hour focus block is "ongoing" across the call inside it.
    const block = ev('Focus block', -120, 120);
    assert.strictEqual(currentEvent([block, ongoing]), ongoing);
    assert.strictEqual(currentEvent([ongoing, block]), ongoing, 'not just the first match');
    // A nameless event can prefill nothing, so it is not the pick either.
    assert.strictEqual(currentEvent([ev('', -10, 20)]), null);
    assert.strictEqual(currentEvent([ev('  ', -10, 20), soon]), soon);

    // Overrun grace: a meeting that ran past its scheduled end still counts as
    // "the one that was on" for a while, so the title survives between the
    // overrun and pressing Start.
    const justEnded = ev('Daily Sync', -35, -5); // ended 5 min ago
    assert.strictEqual(currentEvent([justEnded]), justEnded,
        'a meeting that ended 5 min ago is still within the overrun grace window');
    assert.strictEqual(currentEvent([past]), null,
        'past ended 60 min ago — well outside the grace window, unchanged from before');
    // Ranked below both a truly ongoing event and an upcoming one inside the
    // cap — a back-to-back next meeting, or one still running, must win.
    assert.strictEqual(currentEvent([justEnded, soon]), soon,
        'an upcoming meeting inside the cap outranks one that just ended');
    assert.strictEqual(currentEvent([justEnded, ongoing]), ongoing,
        'a truly ongoing meeting outranks one that just ended');
    // Among several that ended within the grace window, the most recent wins.
    const endedEarlier = ev('Earlier', -60, -12);
    assert.strictEqual(currentEvent([endedEarlier, justEnded]), justEnded,
        'the more recently ended meeting is the better guess, same spirit as ongoing\'s shortest-wins');
}

// ─── autoPrefill: refresh replaces its own value, never the user's ──────────
(async () => {
    // Completed direct picks used to remain protected for the renderer lifetime.
    // Exercise the real save -> tab re-entry -> popup chain before unit cases.
    for (const route of ['picker', 'manual', 'automatic']) {
        const box = loadLiveLifecycle([ev('Refresh candidate', -5, 20, ['refresh@example.com'])]);
        await completedSession(box, route);
        box.popup({ title: 'Current review', participants: ['current@example.com'] });
        assert.strictEqual(box.titleInput.value, 'Current review', `${route}: popup replaces the completed session title`);
        assert.deepEqual([...box.state.calendarParticipants], ['current@example.com']);
        assert.deepEqual(Object.keys(box.state.speakerNames), []);
        await settle();
        assert.strictEqual(box.titleInput.value, 'Current review', 'tab refresh cannot supersede popup metadata');
        assert.deepEqual([...box.state.calendarParticipants], ['current@example.com']);
        if (route === 'picker') {
            await box.startBtn.click();
            assert.strictEqual(box.started[1].title, 'Current review', 'second capture uses the current popup title');
            await box.stopBtn.click();
            assert.strictEqual(box.saved[1].title, 'Current review');
            assert.deepEqual([...box.saved[1].calendarParticipants], ['current@example.com']);
            assert.deepEqual(Object.keys(box.saved[1].speakerNames), [], 'second save has no previous speaker overrides');
        }
    }

    {
        const box = loadLiveLifecycle([], { calendarAvailable: false });
        await completedSession(box, 'manual');
        box.discardBtn.click();
        assert.strictEqual(box.titleInput.value, '', 'fresh setup clears title without the optional calendar picker');
        assert.deepEqual([...box.state.calendarParticipants], [], 'participant cleanup does not require the calendar picker');
        assert.deepEqual(Object.keys(box.state.speakerNames), []);
    }

    {
        let resolveFresh;
        const box = loadLiveLifecycle(() => new Promise(resolve => { resolveFresh = resolve; }));
        await completedSession(box, 'automatic', 'Shared title');
        box.discardBtn.click();
        await settle();
        box.titleInput.value = 'Shared title';
        resolveFresh({ ok: true, events: [ev('Different suggestion', -5, 20)] });
        await settle();
        assert.strictEqual(box.titleInput.value, 'Shared title', 'previous automatic ownership does not extend to a new manual title');
    }

    for (const participants of [['current@example.com'], []]) {
        const box = loadLiveLifecycle([ev('Weekly review', -5, 20, ['refresh@example.com'])]);
        await completedSession(box, 'picker', 'Weekly review');
        box.popup({ title: 'Weekly review', participants });
        await settle();
        assert.deepEqual([...box.state.calendarParticipants], participants, 'same-title popup replaces all attendees');
    }

    for (const outcome of [
        () => ({ ok: true, events: [] }),
        () => ({ ok: false, reason: 'calendar-permission' }),
        () => { throw new Error('Calendar unavailable'); },
    ]) {
        const box = loadLiveLifecycle(outcome);
        await completedSession(box, 'manual');
        box.discardBtn.click(); // actual New recording callback
        assert.strictEqual(box.titleInput.value, '', 'fresh setup clears previous manual input immediately');
        await settle();
        assert.strictEqual(box.titleInput.value, '', 'no event or failed query cannot restore previous metadata');
        assert.deepEqual([...box.state.calendarParticipants], []);
        assert.deepEqual(Object.keys(box.state.speakerNames), []);
        await box.startBtn.click();
        await box.stopBtn.click();
        assert.strictEqual(box.saved.at(-1).title, 'Timestamp fallback');
    }

    {
        const box = loadLiveLifecycle([ev('Fresh calendar review', -5, 20, ['fresh@example.com'])]);
        await completedSession(box, 'manual');
        box.discardBtn.click();
        await settle();
        assert.strictEqual(box.titleInput.value, 'Fresh calendar review');
        assert.deepEqual([...box.state.calendarParticipants], ['fresh@example.com']);
    }

    {
        let resolveOld;
        let calls = 0;
        const box = loadLiveLifecycle(() => ++calls === 1
            ? new Promise(resolve => { resolveOld = resolve; })
            : { ok: true, events: [] });
        box.visit();
        await settle();
        await completedSession(box);
        box.visit();
        await settle();
        resolveOld({ ok: true, events: [ev('Obsolete read', -5, 20, ['obsolete@example.com'])] });
        await settle();
        assert.strictEqual(box.titleInput.value, '', 'a pre-reset read cannot populate the fresh empty setup');
        assert.deepEqual([...box.state.calendarParticipants], []);
    }

    // Ordinary visits and popup arrivals preserve a current manual edit.
    {
        const box = loadLiveLifecycle([ev('Calendar suggestion', -5, 20)]);
        box.window.liveTab.applyCalendarPick({ title: 'Current manual edit', participants: ['draft@example.com'] });
        box.state.speakerNames = { S1: 'Draft speaker' };
        box.visit();
        box.popup({ title: 'Popup suggestion', participants: [] });
        await settle();
        assert.strictEqual(box.titleInput.value, 'Current manual edit');
        assert.deepEqual([...box.state.calendarParticipants], ['draft@example.com']);
        assert.strictEqual(box.state.speakerNames.S1, 'Draft speaker');
    }

    // Loading, active, saving, failed-save, and crash-recovery sessions all
    // retain metadata on the recording screen, even if it was auto-prefilled.
    for (const phase of ['loading', 'recording', 'saving', 'failed-save', 'crash-recovery']) {
        const box = loadLiveLifecycle([ev('Other calendar event', -5, 20)]);
        box.prefill.put({ title: 'Unsaved review', participants: ['unsaved@example.com'] });
        box.state.speakerNames = { S1: 'Unsaved speaker' };
        if (phase === 'loading') {
            let finishStart;
            box.live.start = () => new Promise(resolve => { finishStart = resolve; });
            const starting = box.startBtn.click();
            box.visit();
            box.popup({ title: 'Popup suggestion', participants: [] });
            finishStart({ ok: true });
            await starting;
        } else {
            await box.startBtn.click();
            if (phase === 'failed-save') {
                box.saveResult = { ok: false, error: 'Synthetic save failure' };
                await box.stopBtn.click();
            } else if (phase === 'crash-recovery') {
                box.state.running = false;
                box.state.crashed = 'Synthetic interruption';
            } else if (phase === 'saving') {
                let finishSave;
                box.live.saveTranscript = () => new Promise(resolve => { finishSave = resolve; });
                const saving = box.stopBtn.click();
                await settle();
                box.visit();
                box.popup({ title: 'Popup suggestion', participants: [] });
                finishSave({ ok: false });
                await saving;
            }
            box.visit();
            box.popup({ title: 'Popup suggestion', participants: [] });
        }
        await settle();
        assert.strictEqual(box.titleInput.value, 'Unsaved review', phase);
        assert.deepEqual([...box.state.calendarParticipants], ['unsaved@example.com'], phase);
        assert.strictEqual(box.state.speakerNames.S1, 'Unsaved speaker', phase);
    }

    {
        const box = loadLiveLifecycle([]);
        box.titleInput.value = 'Discarded review';
        box.state.calendarParticipants = ['discarded@example.com'];
        box.state.speakerNames = { S1: 'Discarded speaker' };
        box.setupSection.classList.add('hidden');
        box.state.crashed = 'Synthetic interruption';
        box.discardBtn.click();
        await settle();
        assert.strictEqual(box.titleInput.value, '', 'explicit discard starts a fresh session');
        assert.deepEqual([...box.state.calendarParticipants], []);
        assert.deepEqual(Object.keys(box.state.speakerNames), []);
    }

    // (a) fills in the ongoing meeting, attendees included, and asks the helper
    //     for one hour back rather than its own two-hour default — past meetings
    //     are listed to be looked at, not that many of them
    {
        const input = { value: '' };
        const picks = [];
        const asked = [];
        const p = load([ev('Retro', -10, 20, ['Ann', 'Bob'])], asked)
            .autoPrefill({ input, onPick: (pick) => { picks.push(pick); Object.assign(input, { value: pick.title }); } });
        await p.refresh();
        // Not deepStrictEqual: the pick is built inside the vm realm, so its
        // prototype is not this realm's Object.prototype.
        assert.strictEqual(picks.length, 1);
        assert.strictEqual(picks[0].title, 'Retro');
        assert.deepEqual([...picks[0].participants], ['Ann', 'Bob']);
        assert.strictEqual(asked.length, 1);
        assert.strictEqual(asked[0].windowBackMinutes, 60);
    }

    // (b) once that meeting is over, the next refresh clears what it wrote —
    //     this is the reported bug: the finished meeting used to stay put.
    {
        const input = { value: '' };
        // One long-lived prefill (as in the app) over a calendar that moves on.
        const events = [ev('Retro', -10, 20)];
        const p = load(events).autoPrefill({ input, onPick: (pick) => { input.value = pick.title; } });
        await p.refresh();
        assert.strictEqual(input.value, 'Retro');

        events.splice(0, events.length, ev('Retro', -120, -90));
        await p.refresh();
        assert.strictEqual(input.value, '', 'a meeting that ended must not stay pre-filled');
    }

    // (c) a hand-typed title is never touched
    {
        const input = { value: 'Договор с вендором' };
        const p = load([ev('Retro', -10, 20)])
            .autoPrefill({ input, onPick: (pick) => { input.value = pick.title; } });
        await p.refresh();
        p.put({ title: 'From the prompt' });
        assert.strictEqual(input.value, 'Договор с вендором');
    }

    // (d) main's auto-record title beats a stale auto-filled one, and the
    //     refresh it raced against does not clobber it afterwards
    {
        const input = { value: '' };
        const p = load([ev('Retro', -600, -540)])   // nothing current
            .autoPrefill({ input, onPick: (pick) => { input.value = pick.title; } });
        const inFlight = p.refresh();
        p.put({ title: 'Call with Ann' });
        await inFlight;
        assert.strictEqual(input.value, 'Call with Ann');
    }

    // (e) an unreadable calendar is a no-op, not a wipe: permission revoked
    //     mid-session (or the helper gone after an update) knows nothing about
    //     the meeting, and clearing on it would lose the session's title.
    for (const fail of [
        () => ({ ok: false, reason: 'calendar-permission', error: 'denied' }),
        () => { throw new Error('helper gone'); },
    ]) {
        const input = { value: '' };
        const events = [ev('Retro', -10, 20)];
        let broken = false;
        const p = load(() => (broken ? fail() : { ok: true, events }))
            .autoPrefill({ input, onPick: (pick) => { input.value = pick.title; } });
        await p.refresh();
        assert.strictEqual(input.value, 'Retro');
        broken = true;
        await p.refresh();
        assert.strictEqual(input.value, 'Retro', 'an unreadable calendar must leave the field alone');
    }

    // (f) a calendar title with padding. `auto` is compared against a trimmed
    //     field, so an untrimmed one would lock the prefill out of its own value
    //     for good — the reported bug, back again.
    {
        const input = { value: '' };
        const events = [ev('  Retro  ', -10, 20)];
        const p = load(() => ({ ok: true, events }))
            .autoPrefill({ input, onPick: (pick) => { input.value = pick.title; } });
        await p.refresh();
        assert.strictEqual(input.value, 'Retro');
        events[0] = ev('  Retro  ', -120, -90);
        await p.refresh();
        assert.strictEqual(input.value, '', 'a padded title must still be the prefill\'s own');
    }

    // (g) the form left the screen while the calendar was being read. The read
    //     spans a helper spawn, so Start can land inside it; clearing the title
    //     then loses the name the save path is about to read.
    {
        const input = { value: '' };
        const events = [ev('Retro', -10, 20)];
        let onSetup = true;
        const p = load(() => ({ ok: true, events })).autoPrefill({
            input,
            onPick: (pick) => { input.value = pick.title; },
            active: () => onSetup,
        });
        await p.refresh();
        assert.strictEqual(input.value, 'Retro');

        events[0] = ev('Retro', -120, -90);   // the meeting ended meanwhile
        let inFlight = p.refresh();
        onSetup = false;                      // Start pressed mid-read
        await inFlight;
        assert.strictEqual(input.value, 'Retro', 'the clear must not land after the form is gone');

        // Same guard on the filling half: nothing is written to a form that is
        // no longer on screen.
        input.value = '';
        events[0] = ev('Planning', -5, 25);
        await p.refresh();
        assert.strictEqual(input.value, '', 'nothing is filled in behind a live session');

        // The prompt's own title goes through the same gate: accepting it while a
        // session is on screen must not rewrite the title that session is saved
        // under (put() is reached directly, past the refresh's check).
        onSetup = false;
        input.value = '';
        p.put({ title: 'Call with Bob' });
        assert.strictEqual(input.value, '', 'put() must respect the screen gate too');

        onSetup = true;                       // back on setup: it lands now
        await p.refresh();
        assert.strictEqual(input.value, 'Planning');
    }

    // (h) attendees follow the title they belong to. A title-only caller must
    //     not carry a previous meeting's guest list into a different meeting,
    //     while a same-title title-only write still preserves manual-picker
    //     semantics.
    {
        const seen = [];
        const input = { value: '' };
        const p = load([]).autoPrefill({ input, onPick: (pick) => { seen.push(pick); input.value = pick.title; } });
        p.put({ title: 'Retro', participants: ['Ann'] });
        p.put({ title: 'Retro' });              // same meeting, prompt has no attendees
        assert.strictEqual(seen[1].participants, undefined, 'same title keeps the attendees');
        p.put({ title: 'Call with Bob' });      // different meeting, none supplied
        assert.deepEqual([...seen[2].participants], [], 'a new title drops the old guest list');
    }

    // (i) Auto-record supplies the selected event's list explicitly. It must
    //     replace a stale same-title list, including with an explicitly empty
    //     list when the selected event has no participants.
    {
        const seen = [];
        const input = { value: '' };
        const p = load([]).autoPrefill({ input, onPick: (pick) => { seen.push(pick); input.value = pick.title; } });
        p.put({ title: 'Weekly Sync', participants: ['old-a@example.com', 'old-b@example.com'] });
        p.put({ title: 'Weekly Sync', participants: ['current-a@example.com', 'current-b@example.com'] });
        assert.deepEqual([...seen.at(-1).participants], ['current-a@example.com', 'current-b@example.com']);
        p.put({ title: 'Weekly Sync', participants: [] });
        assert.deepEqual([...seen.at(-1).participants], [], 'an explicit empty list clears stale participants');
    }

    // (j) A refresh already reading an older same-title event must not restore
    //     its participant list after auto-record writes the selected event.
    {
        const seen = [];
        const input = { value: '' };
        const p = load([ev('Weekly Sync', -10, 20, ['old-a@example.com'])])
            .autoPrefill({ input, onPick: (pick) => { seen.push(pick); input.value = pick.title; } });
        const inFlight = p.refresh();
        p.put({ title: 'Weekly Sync', participants: ['current-a@example.com'] });
        await inFlight;
        assert.strictEqual(seen.length, 1, 'the stale refresh must be discarded after auto-record writes');
        assert.deepEqual([...seen[0].participants], ['current-a@example.com']);
    }

    // The Live handler must execute the participant-bearing auto-start payload
    // against the real prefill sink, not merely retain matching source text.
    {
        const seen = [];
        const input = { value: '' };
        const p = load([]).autoPrefill({ input, onPick: (pick) => { seen.push(pick); input.value = pick.title; } });
        p.put({ title: 'Weekly Sync', participants: ['old-a@example.com'] });
        const { handler, wasClicked } = loadAutoStartHandler(p);
        handler({ title: 'Weekly Sync', participants: ['current-a@example.com'] });
        assert.strictEqual(wasClicked(), true, 'auto-start still selects the Live tab');
        assert.deepEqual([...seen.at(-1).participants], ['current-a@example.com']);
        handler({ title: 'Weekly Sync', participants: [] });
        assert.deepEqual([...seen.at(-1).participants], [], 'the handler forwards an explicit empty array');
    }

    // (k) the clear is flagged, not inferred from an empty title: a nameless
    //     event reaches the sinks as `title: ''` on the smart-router path, and
    //     that must not read as "wipe the field".
    {
        const seen = [];
        const input = { value: '' };
        const events = [ev('Retro', -10, 20)];
        const p = load(() => ({ ok: true, events }))
            .autoPrefill({ input, onPick: (pick) => { seen.push(pick); input.value = pick.title; } });
        await p.refresh();
        events.length = 0;
        await p.refresh();
        assert.strictEqual(seen.at(-1).clear, true);
        assert.strictEqual(seen[0].clear, undefined);
    }

    // (l) the popover itself: whichever event currentEvent() picks is the one
    //     rendered as pre-selected, nothing is pre-selected when every meeting
    //     is over, and an unreadable calendar shows its message instead of a
    //     list. This is the `.cal-default` half of the bug, one indexOf away
    //     from the pick above.
    {
        // Drives attach() → the button's click → openPopover(), then lets the
        // list() microtasks settle.
        const openWith = async (events) => {
            const out = {};
            const picker = load(events, [], out);
            const clicks = [];
            const button = {
                style: {},
                addEventListener: (type, h) => { if (type === 'click') clicks.push(h); },
                contains: () => false,
            };
            await picker.attach({ button, onPick() {} });
            assert.strictEqual(clicks.length, 1, 'attach() should have wired the button');
            clicks[0]({ preventDefault() {} });
            for (let i = 0; i < 5; i++) await new Promise(setImmediate);
            assert.strictEqual(out.body.children.length, 1, 'one popover');
            return out.body.children[0];
        };
        const defaults = (pop) => pop.children
            .map((c, i) => [i, c.className])
            .filter(([, cls]) => cls.includes('cal-default'))
            .map(([i]) => i);

        // Sorted ascending, as the helper emits them: past, ongoing, upcoming.
        assert.deepEqual(
            defaults(await openWith([ev('Standup', -90, -60), ev('Retro', -10, 20), ev('1-1', 90, 120)])),
            [1], 'the ongoing meeting is the pre-selected one');

        // The regression: this used to pre-select item 0, the oldest one.
        assert.deepEqual(
            defaults(await openWith([ev('Standup', -50, -40), ev('Sync', -30, -20)])),
            [], 'nothing is pre-selected once every meeting has ended');

        const msg = (await openWith(() => ({ ok: false, reason: 'calendar-permission', error: 'denied' })))
            .children[0];
        assert.strictEqual(msg.className, 'cal-pop-msg');
        assert.strictEqual(msg.textContent, 'denied');
    }

    // ─── the two sinks ──────────────────────────────────────────────────────
    // `applyCalendarPick` is where a pick becomes a title and a guest list, and
    // it is the same six lines in both tabs. Sliced out and run the way
    // record-auto-transcribe.test.js slices main.js, since nothing else in the
    // suite executes these files.
    {
        const sinkOf = (file) => {
            const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', file), 'utf-8');
            const at = src.indexOf('function applyCalendarPick(');
            assert.notStrictEqual(at, -1, `applyCalendarPick not found in renderer/${file}`);
            const end = src.indexOf('\n    }\n', at);
            assert.notStrictEqual(end, -1, `applyCalendarPick in renderer/${file} has no matching close`);
            const box = { titleInput: { value: '' }, state: { calendarParticipants: [] } };
            vm.runInNewContext(src.slice(at, end + 6), box, { filename: `renderer/${file}` });
            return box;
        };

        for (const file of ['live/live.js', 'record/record.js']) {
            const box = sinkOf(file);
            const apply = box.applyCalendarPick;

            apply({ title: 'Retro', participants: ['Ann'] });
            assert.strictEqual(box.titleInput.value, 'Retro', file);
            assert.deepEqual([...box.state.calendarParticipants], ['Ann'], file);

            // The prompt's title, attendees not supplied: they stay put.
            apply({ title: 'Call with Bob' });
            assert.strictEqual(box.titleInput.value, 'Call with Bob', file);
            assert.deepEqual([...box.state.calendarParticipants], ['Ann'], file);

            // A nameless event on the smart-router path (`ev.title` is '' from
            // the helper) must not wipe what is in the field.
            box.titleInput.value = 'Договор с вендором';
            apply({ title: '', participants: [] });
            assert.strictEqual(box.titleInput.value, 'Договор с вендором',
                `${file}: a nameless event must not clear the field`);

            // Only the flagged clear empties it.
            apply({ title: '', participants: [], clear: true });
            assert.strictEqual(box.titleInput.value, '', file);
            assert.deepEqual([...box.state.calendarParticipants], [], file);
        }
    }

    console.log('calendar-prefill: ok');
})().catch((err) => { console.error(err); process.exit(1); });
