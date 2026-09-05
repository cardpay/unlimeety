// npm run screenshots
//
// Regenerates the images README.md embeds from `docs/`. Lives in scripts/ for
// the same reason layout-check.mjs does: bare `node --test` globs
// `**/test/**/*.?(c|m)js`, and `npm test` must stay Electron-free.
//
// It drives its own Electron over CDP, like layout-check.mjs — but the library
// it photographs comes from disk, and TRANSCRIPTS_FOLDER / RECORDINGS_FOLDER
// (main.js) are hardcoded under `os.homedir()` with no config override. So the
// child gets a scratch $HOME: on POSIX os.homedir() reads $HOME, and Electron
// derives app.getPath('userData') from it too, which moves the library, the
// config and the single-instance lock into the scratch dir in one move. The
// real app's data is never read, never written, and the installed copy's lock
// is never contended.
//
// Everything photographed is invented — no real meeting, name or recording of
// the user's reaches these files.
//
// One line per shot; exit code 1 if any shot failed.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import {
    connect, debugPort, evaluator, requireNode22, waitForRenderer, waitForTarget,
} from './cdp.mjs';

requireNode22('npm run screenshots');

const DESKTOP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(DESKTOP, '..', 'docs');
const PORT = debugPort();

// 1800x1200, the size the committed images already are, so replacing one does
// not reflow the README. The split matters as much as the product: at 900x600
// the three-pane editor is squeezed hard enough that the toolbar sheds buttons
// and the transcript wraps every three words. 1200x800 is the window the layout
// is actually tuned for (layout-check.mjs measures it), and 1.5 carries it to
// the same pixel count.
const VIEW = { width: 1200, height: 800, deviceScaleFactor: 1.5 };

const results = [];
const shot = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ─── Demo library ────────────────────────────────────────────────────────────

// Wall-clock stamps are written ISO, exactly as main.js does now, because
// `Recorded-At:` is what transcripts:list groups the sidebar by — these offsets
// are what put the four cards under Today / Yesterday / Last week.
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

