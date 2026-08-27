---
title: 'Move date/time to the end of generated recording and summary filenames'
type: 'chore'
created: '2026-08-27'
status: 'done'
route: 'one-shot'
---

# Move date/time to the end of generated recording and summary filenames

## Intent

**Problem:** Recordings (`HH-mm DD-MM-YY <title>.wav`) and summaries (`DD.MM.YY <title>.summary.md`) put the date/time stamp before the title, so the title is pushed off-screen first in any UI that truncates the filename.

**Approach:** Swap the concatenation order in the two stem builders so the stamp trails the title instead of leading it: `<title> HH-mm DD-MM-YY` for recordings, `<title> DD.MM.YY` for summaries. No format, separator, or collision-suffix change — only the order of the two existing pieces.

## Suggested Review Order

- Recording filenames: title now leads, timestamp trails; the placeholder-only case (no title) is untouched.
  [`main.js:3245`](../../desktop/main.js#L3245)

- Same reorder for summary filenames, reusing the existing `DD.MM.YY` formatter unchanged.
  [`main.js:780`](../../desktop/main.js#L780)

- Stale doc comment on Live's own recording tee updated to match the new order.
  [`main.js:2780`](../../desktop/main.js#L2780)
