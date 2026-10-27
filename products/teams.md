# Teams web

Status: live account testing pending; no vendor-version compatibility claim.

A controlled mixed-stream topology produces one remote receiver containing 440 + 880 Hz, plus the local sender if exposed. Expect `remote` for the mix and `local` for the outgoing mic. Do not label the mixed track as an individual participant.

Verify local mute without muting the remote mix, replace the microphone, leave the call, then try tab fallback. Device replacement may create a new local track. When receiver content changes but its identity does not, preserve source continuity.

Follow every row in TEMPLATE.md, recording join/start/mute/device replacement/leave and playback.
Use results/ for versioned observations and known gaps. Never substitute fixture results for a live run.
