/* ─────────────────────────────────────────────────────────────────────────────
 * Shared note-list rendering — used by BOTH note UIs:
 *   • the Live tab's floating window   (renderer/notes/notes.html)
 *   • the Record tab's inline control  (renderer/index.html)
 *
 * They render the same rows from the same source (main's `notes:list`), so the
 * rules live here once: a rule added for one list can't silently miss the
 * other. Loaded as a plain script in both documents — no bundler in this app —
 * and exposed as `window.notesList`.
 * ─────────────────────────────────────────────────────────────────────── */

(() => {
    // Same coercion as main.js's formatHms: a hand-edited sidecar must not
    // render "NaN:NaN". Notes taken before the audio clock started carry a
    // negative offset (kept for ordering) and pin to 00:00 here — the
    // transcript has no way to say "before the recording began".
    function formatHms(sec) {
        const s = Math.max(0, Math.floor(Number(sec) || 0));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const r = s % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return h > 0 ? `${pad(h)}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
    }

    // Repaint `container` from `notes` ([{start, text}], as main returns them).
    // `emptyEl` is the placeholder shown when there are none; it lives inside
    // the container, so it's toggled rather than cleared away.
    function render(container, emptyEl, notes) {
        container.querySelectorAll('.note-row').forEach(row => row.remove());
        if (emptyEl) emptyEl.style.display = notes.length ? 'none' : '';
        for (const n of notes) {
            const row = document.createElement('div');
            row.className = 'note-row';

            const time = document.createElement('div');
            time.className = 'note-time';
            time.textContent = formatHms(n.start);

            const body = document.createElement('div');
            body.className = 'note-text';
            body.textContent = n.text;

            row.appendChild(time);
            row.appendChild(body);
            container.appendChild(row);
        }
        container.scrollTop = container.scrollHeight;
    }

    // Pull the active session's notes from main and repaint. Main is the only
    // source of truth: it owns the elapsed clock, so what's on screen and what
    // lands in the transcript can't disagree.
    async function refresh(container, emptyEl) {
        try {
            render(container, emptyEl, (await window.notesApi?.list()) || []);
        } catch {
            /* no session yet — leaving the placeholder up is the honest state */
        }
    }

    // Enter-to-submit, shared by both inputs.
    //   • ignores the Enter that commits an IME composition (CJK), which would
    //     otherwise ship a half-composed buffer and wipe the field mid-word
    //   • only paints a row once main has acknowledged the note
    //   • on rejection hands the text back — but only if the user hasn't
    //     started typing something else while the round-trip was in flight
    function attachInput({ input, container, emptyEl, placeholder, rejectedMessage }) {
        input.addEventListener('keydown', async (e) => {
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key !== 'Enter') return;
            const text = input.value.trim();
            if (!text) return;
            input.value = '';
            const res = await window.notesApi?.add(text);
            if (!res?.ok) {
                if (input.value === '') input.value = text;
                input.placeholder = rejectedMessage;
                setTimeout(() => { input.placeholder = placeholder; }, 2500);
                return;
            }
            refresh(container, emptyEl);
        });
    }

    window.notesList = { formatHms, render, refresh, attachInput };
})();
