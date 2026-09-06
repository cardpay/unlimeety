'use strict';
// node --test test/extension-background-header.test.js
//
// Executes the Chrome extension's background service worker against
// hand-rolled `chrome` stubs, same technique as test/extension-autostart.test.js
// (a `new Function(...)` over the real source — background.js is a classic
// script, not a module, so its declarations cannot be required).
//
// spec-extension-hardening.md: saveTranscriptForTab writes a Meet guest's
// DOM-sourced meeting title and participant names straight into the
// transcript header with no control-char or length limit. This drives the
// message flow a real content script produces (setMeetingTitle →
// updateParticipants → addTranscript → saveTranscript) and inspects the
// header actually written to the download's data: URL.

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BACKGROUND_JS = path.join(__dirname, '..', '..', 'extenstion', 'background.js');
const src = fs.readFileSync(BACKGROUND_JS, 'utf-8');

const EXT_ID = 'test-extension-id';

function run() {
    let messageListener = null;
    let lastDownload = null;

    const chrome = {
        downloads: {
            onChanged: { addListener() {} },
            download: (opts, cb) => {
                lastDownload = opts;
                if (cb) cb(1);
            },
            search() {},
        },
        tabs: {
            onRemoved: { addListener() {} },
            onUpdated: { addListener() {} },
            create() {},
            get() {},
            remove() {},
        },
        runtime: {
            id: EXT_ID,
            lastError: undefined,
            onMessage: { addListener: (fn) => { messageListener = fn; } },
        },
        storage: {
            local: { set() {}, remove() {} },
        },
    };
    const quiet = { log() {}, warn() {}, error() {}, debug() {} };

    const factory = new Function('chrome', 'console', src + '\n; return {};');
    factory(chrome, quiet);

    const sender = { id: EXT_ID, tab: { id: 1 } };
    const send = (action, extra = {}) => messageListener({ action, ...extra }, sender, () => {});

    return {
        send,
        // Decodes the "data:text/plain;charset=utf-8,<encoded>" URL
        // chrome.downloads.download was last called with.
        savedText: () => {
            assert.ok(lastDownload, 'chrome.downloads.download must have been called');
            const url = lastDownload.url;
            const comma = url.indexOf(',');
            return decodeURIComponent(url.slice(comma + 1));
        },
    };
}

const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;

test('an oversized, control-char-laden meeting title is capped and cleaned in the saved header', () => {
    const w = run();
    const dirtyTitle = '\x00\x1fTitle\r\nwith  weird   spacing' + 'X'.repeat(5000);
    w.send('setMeetingTitle', { meetingTitle: dirtyTitle, startedAt: new Date().toISOString() });
    w.send('addTranscript', { data: { time: '00:00:01', speaker: 'A', text: 'hello world' } });
    w.send('saveTranscript', {});

    const text = w.savedText();
    const meetingLine = text.split('\n').find((l) => l.startsWith('Meeting: '));
    assert.ok(meetingLine, 'a Meeting: header line must be present');
    const value = meetingLine.slice('Meeting: '.length);
    assert.ok(value.length <= 120, `title must be capped at 120 chars, got ${value.length}`);
    assert.ok(!CONTROL_CHARS.test(value), 'no control character may survive into the header');
    assert.ok(!value.includes('\n') && !value.includes('\r'), 'no embedded newline may survive into the header');
});

test('oversized, control-char-laden participant names are each capped and cleaned', () => {
    const w = run();
    const dirtyParticipant = 'Ivan\x00\x01Petrov' + 'Y'.repeat(300);
    w.send('setMeetingTitle', { meetingTitle: 'Standup', startedAt: new Date().toISOString() });
    w.send('updateParticipants', { participants: [dirtyParticipant, 'You'] });
    w.send('addTranscript', { data: { time: '00:00:01', speaker: 'A', text: 'hello world' } });
    w.send('saveTranscript', {});

    const text = w.savedText();
    const participantsLine = text.split('\n').find((l) => l.startsWith('Participants: '));
    assert.ok(participantsLine, 'a Participants: header line must be present');
    const names = participantsLine.slice('Participants: '.length).split(', ');
    assert.strictEqual(names.length, 2);
    assert.ok(names[0].length <= 120, `participant name must be capped at 120 chars, got ${names[0].length}`);
    assert.ok(!CONTROL_CHARS.test(names[0]), 'no control character may survive into a participant name');
    assert.strictEqual(names[1], 'You');
});

test('a clean, short title and participant list pass through unchanged', () => {
    const w = run();
    w.send('setMeetingTitle', { meetingTitle: 'Weekly Sync', startedAt: new Date().toISOString() });
    w.send('updateParticipants', { participants: ['Иван Петров'] });
    w.send('addTranscript', { data: { time: '00:00:01', speaker: 'A', text: 'hello world' } });
    w.send('saveTranscript', {});

    const text = w.savedText();
    assert.ok(text.split('\n').includes('Meeting: Weekly Sync'));
    assert.ok(text.split('\n').includes('Participants: Иван Петров'));
});

console.log('extension-background-header: all checks passed');
