#!/usr/bin/env python3
"""Materialize the live-folder oracle's synthetic run (shared test 2) and its mutants.

    python3 conformance/live-folder/make.py OUT                 # OUT/Recording-<id>/, OUT/evidence.json
    python3 conformance/live-folder/make.py --mutant NAME OUT   # one named defect (MUTANTS below)
    python3 conformance/live-folder/make.py --all OUT           # OUT/base/ and OUT/<mutant>/ for each mutant

The base folder is what a correct writer produces for the scenario: 8 kHz,
about 110 s, A muted for 60 s, B late, Me off then on, a forced resume with a
system fallback in between, then Stop. Each mutant changes that run in one way
and must fail exactly its listed checks in check.py (tests/test_live_folder_oracle.py).

Tones are integer sine tables computed with Decimal (no platform libm), stereo
tracks carry the same samples on both channels, and JSON floats are exact
binary values: Linux and macOS write identical bytes (materialized.sha256).
"""
import argparse
from array import array
import copy
from decimal import Decimal, ROUND_HALF_EVEN, localcontext
from fractions import Fraction
import json
from math import gcd
from pathlib import Path
import sys
import wave

HERE = Path(__file__).resolve().parent
SCENARIO = json.loads((HERE / 'scenario.json').read_text())
RATE = 8000
SESSION = '02000000-0000-4000-8000-000000000002'
A_KEY, B_KEY, C_KEY, NEW_KEY = 'doc-1:source:1', 'doc-1:source:2', 'doc-1:source:3', 'doc-1:source:4'
TONE_A = ((SCENARIO['constants']['TONE_A_HZ'], 8000),)
TONE_B = ((SCENARIO['constants']['TONE_B_HZ'], 8000),)
MIC_HZ = 660
MIC = ((MIC_HZ, 6000),)
SYSTEM = ((TONE_A[0][0], 4000), (TONE_B[0][0], 4000))  # the sink monitor carries the tab's mix
PI = Decimal('3.14159265358979323846264338327950288419716939937510')
ACTIONS = {
    'record': [-180, 1350], 'meOff': [2000, 2700], 'mute': [5310, 5320], 'unmute': [66050, 68320],
    'lateRemote': [68400, 70950], 'meOn': [90200, 92650], 'kill': [95300, 96680],
    'restore': [96680, 102380], 'stop': [109500, 110310],
}
END_MS = 109625


def _sin(x):
    """sin(x) for |x| <= pi, Taylor series in 40-digit Decimal."""
    with localcontext() as context:
        context.prec = 40
        term = total = x
        n = 1
        while abs(term) > Decimal('1e-35'):
            term = -term * x * x / ((2 * n) * (2 * n + 1))
            total += term
            n += 1
        return total


_TABLES = {}


def table(hz, amplitude):
    """One period of round(amplitude * sin(2 pi hz i / RATE)), half-even, as PCM16."""
    if (hz, amplitude) not in _TABLES:
        period = RATE // gcd(RATE, hz)
        values = array('h')
        for i in range(period):
            step = i * hz % RATE
            angle = 2 * PI * step / RATE
            if angle > PI:
                angle -= 2 * PI
            values.append(int((amplitude * _sin(angle)).quantize(Decimal(1), rounding=ROUND_HALF_EVEN)))
        _TABLES[hz, amplitude] = values
    return _TABLES[hz, amplitude]


def frames(start, end):
    """Exact frame count between two session ms values on the RATE grid."""
    count = (Fraction(end) - Fraction(start)) * RATE / 1000
    assert count.denominator == 1 and count >= 0, (start, end)
    return int(count)


def remote(identifier, key, label, start, count, content):
    return dict(id=identifier, label=label, kind='remote', channels=2, startOffsetMs=start, frames=count,
                content=content, sourceTrackId=key, extra=dict(labelSource='browser', clockMethod='outputTimestamp',
                                                               clockUncertaintyMs=2))


def native(identifier, label, kind, channels, start, count, content, gaps=()):
    return dict(id=identifier, label=label, kind=kind, channels=channels, startOffsetMs=start, frames=count,
                content=content, gaps=list(gaps), extra=dict(labelSource='device'))


