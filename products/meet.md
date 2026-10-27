# Google Meet

Status: live account testing pending; no vendor-version compatibility claim.

The deterministic model has three remote receive-only slots. It begins with 440/660/880 Hz; switching the first slot to 990 Hz via the remote sender preserves the receiving track ID and the count of three `remote` sources. A slot is not a persistent participant identity.

Join, start, mute/unmute local audio if exposed, replace the microphone, switch active remote speakers, then leave. Record whether observed slots/track count differ from this model. Validate that an active-speaker switch does not create an invented participant or reset the timeline.

Follow every row in TEMPLATE.md, recording join/start/mute/device replacement/leave and playback.
Use results/ for versioned observations and known gaps. Never substitute fixture results for a live run.
