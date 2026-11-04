"""Shared test 9 guard: the placement golden's literals, oracle, WAVs and checker.

placement.json's frames are hand-computed D55 literals; bursts.json's expected
section must equal the oracle (placement.py); the WAVs are read back with the
wave module and the shared onset detector, never through make.py's helpers.
"""
import copy
from fractions import Fraction
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import tempfile
import unittest
import wave

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[1]
PLACEMENT = ROOT / 'conformance/placement'


def _module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


make = _module('placement_make', PLACEMENT / 'make.py')
oracle = _module('placement_oracle', PLACEMENT / 'placement.py')
GOLDEN = json.loads((PLACEMENT / 'bursts.json').read_text())
LITERALS = json.loads((PLACEMENT / 'placement.json').read_text())['cases']


def mono(path):
    """A WAV's samples, stereo averaged as the transcribers do."""
    with wave.open(str(path)) as reader:
        channels, rate = reader.getnchannels(), reader.getframerate()
        data = reader.readframes(reader.getnframes())
    values = [int.from_bytes(data[i:i + 2], 'little', signed=True) for i in range(0, len(data), 2)]
    if channels == 2:
        assert values[0::2] == values[1::2]
        values = values[0::2]
    return values, rate


def perfect():
    """The results file a correct app writes."""
    legs = {'placement': [[c['ms'], c['rate'], c['frame']] for c in LITERALS]}
    for leg in oracle.LEGS + oracle.OPTIONAL:
        legs[leg] = {}
        for key, entry in GOLDEN['expected'].items():
            want = entry[leg]
            legs[leg][key] = want if want == 'refused' else list(want.get('frames', want.get('values')))
    return {'vector': GOLDEN['vector'], 'app': 'oracle', 'legs': legs}


# Wrong roundings each app has used or could use; every one must contradict a literal.
MUTANTS = {
    'half-even': lambda ms, rate: round(Fraction(ms) * rate / 1000),
    'floor': lambda ms, rate: math.floor(Fraction(ms) * rate / 1000),
    'ns-then-ceil': lambda ms, rate: math.ceil(Fraction(round(Fraction(ms) * 10**6)) * rate / 10**9),
    'whole-ms': lambda ms, rate: math.floor(ms) * rate // 1000,
    'dropped offset': lambda ms, rate: 0,
    'double offset': lambda ms, rate: oracle.frame(2 * ms, rate),
}


