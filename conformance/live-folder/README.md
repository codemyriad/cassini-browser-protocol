# Live folder oracle (shared test 2, D68)

One scenario, run by the shared driver against each app's real writer, and one
oracle that checks the folder the app wrote. The coordinator owns `check.py`,
its constants and bands (D68 item 8): apps never loosen them in their own PRs,
and bands only tighten from at least 10 measured runs.

```
python3 -I conformance/live-folder/check.py check FOLDER --evidence evidence.json --out result.json
python3 -I conformance/live-folder/check.py compare GNOME.result.json MAC.result.json
python3 conformance/live-folder/make.py OUT                 # synthetic passing run
python3 conformance/live-folder/make.py --mutant NAME OUT   # one named defect
python3 conformance/live-folder/make.py --variant NAME OUT  # another correct writer form
python3 conformance/live-folder/make.py --all OUT           # OUT/base/, every mutant and variant
```

`check` prints one JSON line per check `{id, pass, measured}` (each rule's value
under `measured`), writes the full result, and exits 1 when a check fails, 2 when
the folder or evidence is unusable. Run it after Stop and before the app quits or
compacts the folder. Stdlib only, Python 3.9+ (`/usr/bin/python3` on macOS); the
JSON Schema step runs only where jsonschema is importable and `O0.schema` says
`validated` or `unavailable`.

## Files

- `scenario.json`: the constants, the slot topology, the driver's wait bounds and
  the `evidence.json` contract. `LATE_REMOTE_MS`, `BLEED_DB`, `SPAN_RATIO_MIN` and
  `SPARSE_DENSITY_MAX` are read from `../multistream/corpus.json`, never copied.
- `check.py`: the oracle. It reuses `validate`/`bounds`, `state_at`, `placed_ms` and
  `others_presence` from `../check-session-events.py`, `presence` from
  `../gaps/gaps.py` and the Goertzel reader in `../pcm.py` (shared with `summarize.py`).
- `make.py`: the synthetic run and its mutants; `materialized.sha256` pins every byte
  of `make.py --all` (identical on Linux and macOS Python 3.9).
- `tests/test_live_folder_oracle.py`: the self-test.

## Truth sources

The evidence brackets (`actions.<name>.{requestedAtMs, observedAtMs}` on the session
timeline), the scenario constants and PCM the oracle measures itself. App readers are
never consulted. A track's extent starts at its D55 placement and lasts frames/rate;
GNOME's RotatingWAV `spans` rows are read piece by piece, never WAV length alone.

Roles come from PCM: a remote `sourceTrackId` is A (or B) when the first PROOF_MS of
its earliest span carries tone A, 1540 Hz (or B, 2090 Hz) above SILENT_DBFS and above
the other tone. A tone level is the Goertzel peak level in dBFS; RMS is over all
samples. SLACK is ACTION_SLACK_MS; a bracket check is
`requested <= t <= observed + SLACK`, with `requested - SLACK` as lower bound where
the time comes from an audio clock (span starts and ends, the last frame, none/lost).
"Starts at an event" means the span's D55 placement is within one 16 kHz session
sample (1/16 ms) of the event's placed `atMs`: both writers store the event's
fractional `atMs` as the start, and a raw comparison would fail half the runs.

The mute window W comes from the evidence, so O2 first holds it to the scenario: the
folder clock never runs ahead of the session clock (a frame is written after it is
captured), so the driver's waits on F(A) bound the requests themselves. O2.silent then
shows at least MUTE_MS − 2 × EDGE_MS of silence in A's one span, measured in PCM.

## Checks

