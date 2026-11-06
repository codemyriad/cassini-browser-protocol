# D52.2 (P7) gap ranges and presence

Shared vectors for GNOME G6 and Mac M8. The rules are in SPEC.md, "Gap ranges and
presence". `gaps.py` is an independent oracle that reproduces every literal case. It is
not production code for either app. Each app replays the vectors through its own writer
and presence helper.

## writer.json

Each case lists abstract steps (frame counts only, PCM16 mono, 48 kHz unless `rate` is
given) and the expected recorded spans in creation order. `features` lists the negotiated
features: `[]` is a legacy session, which records ranges too. `selection` sets the initial
`me`/`others` state, and both default to true.

| op | Meaning |
| --- | --- |
| `track {id, kind=remote, rate}` | Browser wire declaration. Recorded now if its side is selected. |
| `audio {id, offsetMs, frames}` | Browser chunk, applying SPEC tolerance/padding. Discarded while deselected. |
| `series {id, firstOffsetMs, everyMs, count, frames}` | `count` audio chunks at `firstOffsetMs + i*everyMs`. |
| `select {atMs, me?, others?}` | App selection change. It ends spans; reselection opens a new span with boundary `atMs`. |
| `trackEnd {id, droppedFrames}` | Negotiated end, replayed with reason `ended` and endOffsetMs null. Adds the count to the latest span that recorded the wire ID. |
| `nativeTrack {id, kind, rate, boundaryMs?}` | Native span, with an optional selection boundary. |
| `input {id, hostMs, frames, writerFrames=0}` | Native input buffer with its session-relative host stamp. `writerFrames`: frames the host writer lost right before it (R93-2 D2), at most the host time since the previous buffer (rounded half up), padded as a `writer` range ending where the buffer starts; only host time they do not cover is an `input` gap, padded before them. |
| `writerTail {id, untilMs, resumeMs?, writerFrames?}` | Native audio the host writer lost after the span's last frame, padded as a `writer` range up to `untilMs` (a Stop moment). With `resumeMs`, the `writerFrames` lost lie right before a buffer at `resumeMs`, after `untilMs`: only their share before `untilMs` is padded, after the host time ahead of them as an `input` gap under the one-second rule (shorter is clock skew, not padded). |

Each recorded span is closed at the end of the case, as by a user Stop without a problem.
Offsets round half up. A writer that keeps an inert zero-frame span for a source declared while
deselected leaves it out of the comparison; such a span recorded nothing and receives no drops.
Prefix cases follow S-6: a reselected or boundary-declared span starts at the boundary.

Expected tracks hold `wire`, `startOffsetMs`, `frames` (including padding), `gapFrames`,
`droppedFrames` and `gaps`. In the expected tracks, `gapFrames: 0` and `droppedFrames: 0`
mean absent or zero. `atMs` and `durationMs` compare within 1e-6 ms; `frames` must be equal.
The overflow case gives `gapsCount`, `gapsHead` and `gapsTail` instead of 1001 literal
entries. `state` and `problemKind` are the saved session's; `problemKind: null` means absent.
`endReason` is the saved `end` event's reason: `user` when absent, `error` after host writer loss.
Native gap kinds assume an unwarped clock, so nominal and mapped positions agree.

## presence.json

Stored track facts (`startOffsetMs`, `sampleRate`, `frames`, optional `gaps`) plus optional
ownership windows go in; integer half-open 16 kHz session-sample ranges `present` and
`unknown` come out. A track's extent starts at its D55 placement, the session sample
frame(startOffsetMs, 16000) (startOffsetMs × 16 rounded half away from zero), not at the raw
offset, and lasts frames/sampleRate from there; gap ranges and ownership stay on the session
timeline. A window [a,b) ms covers samples [ceil(16a - 1e-6), ceil(16b - 1e-6)).
A reader whose presence function takes an already placed offset runs these cases with
frame(startOffsetMs, 16000)/16 ms, as its transcriber passes it; the raw `startOffsetMs`
fails `a-fractional-start-offset-starts-at-the-d55-placement`.
A missing or null `gaps` is unknown. An empty gap (`durationMs` 0, `frames` 0) is no range.
Presence never reads PCM and never uses `droppedFrames`.

`tests/test_gap_ranges.py` checks the oracle against every literal case. It also checks
that presence from the raw offset, or from a half-even, floor or ceil placement, fails a
presence.json or writedown.json literal, and that coalescing ranges, truncating without an overflow marker, storing drops only on the live
span, flagging every gap, or deriving the flag from stored ranges alone each fail at least one
vector, as does counting host writer loss as a gap, keeping a user end after it, padding it on
top of the host time it covers, padding more of it than the host time between the buffers, or
padding a tail loss from the last written frame instead of where it lies. Not covered here (app fault injection): a long gap together with
capture loss or a failed write, where io and capture take precedence.