class PlacementGolden(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name) / 'golden'
        make.make(cls.root)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_literals_are_d55(self):
        for case in LITERALS:
            self.assertEqual(oracle.frame(case['ms'], case['rate']), case['frame'], case)

    def test_every_wrong_rounding_contradicts_a_literal(self):
        for name, wrong in MUTANTS.items():
            self.assertTrue(any(wrong(c['ms'], c['rate']) != c['frame'] for c in LITERALS), name)

    def test_whole_ms_word_base_misses_a_word_time(self):
        # GNOME's old word base: floor(offset ms) * 16 + sample, then to ms.
        entry = GOLDEN['expected']['09000000-0000-4000-8000-000000000002/system']['wordMs']['values']
        local = GOLDEN['sessions'][1]['tracks'][1]['burstsMs']
        wrong = [(math.floor(31999.96875) * 16 + ms * 16) * 1000 // 16000 for ms in local]
        self.assertNotEqual(wrong, entry)

    def test_expected_section_is_the_oracle(self):
        self.assertEqual(GOLDEN['expected'], oracle.expected(GOLDEN))

    def test_offsets_are_far_from_a_rounding_edge_or_exactly_on_it(self):
        # Every app parses the offset as a binary double and multiplies in double
        # precision (error about 1e-11 frames here): a value either is exactly on
        # .5 or keeps a 1e-6 frame margin, so no app can round it the other way.
        # 1234.5104 at 48 kHz (59256.4992) sits 0.0008 below .5 on purpose: it
        # is what separates ns-then-ceil from D55.
        for session in GOLDEN['sessions']:
            for track in session['tracks']:
                ms = track['startOffsetMs']
                if ms is None:
                    continue
                for rate in (16000, 48000, track['sampleRate']):
                    x = Fraction(ms) * rate / 1000
                    fraction = x - math.floor(x)
                    self.assertTrue(fraction == Fraction(1, 2) or abs(fraction - Fraction(1, 2)) > Fraction(1, 10**6), (ms, rate))

    def test_output_is_byte_identical_to_the_pinned_digests(self):
        lines = (PLACEMENT / 'materialized.sha256').read_text().splitlines()
        for line in lines:
            digest, relative = line.split('  ', 1)
            self.assertEqual(hashlib.sha256((self.root / relative).read_bytes()).hexdigest(), digest, relative)
        self.assertEqual(len(lines), sum(1 for path in self.root.rglob('*') if path.is_file()))

    def test_sessions_validate_and_bursts_never_overlap(self):
        schema = json.loads((ROOT / 'schemas/session.schema.json').read_text())
        validator = Draft202012Validator(schema, format_checker=FormatChecker())
        for session in GOLDEN['sessions']:
            document = json.loads((self.root / f"Recording-{session['id']}/session.json").read_text())
            self.assertEqual(sorted(e.message for e in validator.iter_errors(document)), [], session['id'])
            spans = sorted((Fraction(t['startOffsetMs'] or 0) + ms, Fraction(t['startOffsetMs'] or 0) + ms + GOLDEN['burstMs'])
                           for t in session['tracks'] for ms in t['burstsMs'])
            self.assertTrue(all(a[1] + 200 < b[0] for a, b in zip(spans, spans[1:])), session['id'])

    def test_each_burst_starts_exactly_where_the_session_says(self):
        for session in GOLDEN['sessions']:
            for track in session['tracks']:
                values, rate = mono(self.root / f"Recording-{session['id']}/track-{track['id']}.wav")
                self.assertEqual((rate, len(values)), (track['sampleRate'], track['lengthMs'] * rate // 1000))
                length = GOLDEN['burstMs'] * rate // 1000
                for ms in track['burstsMs']:
                    at = ms * rate // 1000
                    self.assertEqual(oracle.onset(values, rate, at), at, (track['id'], ms))
                    self.assertEqual(values[at], GOLDEN['level'])
                    self.assertEqual(sum(1 for v in values[at:at + length] if v), length)
                # Nothing but the bursts.
                self.assertEqual(sum(1 for v in values if v), length * len(track['burstsMs']))

    def test_no_track_is_d56_silent(self):
        # D56: a track with fewer than 32 non-zero 32 ms frames is silent and never recognized.
        for session in GOLDEN['sessions']:
            for track in session['tracks']:
                values, rate = mono(self.root / f"Recording-{session['id']}/track-{track['id']}.wav")
                size = 32 * rate // 1000
                loud = sum(1 for i in range(0, len(values), size) if any(values[i:i + size]))
                self.assertGreaterEqual(loud, 32, (session['id'], track['id']))

    def test_the_checker_accepts_a_correct_app(self):
        self.assertEqual(oracle.problems(perfect()), [])
        lean = perfect()
        del lean['legs']['opus48']
        self.assertEqual(oracle.problems(lean), [])

    def test_the_checker_rejects_wrong_placement(self):
        a, b, c = (f'09000000-0000-4000-8000-00000000000{n}' for n in (1, 2, 3))
        cases = {
            'one 48 kHz frame late in the mix': ('mix48', f'{a}/system', 0, 1, 'exact tier'),
            'one 16 kHz sample late in recognition': ('rec16', f'{b}/microphone', 2, 1, 'exact tier'),
            'one word ms late': ('wordMs', f'{b}/system', 0, 1, 'exact tier'),
            '25 ms late in recognition': ('rec16', f'{b}/system', 3, 400, 'more than 20 ms'),
            '25 ms late in a 16 kHz mix': ('mix48', f'{b}/microphone', 1, 1200, 'more than 20 ms'),
        }
        for name, (leg, key, index, shift, message) in cases.items():
            results = perfect()
            results['legs'][leg][key][index] += shift
            found = oracle.problems(results)
            self.assertEqual(len(found), 1, name)
            self.assertIn(message, found[0], name)
        # A 16 kHz track resampled into the mix may be off by up to 20 ms.
        results = perfect()
        results['legs']['mix48'][f'{b}/microphone'][1] += 959
        self.assertEqual(oracle.problems(results), [])
        for name, change in {
            'unknown offset played': lambda r: r['legs']['playback'].__setitem__(f'{c}/system', [0] * 6),
            'known offset refused': lambda r: r['legs']['playback'].__setitem__(f'{a}/system', 'refused'),
            'burst missing': lambda r: r['legs']['rec16'][f'{a}/microphone'].__setitem__(4, None),
            'leg missing': lambda r: r['legs'].pop('playback'),
            'wrong placement literal': lambda r: r['legs']['placement'][5].__setitem__(2, 48004),
            'other vector': lambda r: r.__setitem__('vector', 'placement-v0'),
        }.items():
            results = perfect()
            change(results)
            self.assertTrue(oracle.problems(results), name)

    def test_compare_names_each_difference(self):
        a, b = perfect(), copy.deepcopy(perfect())
        self.assertEqual(oracle.compare(a, b), [])
        b['app'] = 'other'
        b['legs']['mix48']['09000000-0000-4000-8000-000000000001/system'][0] += 1
        lines = oracle.compare(a, b)
        self.assertEqual(len(lines), 1)
        self.assertIn('mix48 09000000-0000-4000-8000-000000000001/system', lines[0])


if __name__ == '__main__':
    unittest.main()
