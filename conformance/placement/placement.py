#!/usr/bin/env python3
"""Independent oracle for the placement golden (shared test 9, D55).

    placement.py expected            print what bursts.json's "expected" must be
    placement.py check RESULTS.json  check one app's results against bursts.json
    placement.py compare A.json B.json   per-burst deltas between two apps

D55: a track that starts at offsetMs is placed at frame
offsetMs * rate / 1000 rounded half away from zero, at each consumer's rate:
16 kHz for recognition, 48 kHz for the export mix, the track's own rate for
playback. Transcription and export place an unknown (null) offset at an
assumed 0 and flag it; playback refuses it (D19). Arithmetic here is exact
(Fraction of the offset's binary double, the value every app parses).
"""
import argparse
from fractions import Fraction
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
HEADLINE_MS = 20
LEGS = ('rec16', 'wordMs', 'mix48', 'playback')  # required in every app's results
OPTIONAL = ('opus48',)


def frame(ms, rate):
    """D55: ms * rate / 1000, rounded half away from zero (ms >= 0)."""
    x = Fraction(ms) * rate / 1000
    whole = math.floor(x)
    return whole + (x - whole >= Fraction(1, 2))


def expected(golden):
    """Every burst's expected position per leg, from the sessions alone."""
    out = {}
    for session in golden['sessions']:
        for track in session['tracks']:
            rate, offset = track['sampleRate'], track['startOffsetMs']
            assumed = offset is None
            at = 0 if assumed else offset
            local = track['burstsMs']
            rec16 = [frame(at, 16000) + ms * 16 for ms in local]
            entry = {
                'offsetsAssumedZero': assumed,
                # A 48 kHz track reaches the recognizer through the shared FIR: one sample of slack.
                'rec16': {'tolerance': 0 if rate == 16000 else 1, 'frames': rec16},
                'wordMs': {'tolerance': 0, 'values': [f * 1000 // 16000 for f in rec16]},
                # A 16 kHz track is resampled into the 48 kHz mix: only the headline holds.
                'mix48': {'tolerance': 0 if rate == 48000 else 48 * HEADLINE_MS,
                          'frames': [frame(at, 48000) + ms * 48 for ms in local]},
                'playback': 'refused' if assumed else {
                    'rate': rate, 'tolerance': 0 if rate == 48000 else rate * HEADLINE_MS // 1000,
                    'frames': [frame(at, rate) + ms * rate // 1000 for ms in local]},
                'opus48': {'tolerance': 48 * HEADLINE_MS, 'frames': [frame(at, 48000) + ms * 48 for ms in local]},
            }
            out[f"{session['id']}/{track['id']}"] = entry
    return out


def onset(stream, rate, at):
    """The shared onset detector. stream is mono (stereo averaged), at the
    expected sample: in [at - 0.05 rate, at + 0.2 rate), the first sample whose
    magnitude reaches half the window's peak; None if the window is silent."""
    lo, hi = max(0, at - rate // 20), min(len(stream), at + rate // 5)
    peak = max((abs(v) for v in stream[lo:hi]), default=0)
    if not peak:
        return None
    return next(n for n in range(lo, hi) if 2 * abs(stream[n]) >= peak)


def problems(results, golden=None):
    """What an app's results file gets wrong; empty when it passes."""
    golden = golden or json.loads((ROOT / 'bursts.json').read_text())
    literals = json.loads((ROOT / 'placement.json').read_text())['cases']
    found = []
    if results.get('vector') != golden['vector']:
        found.append(f"vector is {results.get('vector')!r}, not {golden['vector']!r}")
    legs = results.get('legs', {})
    cases = [(c['ms'], c['rate'], c['frame']) for c in literals]
    got = [tuple(c) for c in legs.get('placement', [])]
    if [c[:2] for c in got] != [c[:2] for c in cases]:
        found.append('placement: the results do not list placement.json cases in order')
    else:
        found += [f'placement: {ms} ms at {rate} Hz is frame {f}, not {want}'
                  for (ms, rate, f), (_, _, want) in zip(got, cases) if f != want]
    for leg in LEGS + OPTIONAL:
        if leg not in legs:
            if leg in LEGS:
                found.append(f'{leg}: missing')
            continue
        for key, entry in golden['expected'].items():
            want, have = entry[leg], legs[leg].get(key)
            if want == 'refused' or have == 'refused':
                if want != have:
                    found.append(f'{leg} {key}: {have!r}, not {want!r}')
                continue
            values = want.get('frames', want.get('values'))
            if not isinstance(have, list) or len(have) != len(values):
                found.append(f'{leg} {key}: expected {len(values)} bursts, got {have!r}')
                continue
            rate = 1000 if leg == 'wordMs' else want.get('rate', 16000 if leg == 'rec16' else 48000)
            for index, (f, w) in enumerate(zip(have, values)):
                if f is None:
                    found.append(f'{leg} {key} burst {index}: not found')
                elif abs(f - w) * 1000 > HEADLINE_MS * rate:
                    found.append(f'{leg} {key} burst {index}: {f}, more than {HEADLINE_MS} ms from {w}')
                elif abs(f - w) > want['tolerance']:
                    found.append(f"{leg} {key} burst {index}: {f}, not {w} (exact tier, +-{want['tolerance']})")
    return found


def compare(a, b):
    """Per-burst differences between two apps' results (coordinator QA)."""
    lines = []
    for leg in sorted(set(a.get('legs', {})) | set(b.get('legs', {}))):
        left, right = a['legs'].get(leg), b['legs'].get(leg)
        if leg == 'placement' or left is None or right is None:
            if left != right:
                lines.append(f"{leg}: {a.get('app')} {left!r} vs {b.get('app')} {right!r}")
            continue
        for key in sorted(set(left) | set(right)):
            if left.get(key) != right.get(key):
                lines.append(f"{leg} {key}: {a.get('app')} {left.get(key)!r} vs {b.get('app')} {right.get(key)!r}")
    return lines


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('expected')
    check = sub.add_parser('check')
    check.add_argument('results', type=Path)
    pair = sub.add_parser('compare')
    pair.add_argument('a', type=Path)
    pair.add_argument('b', type=Path)
    args = parser.parse_args(argv)
    if args.command == 'expected':
        print(json.dumps(expected(json.loads((ROOT / 'bursts.json').read_text())), indent=2))
        return 0
    if args.command == 'check':
        found = problems(json.loads(args.results.read_text()))
        print('\n'.join(found) or f'{args.results}: every burst placed as D55 says')
        return 1 if found else 0
    lines = compare(json.loads(args.a.read_text()), json.loads(args.b.read_text()))
    print('\n'.join(lines) or 'identical')
    return 1 if lines else 0


if __name__ == '__main__':
    sys.exit(main())