| rule | passes when |
|---|---|
| O0.schema | session.schema.json validates (where jsonschema is importable) |
| O0.bounds | `bounds()`: S-6 event order, restored/callConnected legality, `end` after every finalized track end, source ID bytes |
| O0.files | every track's WAVs (its `spans` rows, else the track) are safe regular files in the folder, PCM16 with the track's rate and channels, header frames = row frames, size = 44 + frames × channels × 2; the rows sum to the track's frames |
| O0.ended | every track has `ended: true` |
| O0.offsets | every start is known and `endOffsetMs = startOffsetMs + frames/rate × 1000` (±0.001 ms) |
| O0.oneFolder | evidence `newFolders` is exactly this folder, named `Recording-<id>` |
| O0.unique | no track id repeats, and no WAV belongs to two tracks or twice to one (SPEC S-6: each span its own id and WAV); stdlib, so it holds where O0.schema is unavailable |
| O0.kinds | track kinds ⊆ {remote, microphone, system} |
| O0.state | `completed`, no problem, no problemKind (D68 item 5) |
| O0.end | the last event is `end` with reason `user` |
| O1.oneKey | exactly one B key |
| O1.late | B's first span starts at or after LATE_REMOTE_MS |
| O1.bracket | ... and inside the lateRemote bracket ± SLACK |
| O1.bleed | there, tone A − tone B ≤ BLEED_DB |
| O2.muteStart | MUTE_START_MS ≤ mute.requested ≤ meOff.observed + MUTE_START_MS + `boundsMs.record` + SLACK (the driver's wait for F(A) ≥ MUTE_START_MS and its bound) |
| O2.duration | MUTE_MS ≤ unmute.requested − mute.requested ≤ mute.observed + `boundsMs.muteHold` + SLACK − mute.requested (the driver's hold until F(A) ≥ mute.requested + MUTE_MS, and its bound) |
| O2.oneSpan | with W = [mute.requested, unmute.requested]: one A span covers W and no other A span touches it |
| O2.gaps | A's gap ranges in W: none ≥ 1000 ms, total ≤ MUTE_JITTER_MS, no overflow marker before W ends |
| O2.silent | A's RMS over [W₀ + EDGE_MS, W₁ − EDGE_MS] ≤ SILENT_DBFS |
| O2.toneEdges | tone A above SILENT_DBFS over [W₀ − 1000, W₀] and [W₁ + EDGE_MS, W₁ + EDGE_MS + 1000] |
| O2.noEvents | no `othersSource` event and no `refusals` entry inside W |
| O2.present | `others_presence()` and A's own `gaps.presence()` each leave ≤ MUTE_JITTER_MS of W uncovered |
| O2.outcome | A's `captureOutcome.sources` row is `captured` |
| O3.sequence | the `othersSource` sequence, with a none/lost directly followed by system/lost folded into it, is exactly browser/start, system/lost, browser/restored, and any such none/lost is inside the kill bracket ± SLACK (SPEC S-6: Mac writes none/lost at the loss, GNOME keeps its source until the fallback commits) |
| O3.lost | exactly one system/lost inside the kill bracket |
| O3.restored | exactly one browser/restored after it, within RESUME_BOUND_MS of it and by restore.observed + SLACK |
| O3.state | `state_at()` is system halfway between them, browser at restored and at the last frame |
| O3.spans | A and B each have exactly one span starting before kill.requested and one starting after it (D68 items 1-2: one unbroken span, one resume) |
| O3.lossAbsent | the last present instant (extents minus gaps) of A's and of B's pre-kill span is inside the kill bracket ± SLACK: the Others are absent over the loss, never zero-filled (SPEC S-6) |
| O3.noOverlap | no two spans of one key overlap |
| O3.labels | all spans of a key carry one label (no "(resumed)") |
| O3.resumedStart | A and B each have a span starting after kill.requested, and every such span starts at or after lost |
| O3.resumedTone | each of those carries its tone in its first PROOF_MS |
| O3.system | exactly one system track; it starts at lost (SPEC S-6) and ends within EDGE_MS of restored |
| O3.refusals | no `startRejected` refusal and no `resumeRefused` detail |
| O4.keys | every remote track has a `sourceTrackId`, and there are exactly 2 |
| O4.outcomeRows | exactly 2 `captureOutcome.sources` rows, one per key, each listing exactly that key's track ids, both `captured` (so no `neverAudio`) |
| O4.evidence | `maxSourceCount` 3, slot C `connected` with 0 packets received |
| O5.selection | the last selection is me:true others:true reason user at M ≥ MIC_ON_MS inside the meOn bracket; the one before has me:false (a user one inside the meOff bracket) |
| O5.micOff | no microphone extent starting before M intersects (meOff + SLACK, M) |
| O5.micOn | one microphone span starts at M (SPEC S-6, D52.2: a late first buffer is a prefix gap) and lasts at least PROOF_MS |
| O5.micAudio | that span has ≥ 32 non-zero 32 ms frames (D56) and the evidence's microphone tone above SILENT_DBFS in [M, M + PROOF_MS] |
| O6.clockMethod | every remote span has `clockMethod` outputTimestamp or roundTrip (D61) |
| O6.lastFrame | the last frame's end is inside the stop bracket ± SLACK |
| O7.late | B's first span starts at or after LATE_REMOTE_MS (corpus R1) |
| O7.spanRatio | A's longest span ≥ SPAN_RATIO_MIN × its shortest (R3) |
| O7.density | the share of A's first span's 100 ms blocks above SILENT_DBFS is below SPARSE_DENSITY_MAX (R2) |

O7 measures density from PCM: per SPEC a muted sender's zeros are present audio, so
the span's presence density is 100% and only its audible density is sparse.

## The synthetic run

8 kHz; remote and system tracks stereo, microphone mono. Times in session ms.

| track | key | start | end | content |
|---|---|---|---|---|
| span-a1 | A | 251.0625 | 95350.0625 | tone A, zeros 5450.0625–66250.0625 (the mute), tone A |
| microphone-1 | | 0 | 2100 | 660 Hz |
| span-b1 | B | 68637.25 | 95350 | tone B |
| microphone-2 | | 90250 | 109625 | 50 ms prefix gap, then 660 Hz |
| system-1 | | 95912.5 | 99500 | tone A + tone B (the tab's mix) |
| span-a2 | A | 99300.5 | 109625 | tone A (starts before restored, after lost) |
| span-b2 | B | 99310.125 | 109625 | tone B |

Events: browser/start and selection start at 0, me off at 2100, me on at 90250,
system/lost at 95912.5, browser/restored at 99500, end/user at 109625. Brackets:
record −180/1350, meOff 2000/2700, mute 5310/5320, unmute 66050/68320, lateRemote
68400/70950, meOn 90200/92650, kill 95300/96680, restore 96680/102380, stop 109500/110310.

## Mutants

Each must fail exactly these rules, no more and no fewer. Together with the
evidence cases in the test, every rule is shown failing at least once, so a rule
that always passes turns the self-test red. Without jsonschema (macOS
`/usr/bin/python3`) O0.schema passes as unavailable and the rest is unchanged.

| mutant | defect | fails exactly |
|---|---|---|
| drop-restored | no browser/restored | O3.restored, O3.sequence, O3.state, O3.system |
| mute-gap | a 2 s jump gap in the mute | O2.gaps, O2.present |
| split-mute | A split into two spans during the mute | O2.oneSpan, O3.spans |
| lost-in-mute | a system/lost at 35 s | O2.noEvents, O3.sequence |
| b-early | B from 20 s to the kill | O1.late, O1.bracket, O7.late |
| silent-remote | a third, silent remote track (and its row) | O4.keys, O4.outcomeRows |
| never-audio-row | a `neverAudio` row for slot C | O4.outcomeRows |
| selection-at-60s | the me:true selection at 60 s | O5.selection, O5.micOn, O5.micAudio |
| mic-from-zero | one microphone track from 0 to the end | O5.micOff, O5.micOn, O5.micAudio |
| overlap-same-key | A's resumed span starts inside its first | O3.noOverlap, O3.spans, O3.lossAbsent, O3.resumedStart, O3.resumedTone |
| resumed-new-key | A's resumed span under a new key (and row) | O3.spans, O3.resumedStart, O3.resumedTone, O4.keys, O4.outcomeRows, O7.spanRatio |
| resumed-label | "(resumed)" in A's resumed label | O3.labels |
| end-before-track | `end.atMs` before a track's end | O0.bounds |
| no-clock-method | B's first span without `clockMethod` | O6.clockMethod |
| short-wav | microphone-1's WAV 100 ms shorter than its frames | O0.files |
| wrong-end-offset | microphone-1's endOffsetMs 5 ms late | O0.offsets |
| local-kind | microphone-1 written as kind `local` | O0.kinds |
| duplicate-track-id | A's resumed span reuses id span-a1 (own WAV) | O0.unique, O0.schema |
| interrupted | state interrupted, problemKind gap | O0.state |
| open-track | span-b2 `ended: false` | O0.ended |
| call-ended | end reason callEnded | O0.end |
| b-resumed-new-key | B's resumed span under a new key (and row) | O1.oneKey, O3.spans, O3.resumedStart, O3.resumedTone, O4.keys, O4.outcomeRows |
| bleed | tone A at −24 dBFS in B's first 2 s | O1.bleed |
| tone-in-mute | A keeps its tone through the mute | O2.silent, O7.density |
| no-edge-tone | A's tone returns 2.2 s after unmute | O2.toneEdges |
| low-audio-a | A's row `lowAudio` | O2.outcome, O4.outcomeRows |
| resume-refused | a `resumeRefused` refusal | O3.refusals |
| zero-filled-loss | A's and B's pre-kill spans run on in zeros to their resumed spans | O3.lossAbsent |
| split-after-unmute | A split at 70 s, after the mute | O3.spans |
| system-before-lost | the system track starts 900 ms before lost | O3.system |
| system-never-ends | the system track runs on to Stop | O3.system |
| mic-late-no-prefix | microphone-2 starts 400 ms after M, no prefix gap | O5.micOn, O5.micAudio |
| short-mute | the mute held 50.74 s (unmute asked at 56050), A's tone back as early | O2.duration |
| early-mute | the mute asked at 2810, before F(A) can reach MUTE_START_MS, held a full MUTE_MS | O2.muteStart |

## Variants

Other forms a correct writer produces; each must pass every check and `compare`
equal to the base.

| variant | form |
|---|---|
| fractional-mic | M = 90250.02 (wall clock), microphone-2 starts there: its D55 placement is 90250.0, below M |
| mac-loss-form | none/lost at 95400 (the transport loss), then system/lost when the fallback commits |

## compare

`compare` refuses (exit 2) unless both results name the same `protocolCommit` and
`extensionVersion`. It fails (exit 1) unless both results pass, every categorical
fact is identical (othersSource with none/lost folded as in O3.sequence, the
written sequence kept under `written`; selection sequences, state, problemKind, end
reason, remote source count, span counts per role, outcomes per role) and every
numeric fact (B's start, lost, restored, M, restored − lost) differs by at most
1000 ms.