def base():
    """The passing run: (session fields, track plans, evidence)."""
    a1, b1 = 251.0625, 68637.25
    a2, b2 = 99300.5, 99310.125
    tracks = [
        remote('span-a1', A_KEY, 'remote: participant-a', a1, frames(a1, 95350.0625), [
            (0, frames(a1, 5450.0625), TONE_A),  # the tone outlives the request by the jitter buffer
            (frames(a1, 66250.0625), frames(a1, 95350.0625), TONE_A)]),
        native('microphone-1', 'Microphone', 'microphone', 1, 0, frames(0, 2100), [(0, frames(0, 2100), MIC)]),
        remote('span-b1', B_KEY, 'remote: participant-b', b1, frames(b1, 95350), [(0, frames(b1, 95350), TONE_B)]),
        native('microphone-2', 'Microphone', 'microphone', 1, 90250, frames(90250, END_MS),
               [(400, frames(90250, END_MS), MIC)],
               [dict(atMs=90250, durationMs=50, frames=400, kind='prefix')]),
        native('system-1', 'Computer sound', 'system', 2, 95912.5, frames(95912.5, 99500),
               [(0, frames(95912.5, 99500), SYSTEM)]),
        remote('span-a2', A_KEY, 'remote: participant-a', a2, frames(a2, END_MS), [(0, frames(a2, END_MS), TONE_A)]),
        remote('span-b2', B_KEY, 'remote: participant-b', b2, frames(b2, END_MS), [(0, frames(b2, END_MS), TONE_B)]),
    ]
    session = dict(version=1, id=SESSION, createdAt='2026-11-04T12:00:00Z', title='Live folder oracle',
                   source='chromium', state='completed', events=[
                       dict(atMs=0, type='othersSource', source='browser', reason='start'),
                       dict(atMs=0, type='selection', me=True, others=True, reason='start'),
                       dict(atMs=2100, type='selection', me=False, others=True, reason='user'),
                       dict(atMs=90250, type='selection', me=True, others=True, reason='user'),
                       dict(atMs=95912.5, type='othersSource', source='system', reason='lost'),
                       dict(atMs=99500, type='othersSource', source='browser', reason='restored'),
                       dict(atMs=END_MS, type='end', reason='user'),
                   ])
    evidence = dict(scenario='live-folder/1', app='synthetic', protocolCommit='0' * 40, extensionVersion='0.2.12',
                    captureId='live-folder-synthetic', timelineOriginMs=1793880000000,
                    newFolders=[f'Recording-{SESSION}'],
                    actions={k: dict(requestedAtMs=a, observedAtMs=b) for k, (a, b) in ACTIONS.items()},
                    slotC=dict(connectionState='connected', packetsReceived=0), maxSourceCount=3,
                    nativeTones=dict(microphone=MIC_HZ))
    return session, tracks, evidence


def _track(plans, identifier):
    return next(t for t in plans if t['id'] == identifier)


def _resort(session):
    session['events'].sort(key=lambda e: (e['atMs'], e['type'] == 'end'))


def drop_restored(session, tracks, evidence):
    session['events'] = [e for e in session['events'] if e.get('reason') != 'restored']


def mute_gap(session, tracks, evidence):
    a1 = _track(tracks, 'span-a1')
    a1['gaps'] = [dict(atMs=a1['startOffsetMs'] + 237992 / 8, durationMs=2000, frames=16000, kind='jump')]
    a1['extra']['gapFrames'] = 16000


def split_mute(session, tracks, evidence):
    a1 = _track(tracks, 'span-a1')
    cut = frames(a1['startOffsetMs'], 35000.0625)
    second = copy.deepcopy(a1)
    second.update(id='span-a1b', startOffsetMs=35000.0625, frames=a1['frames'] - cut,
                  content=[(max(0, a - cut), b - cut, mix) for a, b, mix in a1['content'] if b > cut])
    a1.update(frames=cut, content=[(a, min(b, cut), mix) for a, b, mix in a1['content'] if a < cut])
    tracks.insert(tracks.index(a1) + 1, second)


def lost_in_mute(session, tracks, evidence):
    session['events'].append(dict(atMs=35000, type='othersSource', source='system', reason='lost'))
    _resort(session)


def b_early(session, tracks, evidence):
    _track(tracks, 'span-b1')['startOffsetMs'] = 20000.25


def silent_remote(session, tracks, evidence):
    tracks.append(remote('span-c1', C_KEY, 'remote: participant-c', 70000.0625, 80000, []))


def never_audio_row(session, tracks, evidence):
    session['extraSources'] = [dict(sourceTrackId=C_KEY, kind='remote', label='remote: participant-c',
                                    captureOutcome='neverAudio', audioMs=0, trackIds=[])]


def selection_at_60s(session, tracks, evidence):
    on = next(e for e in session['events'] if e['type'] == 'selection' and e['me'] and e['reason'] == 'user')
    on['atMs'] = 60000
    _resort(session)


def mic_from_zero(session, tracks, evidence):
    first = _track(tracks, 'microphone-1')
    first.update(frames=frames(0, END_MS), content=[(0, frames(0, END_MS), MIC)])
    tracks.remove(_track(tracks, 'microphone-2'))


def overlap_same_key(session, tracks, evidence):
    _track(tracks, 'span-a2')['startOffsetMs'] = 95000.5


def resumed_new_key(session, tracks, evidence):
    _track(tracks, 'span-a2')['sourceTrackId'] = NEW_KEY


def resumed_label(session, tracks, evidence):
    _track(tracks, 'span-a2')['label'] += ' (resumed)'


def end_before_track(session, tracks, evidence):
    session['events'][-1]['atMs'] = 100000


def no_clock_method(session, tracks, evidence):
    del _track(tracks, 'span-b1')['extra']['clockMethod']