// Turn timestamps are `[MM:SS]` offsets, the shape main.js's formatHms writes
// for anything under an hour — the shape parseSegments turns into a seekable
// segment. A wall-clock label would render as an unseekable line and quietly
// photograph the wrong feature.
const MEETINGS = [
    {
        stem: 'Weekly product sync',
        recordedAt: iso(2 * HOUR),
        model: 'openai_whisper-large-v3',
        enhancedAt: iso(2 * HOUR - 20 * 60_000),
        language: 'English',
        participants: ['Dana Reyes', 'Marco Silva', 'Priya Nair'],
        audioSec: 144,
        body: [
            ['00:07', 'Dana Reyes', "Let's keep this one short. Three things: the onboarding funnel, the export bug, and whether we ship the new pricing page this week."],
            ['00:21', 'Marco Silva', "Funnel first. We rebuilt the second step and drop-off went from forty-one percent down to twenty-six. That's with only two days of data, so treat it as a signal, not a number."],
            ['00:39', 'Dana Reyes', 'Twenty-six is still high for a step that asks three questions.'],
            ['00:46', 'Marco Silva', "Agreed. My guess is the workspace-name field. People stall there because they think it's permanent. I want to add a hint that says you can change it later."],
            ['01:02', 'Priya Nair', "I can do that today, it's a one-line copy change. The export bug is the one I'd rather talk about — it's not a bug in export, it's a bug in how we cache the document list."],
            ['01:19', 'Dana Reyes', 'Meaning search is wrong too and nobody has reported it yet.'],
            ['01:24', 'Priya Nair', 'Exactly. Patching export alone buys us a week and then the same ticket comes back wearing a different hat.'],
            ['01:35', 'Note', 'ask Priya for the cache-invalidation PR before Thursday'],
            ['01:41', 'Dana Reyes', "Then fix the cache. Two days is fine — I'd rather pay it once."],
            ['01:52', 'Marco Silva', "Which pushes pricing to Thursday. The annual toggle still shows a discount badge instead of the annual total, and that's the part people ask about."],
            ['02:06', 'Dana Reyes', 'Thursday it is. Show the total, drop the badge.'],
        ],
        summary: [
            '---',
            'categories:',
            '  - "[[Meetings]]"',
            'type: regular sync',
            `date: ${new Date(Date.now() - 2 * HOUR).toISOString().slice(0, 10)}`,
            'people:',
            '  - Dana Reyes',
            '  - Marco Silva',
            '  - Priya Nair',
            'topics:',
            '---',
            '',
            '## Summary',
            '',
            'A short three-item sync on the onboarding funnel, a stale-cache bug surfacing as an',
            'export failure, and the readiness of the new pricing page. Drop-off on the rebuilt',
            'onboarding step improved from 41% to 26% on two days of data. The team chose the',
            'root-cause fix over the quick patch, and moved the pricing launch to Thursday.',
            '',
            '## Topics',
            '',
            '- Onboarding funnel drop-off after the step-two rebuild',
            '- Stale document-list cache surfacing in both export and search',
            '- Readiness of the new pricing page and the annual toggle',
            '',
            '## Action Items',
            '',
            '- [ ] **Priya Nair** — rewrite cache invalidation for the document list, then watch it for a day',
            '- [ ] **Priya Nair** — add the "you can change this later" hint to the workspace-name field — *today*',
            '- [ ] **Marco Silva** — show the annual total on the pricing toggle instead of a discount badge — *Thu*',
            '',
            '## Decisions',
            '',
            '- Fix cache invalidation once rather than patching export and search separately — two days, accepted.',
            '- Pricing page ships Thursday, not this week, with the annual total spelled out.',
            '',
            '## Risks',
            '',
            '- The 26% figure rests on two days of data and may not hold for a full week.',
        ].join('\n'),
    },
    {
        stem: '1-1 with Marco',
        recordedAt: iso(DAY + 3 * HOUR),
        model: 'openai_whisper-large-v3',
        language: 'English',
        participants: ['Dana Reyes', 'Marco Silva'],
        audioSec: 96,
        body: [
            ['00:04', 'Dana Reyes', 'How did the rebuild week actually feel, not how did it go.'],
            ['00:11', 'Marco Silva', 'Long. The measuring took more of it than the building did, and I kept second-guessing whether two days of data was worth acting on.'],
            ['00:27', 'Dana Reyes', "It usually isn't. It was here because the change was cheap to undo."],
            ['00:36', 'Marco Silva', "That's the rule I was missing. I'd like to own the pricing page end to end next quarter, including the copy."],
        ],
    },
    {
        stem: 'Sprint retro',
        recordedAt: iso(6 * DAY),
        model: 'openai_whisper-small',
        language: 'English',
        participants: ['Dana Reyes', 'Marco Silva', 'Priya Nair', 'Ana Kovač'],
        audioSec: 213,
        body: [
            ['00:05', 'Ana Kovač', 'Same three columns as always. What went well, what did not, what we try next.'],
            ['00:14', 'Priya Nair', 'The on-call handover finally has a written checklist, and nobody paged me at two in the morning to ask where the runbook lives.'],
            ['00:31', 'Marco Silva', "What did not go well: we shipped the funnel rebuild behind no flag. It worked, but that was luck, not process."],
            ['00:47', 'Dana Reyes', "Then that's the experiment — every user-facing change behind a flag for one sprint, and we see whether it actually slows us down or only feels like it does."],
        ],
    },
    {
        stem: 'Vendor call — data retention',
        recordedAt: iso(8 * DAY),
        model: 'openai_whisper-small',
        language: 'English',
        participants: ['Dana Reyes', 'Priya Nair', 'Ana Kovač'],
        audioSec: 167,
        body: [
            ['00:06', 'Ana Kovač', 'Their standard contract keeps deleted records for ninety days. Ours says thirty.'],
            ['00:16', 'Priya Nair', 'Ninety is their backup window, not a policy. If they can scope it to backups only, thirty for live data still holds.'],
            ['00:33', 'Dana Reyes', "Ask for that in writing before we sign anything."],
        ],
    },
];

