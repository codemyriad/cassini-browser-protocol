# D58 (R79) classified refusals

Shared vectors for GNOME G13 and Mac M16. The rules are in SPEC.md, "Refusals (D58)", and
SPEC-CONTROL.md, "Result codes". `refusals.py` is an independent oracle that reproduces every
literal case. It is not production code for either app. CI can never produce a real TCC or
device denial, so each app injects the refusals and replays the cases through its own start
path, session writer and Details reader.

## writer.json

`{version: 1, decision, note, cases[], wire[]}`. A case is
`{name, profile?, companion?, request, steps[], expected}`.

- `profile` is `fallback` (GNOME: a rejected browser Start falls back to computer sound) or
  `noFallback` (Mac). A case without `profile` applies to both and has the same result on both.
- `companion` is the browser connection state when the case starts, for example
  `failed/buildMissing`. Setup and connection states are never refusals; the oracle ignores it.
- `request` is `{me, others: "system" | "browser" | false}`. Apps always start with both
  sides, so `me` is always true; cases turn sides off with `select`.

| op | Meaning |
| --- | --- |
| `refuse {atMs, side, code, detail?, message?}` | The side fails to open: no first buffer within 3 s, or the browser Start is refused or unanswered. |
| `select {atMs, me?, others?}` | The user turns a side on or off. |
| `fail {atMs, side}` | An opened side fails mid-call (P10). Never a refusal. |
| `stop {atMs}` | The user stops. |

A `refuse` at atMs 0 refuses a start side. A refused turn-on is a `refuse` immediately after
the `select` that turns that side on, at the same atMs (several sides may follow one select).
A `refuse` with atMs > 0 and no such `select` makes the case invalid. For `others`, a turn-on
refusal names `others` (the system tap) or `browser`.

`expected` is `{folder, othersFrom, state, problemKind, refusals, banner}`. A key left out is
not checked. `refusals: null` means the member is absent. `banner` is null or `{id, refusals}`.
`othersFrom` is the source of the last `othersSource` event if The others is selected at stop,
and null otherwise or without a folder. `state`/`problemKind` are the saved session's; cases
with a `fail` step leave them out, because mid-call loss is platform-specific (P10).

### Rules

1. Each requested side opens at 0 and receives audio until `stop`, unless a `refuse` or `fail`
   step names it.
2. A refused side records nothing and gets no track. A refused turn-on leaves the selection
   unchanged and writes no `selection` event.
3. Browser refusals at start:
   - `startRejected` with detail `busy`: no fallback, on both profiles. Nothing opens.
   - Other `startRejected`: on `fallback`, The others come from `system` (othersSource
     system/missing) and Me is kept. On `noFallback`, no side opens.
   - `startFailed`: no side opens on either profile.
4. A folder exists if and only if at least one side opens. Without a folder, `banner.id` is
   `errors.recordFailed.line` and `banner.refusals` lists the refusals in step order. With a
   folder, `banner` is null.
5. Stored `refusals` are the `refuse` steps in step order, with only the fields given, in the
   order atMs, side, code, detail, message. `detail` is kept only if it matches
   `^[A-Za-z]{1,32}$` as a whole string. `message` is cut to its first 200 Unicode code points
   (not bytes, UTF-16 units or graphemes). The cap is 16: when the list is full, each newer
   refusal replaces the 16th entry, keeping the first 15 plus the latest. The member is absent
   when the list is empty.
6. `state` and `problemKind` ignore refusals, as do `problem`, the `end` reason, `othersSource`
   and `captureOutcome`. If every opened side records until stop, the result is
   `completed`/null.
7. Checked by each app, not by the oracle: `recordingDetails.captureRecord.refusals` deep-equals
   the session list, and is present even without `captureOutcome` (with `sources: []`).

`wire` cases turn an `ok:false` Start result into the browser refusal it records (the app adds
`atMs`): `code` startRejected, `detail` the result `code` if it matches the pattern as a whole
string (known or not), `message` the result `error` cut as above. A result without a valid
`code` still records `startRejected`, without `detail`.

## readers.json

`{version: 1, readers[]}`. A reader case is `{name, stored, sources?, notSelected?, expectedLines}`.
`stored` is the session or captureRecord `refusals` value as read; `sources` are the
captureRecord source rows (default none); `notSelected` lists the sides for which the reader
would print `details.sources.notSelected`. `expectedLines` lists, in order, the Audio sources
lines that follow the source rows, which render as today and are not listed:

1. One line per shown refusal, in stored order: `details.sources.refused.<code>` for
   permissionDenied, deviceUnavailable and startRejected, and `details.sources.failed` for any
   other code. `{source}` is filled by side: me → `details.source.microphone`, others →
   `details.source.system`, browser → `details.source.browser`.
2. `details.sources.notSelected` for each listed side without a refusal line.
3. `details.sources.empty` only when there are no source rows and no refusal lines.

Reading is lenient: a `refusals` value that is not a list is ignored as a whole; an entry that
is not an object, or whose `side` or `code` is not a string, is skipped; an unknown side is not
shown; `detail` and unknown members never change the lines. Everything stays in Copy details.

`tests/test_refusals.py` checks the oracle against every literal case and validates every
expected stored and banner list against `schemas/session.schema.json`. It also checks that each
of these mutations fails at least one case: a refusal written for a `fail`; a folder kept when
nothing opened; a refusal that changes `state`; `message` dropped, not cut, or cut at UTF-16
units, UTF-8 bytes or graphemes; a `noFallback` fallback; a fallback after `startFailed` or
`startRejected/busy`; the cap dropping the latest entry, keeping the last 16, or missing; a
refused turn-on that changes the selection; a malformed or newline-terminated result `code`
kept; `notSelected` or `empty` printed next to a refusal line; an unknown side shown; an
unknown code without a line. The `resume` op and `resumeRefused` vectors come with #169.
