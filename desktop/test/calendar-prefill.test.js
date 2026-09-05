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

    // (h) attendees follow the title they belong to. main's auto-record prompt
    //     sends a title alone, and the previous meeting's guest list must not
    //     ride along into the new one's header — unless it is the same meeting.
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

    // (i) the clear is flagged, not inferred from an empty title: a nameless
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

    // (j) the popover itself: whichever event currentEvent() picks is the one
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
