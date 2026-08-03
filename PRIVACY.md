# Privacy Policy — Unlimeety (Chrome Extension)

_Last updated: 2026-05-29_

This Privacy Policy describes how the **Unlimeety** Chrome extension
("the extension") handles information. The extension is published by Unlimit (Cardpay).

## Summary

The extension runs entirely on your own computer. It does **not** send any data to
our servers or to any third party. There are no analytics, no tracking, and no
network requests to external services.

## What the extension processes

While you are in a Google Meet call (`meet.google.com`) and recording is enabled,
the extension reads information that Google Meet already displays on the page:

- **Caption text** shown in the Google Meet captions panel.
- **Participant names** as displayed by Google Meet.
- **Meeting title** as displayed by Google Meet.
- **Timestamps** generated locally for each caption line.

This data is treated as personal communications content and is handled accordingly.

## How the data is used and stored

- Caption lines are kept temporarily in the extension's local storage
  (`chrome.storage.local`) on your device while a meeting is in progress.
- When you click **Save** (or when you leave the call) the transcript is written
  as a plain `.txt` file to your local Downloads folder, under
  `~/Downloads/Meet_Transcripts/`.
- After the file is saved, the in-memory and local-storage copy for that meeting
  tab is deleted.

The resulting `.txt` files live only on your computer. You own them and can edit,
move, or delete them at any time.

## Data sharing

We do **not** collect, transmit, sell, or share any of this data. The extension
makes no network calls to any server operated by us or by any third party.

## Optional desktop app integration

After a transcript is saved, the extension may try to open it in the companion
**Unlimeety** desktop app via the local `unlimeety://` URL scheme. This only
launches an application already installed on your own machine; no data leaves your
device as part of this step. If the desktop app is not installed, nothing happens
and the saved `.txt` file remains in your Downloads folder.

Any further processing in the desktop app (for example, AI summarization) is
governed by the desktop app and the AI provider you choose to configure there; it
is outside the scope of this Chrome extension.

## Permissions and why they are needed

- **`downloads`** — to write the transcript `.txt` file into your Downloads folder.
- **`storage`** — to temporarily hold caption lines for the active meeting on your device.
- **`tabs`** — to detect when you leave or close the Google Meet tab so the transcript
  can be auto-saved, and to open the saved file in the optional desktop app.
- **Host access to `meet.google.com`** — so the extension can read the captions and
  meeting information displayed on the Google Meet page.

## Children's privacy

The extension is a productivity tool intended for use by participants of their own
meetings and is not directed at children.

## Changes to this policy

If this policy changes, the updated version will be published at the same location
and the "Last updated" date will be revised.

## Contact

For questions about this policy, open an issue at https://github.com/cardpay/unlimeety/issues
