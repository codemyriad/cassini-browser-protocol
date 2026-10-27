# Zoom web

Status: live account testing pending; no vendor-version compatibility claim.

The deterministic PC-free Web Audio topology exposes no discoverable WebRTC or media-element track. Track mode must report waiting rather than inventing a source; manually choose Tab audio and expect one stereo `tab` track. This model does not assert that every Zoom web version is PC-free.

Join, start track mode, observe the lack of accessible tracks, stop and select tab fallback. Verify audible playback is preserved, mute/change microphone in the call without claiming it is in the tab mix, then leave and stop. Native microphone capture is a separate source when needed.

Follow every row in TEMPLATE.md, recording join/start/mute/device replacement/leave and playback.
Use results/ for versioned observations and known gaps. Never substitute fixture results for a live run.