// One recording with no transcript beside it — that is the whole content of the
// `To transcribe` queue, and the reason its chip shows a count.
const ORPHAN_RECORDING = { stem: 'Design review 14-30 04-09-26', audioSec: 61 };

function transcriptText(m) {
    const head = [`Meeting: ${m.stem}`, `Recorded-At: ${m.recordedAt}`, `Generated: ${m.recordedAt}`];
    if (m.model) head.push(`Model: ${m.model}`);
    if (m.enhancedAt) head.push(`Enhanced: ${m.enhancedAt}`);
    head.push(`Participants: ${m.participants.join(', ')}`);
    head.push(`Language: ${m.language}`);
    const turns = m.body.map(([t, who, text]) => `[${t}] ${who}:\n${text}`);
    return `${head.join('\n')}\n\n${turns.join('\n\n')}\n`;
}

// 8 kHz mono 16-bit PCM. Rate is as low as it goes without the decode sounding
// like a bug report: the file is never played, only decoded into the player's
// 80 waveform bars, and a flat buffer would photograph as a flat ruler. The
// envelope is a slow swell times a faster tremolo, so the bars read as speech.
function wavBuffer(seconds) {
    const rate = 8000;
    const frames = Math.round(rate * seconds);
    const data = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i += 1) {
        const t = i / rate;
        const envelope = (0.55 + 0.45 * Math.sin(t * 0.7)) * (0.6 + 0.4 * Math.sin(t * 5.3));
        const tone = Math.sin(t * 2 * Math.PI * 180) * 0.6 + Math.sin(t * 2 * Math.PI * 320) * 0.4;
        data.writeInt16LE(Math.round(tone * envelope * 12000), i * 2);
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);          // PCM chunk size
    header.writeUInt16LE(1, 20);           // PCM
    header.writeUInt16LE(1, 22);           // mono
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);    // byte rate
    header.writeUInt16LE(2, 32);           // block align
    header.writeUInt16LE(16, 34);          // bits per sample
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

async function writeLibrary(home) {
    const transcripts = path.join(home, 'Downloads', 'Meet_Transcripts');
    const recordings = path.join(home, 'Downloads', 'Meet_Recordings');
    await mkdir(transcripts, { recursive: true });
    await mkdir(recordings, { recursive: true });
    for (const m of MEETINGS) {
        await writeFile(path.join(transcripts, `${m.stem}.txt`), transcriptText(m), 'utf-8');
        // `<stem>.summary.md` is legacySummaryBase — the last candidate
        // findExistingSummaryPath tries, and the only one that does not depend
        // on the date-formatting preferences this scratch profile has never set.
        if (m.summary) {
            await writeFile(path.join(transcripts, `${m.stem}.summary.md`), `${m.summary}\n`, 'utf-8');
        }
        await writeFile(path.join(recordings, `${m.stem}.wav`), wavBuffer(m.audioSec));
    }
    await writeFile(path.join(recordings, `${ORPHAN_RECORDING.stem}.wav`),
        wavBuffer(ORPHAN_RECORDING.audioSec));
}

// ─── Page-side helpers ───────────────────────────────────────────────────────

