# Placement golden (shared test 9, D55)

One set of tone-burst folders; GNOME and Mac must both land every burst where
D55 says, in every consumer: within 20 ms everywhere, and exactly (to the
sample) wherever no resampler is involved. Each app is checked against the
oracle here, never against the other app.

```
python3 conformance/placement/make.py OUT        # three Recording-<id>/ folders
python3 conformance/placement/placement.py check RESULTS.json
python3 conformance/placement/placement.py compare GNOME.json MAC.json
```

## Files

- `bursts.json`: the sessions (inputs to `make.py`) and, under `expected`, every
  burst's position per consumer. `expected` must equal `placement.py expected`.
- `placement.json`: hand-computed D55 literals for the placement function itself.
- `placement.py`: the oracle, the shared onset detector, `check` and `compare`.
- `make.py`: stdlib only, integer samples; `materialized.sha256` pins its bytes
  on Linux and macOS.
- `tests/test_placement.py`: literals, mutants, digests, WAV read-back, checker.

## The folders

Every burst is 250 ms of a 1 kHz square wave of +-8000 starting with +8000;
everything else is exactly 0, so a burst's onset is its first non-zero sample.
Each track is 12 s with six bursts 2000 ms apart (not D56-silent). Bursts of
one session never overlap in session time, so a mix can be measured too.

| session | source | track | rate | channels | startOffsetMs | bursts at (local ms) |
|---|---|---|---|---|---|---|
| A `…0001` | gnome | microphone | 48000 | 1 | 0 | 500, 2500, … 10500 |
| | | system | 48000 | 2 | 1234.5104 | 0, 2000, … 10000 |
| B `…0002` | macos | microphone | 16000 | 1 | 1000.09375 | 0, 2000, … 10000 |
| | | system | 48000 | 2 | 31999.96875 | 1000, 3000, … 11000 |
| C `…0003` | gnome | microphone | 48000 | 1 | 0 | 500, 2500, … 10500 |
| | | system | 48000 | 1 | null | 1500, 3500, … 11500 |

The offsets separate every rounding seen so far: 59256.4992 frames (ns-then-ceil
gives one more), and exact half frames at 16 and 48 kHz (floor and half-even
give one less). B is a Mac-written native session read by GNOME, A and C the
other way round. C's system offset is unknown: transcription and export place
it at an assumed 0 and set `offsetsAssumedZero` (D55 M9, D19); playback refuses.
Any new offset must be exactly on a half frame or at least 1e-6 frame from it at
16 and 48 kHz, so binary doubles round it the same way everywhere.

## What each app measures

D55: frame = offsetMs * rate / 1000, rounded half away from zero, at each
consumer's rate. A burst at local ms `t` of a track at `offset` is expected at:

| leg | what the app measures | expected | exact tier |
|---|---|---|---|
| `placement` | its one placement function on every `placement.json` case | the literal | equal |
| `rec16` | the 16 kHz recognizer input, as placed on the session timeline | placement(offset, 16000) + 16 t | 0 samples (16 kHz track), 1 (48 kHz track, shared FIR) |
| `wordMs` | its production word-time function for a word starting at the burst's 16 kHz sample | floor(rec16 * 1000 / 16000) | equal |
| `mix48` | the 48 kHz export mix before encoding | placement(offset, 48000) + 48 t | 0 (48 kHz track); 20 ms (16 kHz track, resampled) |
| `playback` | folder playback, as frames at the track's rate | placement(offset, rate) + t * rate / 1000, or `refused` | 0 (48 kHz); 20 ms (16 kHz) |
| `opus48` (optional) | the published Opus mix, decoded at 48 kHz | as `mix48` | 20 ms |

Every leg must also be within 20 ms (the headline). Find each burst with the
shared detector (`placement.onset`): in [e - 0.05 R, e + 0.2 R) of the
expected sample e at the stream's rate R, average stereo to mono, and take the
first sample whose magnitude reaches half the window's peak. On a stream that
was not resampled this is the first non-zero sample. A burst not found is
`null`, which fails.

## Results file

Each app writes one file and runs `placement.py check` on it (or the same
comparison in its own test). Keys are `<session id>/<track id>`; lists hold
one value per burst, in order.

```json
{
  "vector": "placement-v1",
  "protocolCommit": "<the vendored commit>",
  "app": "gnome",
  "legs": {
    "placement": [[0, 16000, 0], [0, 48000, 0], [1234.5104, 16000, 19752]],
    "rec16": {"09000000-0000-4000-8000-000000000001/system": [19752, 51752, 83752, 115752, 147752, 179752]},
    "playback": {"09000000-0000-4000-8000-000000000003/system": "refused"}
  }
}
```

`placement` lists every `placement.json` case in order as `[ms, rate, frame]`.
`compare` prints each burst where two apps' files differ, for coordinator QA.

## Not covered (v1)

The published mix of a meeting with an unknown offset (GNOME plays it, Mac
refuses it; R87 Q6), and recognition through the real VAD: tones are not speech,
so word times are checked through the word-time function, not through Silero.
