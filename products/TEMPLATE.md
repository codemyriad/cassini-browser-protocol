# Product compatibility result

- Product and exposed build/version (or URL + date):
- Date / tester:
- OS / Chrome version:
- Extension upstream commit / recorder commit:
- Test-call topology (no private invite links):
- Capture mode and observed source kinds/count:

| Step | Expected | Observed | Pass/fail/blocked |
| --- | --- | --- | --- |
| Join | Call audio audible; no capture before Start | | |
| Start | Expected sources produce playable audio | | |
| Local mute / unmute | Local sender silence while muted; remote remains | | |
| Replace device | New track or resumed source stays on timeline | | |
| Remote speaker switch | Content changes; labels remain honest | | |
| Leave / navigation | Partial audio preserved and stopped visibly | | |
| Stop and replay | Separate sources aligned; no unexpected bleed | | |
| Tab fallback | Mixed output plays and records; mic is separate | | |

Known gaps and actionable follow-up:

Evidence (sanitized logs/fixture details; no real call audio committed):