# name: (defect, the checks it must fail, exactly; the rule that names it)
MUTANTS = {
    'drop-restored': (drop_restored, ['O3'], 'O3.restored'),
    'mute-gap': (mute_gap, ['O2'], 'O2.gaps'),
    'split-mute': (split_mute, ['O2'], 'O2.oneSpan'),
    'lost-in-mute': (lost_in_mute, ['O2', 'O3'], 'O2.noEvents'),
    'b-early': (b_early, ['O1', 'O7'], 'O1.late'),
    'silent-remote': (silent_remote, ['O4'], 'O4.keys'),
    'never-audio-row': (never_audio_row, ['O4'], 'O4.outcomeRows'),
    'selection-at-60s': (selection_at_60s, ['O5'], 'O5.selection'),
    'mic-from-zero': (mic_from_zero, ['O5'], 'O5.micOff'),
    'overlap-same-key': (overlap_same_key, ['O3'], 'O3.noOverlap'),
    'resumed-new-key': (resumed_new_key, ['O3', 'O4', 'O7'], 'O3.spans'),
    'resumed-label': (resumed_label, ['O3'], 'O3.labels'),
    'end-before-track': (end_before_track, ['O0'], 'O0.bounds'),
    'no-clock-method': (no_clock_method, ['O6'], 'O6.clockMethod'),
}


def run(mutant=None):
    session, tracks, evidence = base()
    if mutant is not None:
        MUTANTS[mutant][0](session, tracks, evidence)
    return session, tracks, evidence


def samples(plan):
    """A track's interleaved PCM16: silence plus its content segments, track-local phase."""
    mono = array('h', bytes(2 * plan['frames']))
    for first, last, mix in plan['content']:
        assert 0 <= first <= last <= plan['frames'], (plan['id'], first, last)
        segment = None
        for hz, amplitude in mix:
            period = table(hz, amplitude)
            count, offset = last - first, first % len(period)
            part = (period * (count // len(period) + 2))[offset:offset + count]
            segment = part if segment is None else array('h', map(int.__add__, segment, part))
        mono[first:last] = segment
    if plan['channels'] == 1:
        return mono
    stereo = array('h', bytes(4 * plan['frames']))
    stereo[0::2] = mono
    stereo[1::2] = mono
    return stereo


def document(session, tracks):
    """session.json as the writer checkpoints it at Stop, with captureOutcome from the tracks."""
    out = []
    for plan in tracks:
        track = dict(id=plan['id'], label=plan['label'], kind=plan['kind'], file=f"track-{plan['id']}.wav",
                     sampleRate=RATE, channels=plan['channels'], frames=plan['frames'],
                     startOffsetMs=plan['startOffsetMs'],
                     endOffsetMs=plan['startOffsetMs'] + plan['frames'] / RATE * 1000, ended=True)
        if 'sourceTrackId' in plan:
            track['sourceTrackId'] = plan['sourceTrackId']
            track.update(receivedFrames=plan['frames'], captureOutcome='captured')
        track.update(plan['extra'])
        track['gaps'] = plan.get('gaps', [])
        out.append(track)
    sources = {}
    for track in out:
        if 'sourceTrackId' in track:
            row = sources.setdefault(track['sourceTrackId'], dict(
                sourceTrackId=track['sourceTrackId'], kind=track['kind'], label=track['label'],
                captureOutcome='captured', audioMs=0, trackIds=[]))
            row['audioMs'] += track['frames'] / RATE * 1000
            row['trackIds'].append(track['id'])
    fields = {k: v for k, v in session.items() if k not in ('events', 'extraSources')}
    return dict(fields, tracks=out, events=session['events'],
                captureOutcome=dict(sources=list(sources.values()) + session.get('extraSources', [])))


def write(out, session, tracks, evidence):
    """OUT/Recording-<id>/ and OUT/evidence.json; returns the folder."""
    out = Path(out)
    folder = out / f"Recording-{session['id']}"
    folder.mkdir(parents=True)
    for plan in tracks:
        data = samples(plan)
        if sys.byteorder != 'little':
            data.byteswap()
        with wave.open(str(folder / f"track-{plan['id']}.wav"), 'wb') as writer:
            writer.setnchannels(plan['channels'])
            writer.setsampwidth(2)
            writer.setframerate(RATE)
            writer.writeframes(data.tobytes())
    (folder / 'session.json').write_text(json.dumps(document(session, tracks), indent=1) + '\n')
    (out / 'evidence.json').write_text(json.dumps(evidence, indent=1, sort_keys=True) + '\n')
    return folder


def make(out, mutant=None):
    return write(out, *run(mutant))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('out', type=Path)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--mutant', choices=sorted(MUTANTS))
    group.add_argument('--all', action='store_true')
    args = parser.parse_args()
    if args.all:
        for name in [None] + sorted(MUTANTS):
            print(make(args.out / (name or 'base'), name))
    else:
        print(make(args.out, args.mutant))


if __name__ == '__main__':
    main()
