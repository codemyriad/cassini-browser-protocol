# D52 wave 1 — draft conformance slice

- `outcomes.json`: hand-written per-source outcomes, including zero PCM,
  never-opened failures and sparse padding. `test_multistream.py` exercises the
  real framed browser fixture, per-source IO/limit/chunk refusals, duplicate
  declarations, overlap rejection, stale Stop and seventy source cycles.
- `lifecycle.json`: literal long-grace/rejoin/unknown-row/healthy-PCM/D49 cases.
  The Python policy is an independent oracle, not production code for either app.
- `ownership.json`: literal half-open D49 and lost/restored seams. Desktop
  adoption must exercise its actual mix/recognition/export path against them.
- `corpus.json`, `make.py`, `speech/`: first-cut production-shaped two-call corpus
  using pinned public LibriSpeech. Includes a late source, sparse presence,
  unequal source-key spans, D49/fallback/restoration, dropped gaps, -35 dB bleed
  and real overlapping speech. Run `python3 make.py DESTINATION` to materialize.
  Gap/presence fields here are fixture hints; P7 production masks remain wave 2.

The materialized-WAV regression checks exact half-open browser/system ownership,
actual lengths, zero-filled gaps, independent files, overlapping voices and the
-35 dB bleed against stored PCM. The initial overlapping fallback spans were
corrected; browser and system sources never own the same interval. Fixture-only
`speechStartMs` retains B's carrier phase through its resumed span, so the mic's
bleed follows the actual remote waveform at both single-voice and overlapping
turns. The latter check independently subtracts the pinned A carrier.

Pending before this PR is ready: remaining
production-shaped shared assertions and a real-browser pass; final generation/
receiver-reuse audit; strict host/schema edge cases; R63 cutoff/shape review.
The local Chromium attempt produced zero ICE candidates before capture started,
so it is not recorded as a browser acceptance pass. Hosted Chromium connects,
but the receiver tone-switch assertion is currently red; its PCM evidence is
retained for diagnosis rather than relaxing the spectral thresholds. No desktop pin changes and
no extension packaging or store upload are part of this draft.