const HELPERS = `
window.__shot = {
  // Show a tab and skip its platform gate — same reasoning as layout-check's
  // showTab: on a host where live.platformOK() says no, #live-setup sits inside
  // a hidden ancestor and photographs as an empty panel.
  showTab(tab) {
    document.querySelector('.tab-btn[data-tab="' + tab + '"]').click();
    for (const t of ['live', 'record']) {
      document.getElementById(t + '-unsupported')?.classList.add('hidden');
      document.getElementById(t + '-main')?.classList.remove('hidden');
    }
  },
  // Wait for the sidebar to hold a card for this title, then open it. The
  // library arrives over IPC and the summary rail fetches its markdown after
  // that, so a fixed sleep would photograph a half-painted rail.
  async openMeeting(title) {
    const deadline = Date.now() + 15000;
    let card = null;
    for (;;) {
      card = [...document.querySelectorAll('.meeting-card')]
        .find((el) => el.textContent.includes(title));
      if (card) break;
      if (Date.now() > deadline) return 'no card for ' + title;
      await new Promise((r) => setTimeout(r, 100));
    }
    card.click();
    for (;;) {
      const rail = document.getElementById('summary-rail');
      const painted = rail && !rail.classList.contains('hidden')
        && rail.querySelector('.rail-section');
      const segs = document.querySelectorAll('#transcript-view .tv-seg').length;
      if (painted && segs) break;
      if (Date.now() > deadline) return 'transcript or rail never painted';
      await new Promise((r) => setTimeout(r, 100));
    }
    // The waveform decodes the wav asynchronously and starts as flat
    // placeholder bars; photographing before it settles shows a ruler.
    const wfDeadline = Date.now() + 8000;
    while (Date.now() < wfDeadline) {
      const bars = document.querySelectorAll('#ap-waveform .ap-bar, #ap-waveform span, #ap-waveform div');
      const heights = new Set([...bars].map((b) => b.style.height));
      if (bars.length && heights.size > 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  },
  // The result view without a model call: renderModalSummary is the same
  // function the real run calls once the provider answers, so this photographs
  // the shipped renderer rather than a mock of it.
  showSummaryResult(md, title, subtitle) {
    document.getElementById('modal-title').textContent = 'Summarize — ' + title;
    for (const v of ['prompt', 'loading', 'error']) {
      document.getElementById('modal-view-' + v)?.classList.add('hidden');
    }
    document.getElementById('modal-view-result').classList.remove('hidden');
    document.getElementById('summarize-modal').classList.remove('hidden');
    renderModalSummary(md, subtitle);
    return !!document.querySelector('#modal-result-body .rail-section, #modal-result-body .fm-table');
  },
  hideSummaryResult() {
    document.getElementById('summarize-modal').classList.add('hidden');
    document.getElementById('modal-view-result').classList.add('hidden');
    document.getElementById('modal-view-prompt')?.classList.remove('hidden');
  },
  // Feed the real broadcast handler, so the panel, the badge and the per-row
  // Cancel/✕ affordances are all decided by the shipped code paths. Nothing is
  // submitted to main — these ids belong to no real job, and cancel/dismiss on
  // them would simply be ignored.
  showQueue(jobs) {
    onQueueChanged(jobs);
    document.getElementById('queue-indicator-btn').click();
    return !document.getElementById('queue-panel').classList.contains('hidden')
      && document.querySelectorAll('#queue-panel-list .queue-job').length === jobs.length;
  },
  // The window opens wherever the OS puts it, which may well be under the real
  // cursor — and :hover then paints one transcript row as if somebody had
  // selected it. A synthetic Input.dispatchMouseEvent does not clear a hover the
  // OS pointer is holding, so the styles are suppressed for the shot instead.
  // Only pointer feedback is neutralized; nothing about the content changes.
  suppressHover() {
    if (document.getElementById('shot-no-hover')) return;
    const st = document.createElement('style');
    st.id = 'shot-no-hover';
    // Both of these are transparent when not hovered, and .meeting-card.active
    // sets its own background at higher specificity, so the open meeting keeps
    // its highlight.
    st.textContent = '.tv-seg:hover, .meeting-card:hover'
      + ' { background: transparent !important; }';
    document.head.appendChild(st);
  },
};
return 'ok';
`;

