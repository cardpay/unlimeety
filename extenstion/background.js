/* 
  Background Service Worker
  Keeps the state of the transcription and handles saving it when requested or when tab closes.
*/

// Dictionary to store transcripts per tabId
const transcripts = {};

// Reserved pseudo-speaker for the user's own typed notes — same literal the
// desktop app uses, so a transcript from either source summarizes the same way.
const NOTE_LABEL = 'Note';

// Track downloads that should trigger the Unlimeety desktop app.
// If the app is not installed the download still completes normally.
const pendingOpenInApp = new Set();

chrome.downloads.onChanged.addListener((delta) => {
  if (!pendingOpenInApp.has(delta.id)) return;

  if (delta.state?.current === 'complete') {
    pendingOpenInApp.delete(delta.id);
    chrome.downloads.search({ id: delta.id }, (items) => {
      const filePath = items?.[0]?.filename;
      if (!filePath) return;

      const url = 'unlimeety://open?file=' + encodeURIComponent(filePath);
      chrome.tabs.create({ url }, (tab) => {
        if (chrome.runtime.lastError) return;
        // If the desktop app is not installed Chrome shows an error page —
        // close that tab so the user isn't left with a dead tab.
        setTimeout(() => {
          chrome.tabs.get(tab.id, (t) => {
            if (chrome.runtime.lastError) return;
            if (t?.url?.startsWith('unlimeety://') || t?.url?.startsWith('chrome-error://')) {
              chrome.tabs.remove(tab.id);
            }
          });
        }, 1500);
      });
    });
  } else if (delta.state?.current === 'interrupted') {
    pendingOpenInApp.delete(delta.id);
  }
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Only accept messages from our own content scripts.
  if (sender.id !== chrome.runtime.id) return;
  const tabId = sender.tab ? sender.tab.id : null;
  if (!tabId) return;

  if (!transcripts[tabId]) {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    transcripts[tabId] = {
      lines: [],
      startTimeStr: `${hh}-${mm}`, // use dash for filename safety
      meetingTitle: 'Untitled Meeting'
    };
  }

  if (request.action === 'addTranscript') {
    transcripts[tabId].lines.push(request.data);
    chrome.storage.local.set({ [tabId]: transcripts[tabId] });
  } else if (request.action === 'addNote') {
    // Same reserved "Note" speaker label the desktop app writes, so one
    // summarizer hint recognises either source. Appended in arrival order —
    // captions and notes both arrive live, so nothing needs re-sorting.
    transcripts[tabId].lines.push({
      time: request.data.time,
      speaker: NOTE_LABEL,
      text: request.data.text,
    });
    chrome.storage.local.set({ [tabId]: transcripts[tabId] });
  } else if (request.action === 'updateLastTranscript') {
    // "Last" means the last *caption*, not the last line: a note typed while
    // someone is mid-sentence sits on top of the caption this update is meant
    // to revise, and a blind lines[length-1] write would silently eat it.
    const lines = transcripts[tabId].lines;
    let i = lines.length - 1;
    while (i >= 0 && lines[i].speaker === NOTE_LABEL) i--;
    if (i >= 0) lines[i] = request.data;
    else lines.push(request.data);
    // Mirrored on both branches: the else-branch used to fire only on a
    // genuinely empty array, but a note typed before the first caption now
    // makes it reachable with real content — and skipping the write there
    // would leave the persisted copy behind the in-memory one until some
    // later message happened to resync it.
    chrome.storage.local.set({ [tabId]: transcripts[tabId] });
  } else if (request.action === 'setMeetingTitle') {
    transcripts[tabId].meetingTitle = request.meetingTitle;
    if (request.startedAt && !transcripts[tabId].startedAt) {
      transcripts[tabId].startedAt = request.startedAt;
    }
    chrome.storage.local.set({ [tabId]: transcripts[tabId] });
  } else if (request.action === 'updateParticipants') {
    transcripts[tabId].participants = request.participants;
    chrome.storage.local.set({ [tabId]: transcripts[tabId] });
  } else if (request.action === 'saveTranscript') {
    if (request.meetingTitle) {
      transcripts[tabId].meetingTitle = request.meetingTitle;
    }
    if (request.participants) {
      transcripts[tabId].participants = request.participants;
    }
    if (request.language) {
      transcripts[tabId].language = request.language;
    }
    saveTranscriptForTab(tabId);
  }
});

// Auto-save if the Google Meet tab is closed
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (transcripts[tabId] && transcripts[tabId].lines && transcripts[tabId].lines.length > 0) {
    saveTranscriptForTab(tabId);
  }
});

// Auto-save if the user navigates away from the meeting
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    // Check if we have an active transcription for this tab
    if (transcripts[tabId] && transcripts[tabId].lines && transcripts[tabId].lines.length > 0) {
      const url = changeInfo.url;
      // If the new URL is not a meeting URL, it means the user left the call
      const isMeeting = /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(url);
      if (!isMeeting) {
        console.log(`User navigated away from meeting in tab ${tabId}. Saving...`);
        saveTranscriptForTab(tabId);
      }
    }
  }
});

function saveTranscriptForTab(tabId) {
  const data = transcripts[tabId];
  if (!data || !data.lines || data.lines.length === 0) {
    console.log(`No lines to save for tab ${tabId}.`);
    return;
  }

  const lines = data.lines;
  const startTime = data.startTimeStr || "00-00";
  const meetingTitle = data.meetingTitle || "Untitled Meeting";
  const participants = data.participants || [];
  const language = data.language || null;

  const LANGUAGE_NAMES = { ru: 'Русский', en: 'English', sr: 'Srpski' };

  let textContent = `Meeting: ${meetingTitle}\n`;
  if (data.startedAt) {
    textContent += `Recorded-At: ${new Date(data.startedAt).toISOString()}\n`;
  }
  textContent += `Generated: ${new Date().toISOString()}\n`;
  if (participants.length > 0) {
    textContent += `Participants: ${participants.join(', ')}\n`;
  }
  if (language) {
    textContent += `Language: ${LANGUAGE_NAMES[language] || language}\n`;
  }
  textContent += `\n`;

  let prevSpeaker = null;
  lines.forEach((line, index) => {
    if (index > 0) {
      // 2 newlines (empty line) if speaker changes, 1 newline if it's the same speaker continuing
      textContent += (line.speaker !== prevSpeaker) ? '\n\n' : '\n';
    }
    textContent += `[${line.time}] ${line.speaker}:\n${line.text}`;
    prevSpeaker = line.speaker;
  });
  textContent += '\n\n';

  const blobString = "data:text/plain;charset=utf-8," + encodeURIComponent(textContent);

  // Filename format: Meet_Transcript_Title_YYYY-MM-DD_HH-mm.txt
  const dateStr = new Date().toISOString().split('T')[0];
  const safeTitle = meetingTitle.replace(/[^a-zа-я0-9]/gi, '_').substring(0, 50);
  const filename = `Meet_Transcripts/Meet_Transcript_${safeTitle}_${dateStr}_${startTime}.txt`;

  chrome.downloads.download({
    url: blobString,
    filename: filename,
    saveAs: false
  }, (downloadId) => {
    if (chrome.runtime.lastError) {
      console.error("Download failed:", chrome.runtime.lastError);
    } else {
      console.log("Download started with ID:", downloadId);
      if (downloadId) pendingOpenInApp.add(downloadId);
      delete transcripts[tabId];
      chrome.storage.local.remove(tabId.toString());
    }
  });
}


