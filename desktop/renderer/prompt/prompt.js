// Frameless prompt window shown by main.js. Two modes:
//   • 'call'     — the mic monitor reports a call starting → offer to record.
//   • 'autostop' — a mic+system recording's meeting ended → counting down to
//                  auto-stop. Three ways out: "Stop now" (stop immediately),
//                  "Keep recording" (cancel the stop), and ✕ (hide this window
//                  but let the countdown stop us in the background).
// Talks to main via the `promptApi` bridge exposed in preload.js.

const titleEl = document.getElementById('title');
const subtitle = document.getElementById('subtitle');
const recordBtn = document.getElementById('record-btn');
const dismissBtn = document.getElementById('dismiss-btn');
const keepBtn = document.getElementById('keep-btn');
const stopBtn = document.getElementById('stop-btn');
const closeBtn = document.getElementById('close-btn');
const textEl = document.getElementById('text');

let countdownTimer = null;

function renderCall(app) {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    titleEl.textContent = 'Looks like a call just started';
    subtitle.textContent = app
        ? `A call is in progress in ${app}. Record this meeting?`
        : 'Record this meeting?';
    recordBtn.style.display = '';
    dismissBtn.style.display = '';
    keepBtn.style.display = 'none';
    stopBtn.style.display = 'none';
    closeBtn.style.display = 'none';
    textEl.classList.remove('with-close');
}

function renderAutoStop(seconds) {
    let remaining = Number.isFinite(seconds) ? Math.max(1, Math.floor(seconds)) : 15;
    titleEl.textContent = 'Meeting ended';
    recordBtn.style.display = 'none';
    dismissBtn.style.display = 'none';
    stopBtn.style.display = '';
    keepBtn.style.display = '';
    closeBtn.style.display = '';
    textEl.classList.add('with-close');

    const paint = () => { subtitle.textContent = `Stopping recording in ${remaining}s…`; };
    paint();
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
            clearInterval(countdownTimer);
            countdownTimer = null;
            subtitle.textContent = 'Stopping…';
            return;
        }
        paint();
    }, 1000);
}

window.promptApi.onData((data) => {
    if (data && data.mode === 'autostop') renderAutoStop(data.seconds);
    else renderCall(data && data.app);
});

recordBtn.addEventListener('click', () => window.promptApi.record());
dismissBtn.addEventListener('click', () => window.promptApi.dismiss());
keepBtn.addEventListener('click', () => window.promptApi.keepRecording());
stopBtn.addEventListener('click', () => window.promptApi.stopNow());
closeBtn.addEventListener('click', () => window.promptApi.hide());