const DEMO_JOBS = [
    {
        id: 'demo-1', type: 'transcribe', status: 'running',
        filePath: '/Meet_Recordings/Design review 14-30 04-09-26.wav',
        title: 'Design review 14-30 04-09-26.wav',
        progress: { label: 'Transcribing — 2:41 of 6:12' }, createdAt: Date.now() - 40_000,
    },
    {
        id: 'demo-2', type: 'enhance', status: 'queued',
        filePath: '/Meet_Transcripts/Sprint retro.txt', title: 'Sprint retro.txt',
        createdAt: Date.now() - 25_000,
    },
    {
        id: 'demo-3', type: 'summarize', status: 'done',
        filePath: '/Meet_Transcripts/Weekly product sync.txt', title: 'Weekly product sync.txt',
        createdAt: Date.now() - 90_000,
    },
];

// ─── Shots ───────────────────────────────────────────────────────────────────

async function capture(cdp, file) {
    const res = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(DOCS, file), Buffer.from(res.data, 'base64'));
}

// Every entry returns null on success or a reason string; the light ones run
// first and the dark one last, so no shot depends on the theme a previous one
// left behind.
const SHOTS = [
    {
        file: 'screenshot-library-light.png',
        run: async (evaluate) => evaluate(`
            __shot.showTab('editor');
            return await __shot.openMeeting('Weekly product sync');`),
    },
    // Both setup screens are taller than 800px once the permission block is in
    // them, and cropping "Start recording" off the bottom of the one image that
    // exists to show the form would be the wrong half to keep. These two grow
    // the viewport to the form instead — the README scales images to its own
    // column width, so a taller aspect costs nothing there.
    {
        file: 'screenshot-live-light.png',
        fitTab: 'live',
        run: async (evaluate) => evaluate(`
            __shot.showTab('live');
            document.getElementById('live-setup').scrollTop = 0;
            await new Promise((r) => requestAnimationFrame(r));
            return document.getElementById('live-btn-start') ? null : 'live setup not rendered';`),
    },
    {
        file: 'screenshot-record-light.png',
        fitTab: 'record',
        run: async (evaluate) => evaluate(`
            __shot.showTab('record');
            document.getElementById('record-setup').scrollTop = 0;
            await new Promise((r) => requestAnimationFrame(r));
            return document.getElementById('record-btn-start') ? null : 'record setup not rendered';`),
    },
    {
        file: 'screenshot-queue-light.png',
        run: async (evaluate) => evaluate(`
            __shot.showTab('editor');
            await __shot.openMeeting('Weekly product sync');
            const ok = __shot.showQueue(${JSON.stringify(DEMO_JOBS)});
            await new Promise((r) => requestAnimationFrame(r));
            return ok ? null : 'queue panel did not open with all rows';`),
        after: async (evaluate) => evaluate(`
            document.getElementById('queue-indicator-btn').click();
            onQueueChanged([]);
            return 1;`),
    },
    {
        file: 'screenshot-summary-light.png',
        run: async (evaluate, ctx) => evaluate(`
            __shot.showTab('editor');
            await __shot.openMeeting('Weekly product sync');
            const ok = __shot.showSummaryResult(
                ${JSON.stringify(ctx.summaryMd)},
                'Weekly product sync',
                'Claude Code · 12s');
            await new Promise((r) => requestAnimationFrame(r));
            return ok ? null : 'result view rendered nothing';`),
        after: async (evaluate) => evaluate('__shot.hideSummaryResult(); return 1;'),
    },
    {
        file: 'screenshot-library-dark.png',
        // Dark is the shipped default and every committed image was light, so
        // the README had no picture of what most users actually see. Reload
        // rather than toggling live: theme-init.js resolves the preference in
        // <head>, and this photographs that same first-paint path.
        reloadAs: 'dark',
        run: async (evaluate) => evaluate(`
            __shot.showTab('editor');
            return await __shot.openMeeting('Weekly product sync');`),
    },
];

// ─── Harness ─────────────────────────────────────────────────────────────────

const home = await mkdtemp(path.join(tmpdir(), 'unlimeety-shots-'));
const childExited = { done: null };
let cdp;
let child;

