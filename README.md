# Cassini browser recording protocol

I want to record online meetings with each participant on their own audio track. The
only place where those tracks still exist separately is inside the browser: once the
audio reaches the speakers it is one mix, and the operating system cannot tell who said
what. So the recording has to start in the browser.

This repository is the code that does that, shared between
[Cassini for GNOME](https://github.com/codemyriad/cassini-gnome) and
[Cassini for Mac](https://github.com/codemyriad/cassini-mac) (Windows later, I hope).
Each app has its own native recorder, written in Python and Swift respectively. What they
have in common is the browser side, and the agreement on how browser and recorder talk to
each other. That common part lives here, so there is one copy of it instead of two
drifting ones.

## how it works

* `extension/` is a Chromium extension (Manifest V3). On a meeting page it hooks
  `RTCPeerConnection` early, finds the audio tracks the page sends and receives, and
  turns each one into timestamped PCM with an `AudioWorklet`. When the page hides its
  tracks it falls back to recording the whole tab through
  [`chrome.tabCapture`](https://developer.chrome.com/docs/extensions/reference/api/tabCapture).
* The extension streams that audio to a small local program through
  [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
  (length-prefixed JSON on stdin/stdout, nothing on the network). Each app ships its own
  such program; both answer to the name `com.codemyriad.cassini`.
* `SPEC.md` is the contract between the two: the messages, their types and limits, how
  timestamps and gaps are handled, and the on-disk result (a folder with one WAV per source
  and a `session.json`). `schemas/` holds the same thing as JSON Schema.
* `conformance/` is how I keep the two implementations honest. `vectors.json` is a list of
  raw request sequences with the responses and files each one must produce; `run.py` pipes
  them into any host executable. If a host passes the vectors, the extension will work
  with it. Error messages are deliberately not part of the contract, only error codes.
* `scenarios/` has the audio helpers the browser tests in both apps share (tone
  generation, Goertzel power, silence scanning), so a test that proves "the 880 Hz source
  did not bleed into the 440 Hz one" reads the same on both platforms.

A few things that are easy to get wrong, and that the spec and vectors pin down: a track is
a source, not a person (Google Meet, for one, multiplexes speakers over three receiver
slots); timestamps come from the audio render clock, not from when a message arrived;
a recording that gets interrupted must still leave playable files behind.

## how the apps use it

Each app vendors this repository at a pinned commit under `browser-protocol/` and keeps its
installed extension byte-identical to `extension/`. `verify.py` checks that:

```sh
python3 browser-protocol/verify.py BrowserExtension     # Mac
python3 browser-protocol/verify.py browser-extension    # GNOME
```

To run the vectors against a host:

```sh
python3 conformance/run.py /absolute/path/to/native-host
```

The host must speak native-messaging stdio and answer `start` with the folder it created.
The runner removes only folders it caused to exist; on failure it keeps them and prints
their paths. The unit tests for the extension's worklet and clock calibration are plain
Node:

```sh
node --test extension/tests/*.test.cjs
```

Browser-level tests (real Chromium, real WebRTC, real native messaging) live in each app
for now, because launching a browser with an extension and an audio device is where the
platforms differ. `TESTING.md` describes the layers and what each one does and does not
prove.

## changing things

Changes to the protocol, the schemas, the vectors or the extension land here first, with a
vector for any new rule. Then each app bumps its pinned commit. A host change that makes a
vector fail is a protocol change, not a bug fix, and gets discussed as one. The wire
version stays at 1 as long as additions are optional and old hosts keep working; `SPEC.md`
has the changelog.

Most of this code was written by coding agents (one per app, plus a reviewer), with me
steering and reading, not proof-reading every line. The vectors and the browser tests are
what I trust, more than my reading of the code. If you find a gap in them I'd honestly
like to know.
