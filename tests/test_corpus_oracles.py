"""Code mutants of the presence and floor oracles must fail the corpus `expected` check.

These patch the oracle functions, not the data: with a mutant in place, the same
hand-written literals that pass in test_multistream_corpus.py must fail.
"""
import math
from pathlib import Path
import statistics
import tempfile
import unittest
from unittest import mock

import test_multistream_corpus as guard

floor, gaps = guard.floor, guard.gaps


def _track(samples, start_ms=0, gap_list=()):
    return dict(startOffsetMs=start_ms, sampleRate=48000, frames=len(samples), gaps=list(gap_list))


class FloorOracleTests(unittest.TestCase):
    def test_zero_padding_and_partial_frames_never_count(self):
        loud, quiet = [1000, -1000] * (floor.FRAME * 5), [10, -10] * (floor.FRAME * 5)
        samples = quiet + [0] * floor.FRAME * 10 + loud
        level = floor.span(_track(samples), samples)
        self.assertAlmostEqual(level, 20 * math.log10(10 / 32768), places=6)
        # Presence that removes the quiet part leaves only the loud frames.
        gap = dict(atMs=0, durationMs=len(quiet) / 48, frames=len(quiet), kind='jump')
        self.assertAlmostEqual(floor.span(_track(samples, gap_list=[gap]), samples), 20 * math.log10(1000 / 32768), places=6)
        self.assertIsNone(floor.span(_track([0] * floor.FRAME * 4), [0] * floor.FRAME * 4))

    def test_ownership_limits_the_frames(self):
        samples = [10, -10] * (floor.FRAME * 5) + [1000, -1000] * (floor.FRAME * 5)
        half = len(samples) // 2 / 48
        self.assertAlmostEqual(floor.span(_track(samples), samples, [[half, len(samples) / 48]]),
                               20 * math.log10(1000 / 32768), places=6)

    def test_person_is_the_minimum_known_span_floor(self):
        self.assertEqual(floor.person([-45.0, None, -80.0]), -80.0)
        self.assertIsNone(floor.person([None]))


class PresenceMutantTests(unittest.TestCase):
    def test_presence_mutants_fail_expected(self):
        data, _ = guard.corpus.load()
        guard.check_expected(data)
        original = gaps.presence
        mutants = {
            'ignores gap ranges': lambda track, ownership=None: original(dict(track, gaps=[]), ownership),
            'ignores ownership': lambda track, ownership=None: original(track),
        }
        for name, mutant in mutants.items():
            with self.subTest(name), mock.patch.object(gaps, 'presence', mutant):
                with self.assertRaises(AssertionError):
                    guard.check_expected(data)


class FloorMutantTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data, _ = guard.corpus.load()
        cls.temporary = tempfile.TemporaryDirectory()
        guard.corpus.make(Path(cls.temporary.name))
        cls.folders = {c['id']: Path(cls.temporary.name) / ('Recording-' + c['id']) for c in cls.data['sessions']}

    @classmethod
    def tearDownClass(cls):
        guard._PCM.clear()
        cls.temporary.cleanup()

    def test_floor_mutants_fail_expected(self):
        C = self.data['constants']
        guard.check_floors(self.data, self.folders, C)
        span = floor.span
        mutants = {
            'person pooled by max': ('person', lambda floors: max(f for f in floors if f is not None)),
            'person pooled by mean': ('person', lambda floors: statistics.fmean(f for f in floors if f is not None)),
            'span ignores presence': ('span', lambda track, pcm, ownership=None: span(dict(track, gaps=[]), pcm, None)),
        }
        for name, (target, mutant) in mutants.items():
            with self.subTest(name), mock.patch.object(floor, target, mutant):
                with self.assertRaises(AssertionError):
                    guard.check_floors(self.data, self.folders, C)