try {
    await writeLibrary(home);
    await mkdir(DOCS, { recursive: true });

    // --user-data-dir on top of the scratch $HOME: Chromium resolves userData
    // through its own PathService, not Node's os.homedir(), so $HOME alone left
    // the child sharing the installed app's profile — and its single-instance
    // lock, which made it quit immediately with status 0 and no window.
    child = spawn(electron, [
        DESKTOP,
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${path.join(home, 'electron-profile')}`,
    ], {
        stdio: ['ignore', 'ignore', 'inherit'],
        env: { ...process.env, HOME: home },
    });
    child.on('error', (err) => { childExited.done = `spawn failed: ${err.message}`; });
    child.on('exit', (code, sig) => {
        childExited.done ??= `exit code ${code}${sig ? ` (${sig})` : ''}`;
    });

    const target = await waitForTarget(PORT, Date.now() + 45_000, childExited);
    const expected = `file://${DESKTOP}/renderer/index.html`;
    if (target.url !== expected) {
        throw new Error(`CDP target is not this project: ${target.url} (want ${expected})`);
    }
    cdp = connect(target.webSocketDebuggerUrl);
    await cdp.open;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    let evaluate = evaluator(cdp);
    if (!(await waitForRenderer(evaluate))) throw new Error('renderer never finished loading');

    // A scratch profile has no theme preference, so it opens on the shipped
    // dark default; the light shots need one write and a reload to pick it up
    // in <head> before first paint.
    const reloadWithTheme = async (name) => {
        await evaluate(`try { localStorage.setItem('uds-theme', ${JSON.stringify(name)}); } catch (_) {} return 1;`);
        await cdp.send('Page.reload');
        evaluate = evaluator(cdp);
        if (!(await waitForRenderer(evaluate))) throw new Error('renderer never reloaded');
        await evaluate(HELPERS);
        await evaluate('__shot.suppressHover(); return 1;');
        await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEW, mobile: false });
        await evaluate('await new Promise((r) => requestAnimationFrame(r)); return 1;');
    };

    await reloadWithTheme('light');

    const setViewport = async (height) => {
        await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEW, height, mobile: false });
        await evaluate('await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return 1;');
    };

    const ctx = { summaryMd: MEETINGS[0].summary };
    for (const s of SHOTS) {
        try {
            if (s.reloadAs) await reloadWithTheme(s.reloadAs);
            const reason = await s.run(evaluate, ctx);
            if (reason) { shot(s.file, false, reason); continue; }
            let height = VIEW.height;
            if (s.fitTab) {
                // The scroll box's own overflow plus the toolbar above it: the
                // form stops scrolling exactly when the viewport covers both.
                const grow = await evaluate(`
                    const box = document.getElementById('${s.fitTab}-setup');
                    return Math.max(0, box.scrollHeight - box.clientHeight);`);
                if (grow > 0) {
                    height = VIEW.height + grow;
                    await setViewport(height);
                }
            }
            await capture(cdp, s.file);
            if (height !== VIEW.height) await setViewport(VIEW.height);
            if (s.after) await s.after(evaluate);
            const px = (n) => Math.round(n * VIEW.deviceScaleFactor);
            shot(s.file, true, `${px(VIEW.width)}x${px(height)}`);
        } catch (err) {
            shot(s.file, false, `threw: ${err.message}`);
        }
    }
} catch (err) {
    shot('harness', false, err.message);
} finally {
    cdp?.close();
    if (child) {
        child.kill('SIGKILL');
        // Electron's helpers keep writing into the scratch home until the group
        // is actually gone; removing it before that is an ENOTEMPTY that would
        // replace the whole verdict.
        if (!childExited.done) await once(child, 'exit').catch(() => {});
    }
    await rm(home, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} shots written to docs/`);
process.exitCode = (failed.length || results.length !== SHOTS.length) ? 1 : 0;
