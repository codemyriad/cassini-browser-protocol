"""Shared test 2 oracle self-test: the synthetic live folder, its mutants and check.py.

The base folder must pass every check; each mutant must fail exactly the checks
make.py lists for it, including the rule that names it. check.py runs as the apps
run it: a subprocess under `python3 -I`, once more with no site-packages at all
(stdlib only). Its corpus constants are read from corpus.json, never copied.
"""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import wave

ROOT = Path(__file__).resolve().parents[1]
LIVE = ROOT / 'conformance/live-folder'
CHECK = LIVE / 'check.py'


def _module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


make = _module('live_folder_make', LIVE / 'make.py')
oracle = _module('live_folder_check', CHECK)
events = _module('live_folder_events', ROOT / 'conformance/check-session-events.py')
pcm = _module('live_folder_pcm', ROOT / 'conformance/pcm.py')


def run_check(folder, evidence, out, *flags):
    process = subprocess.run([sys.executable, '-I', *flags, str(CHECK), 'check', str(folder),
                              '--evidence', str(evidence), '--out', str(out)], capture_output=True, text=True)
    result = json.loads(out.read_text()) if out.exists() and process.returncode in (0, 1) else None
    return process, result


def failed(result):
    return [c['id'] for c in result['checks'] if not c['pass']], [r for c in result['checks'] for r in c['failed']]


class LiveFolderOracle(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='cassini-live-folder-')
        cls.root = Path(cls.temporary.name) / 'made'  # only make.py writes here (digests)
        cls.work = Path(cls.temporary.name) / 'work'
        cls.work.mkdir()
        for name in [None] + sorted(make.MUTANTS):
            make.make(cls.root / (name or 'base'), name)
        cls.base = next((cls.root / 'base').glob('Recording-*'))

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def copy(self, name='base'):
        """A writable copy of one materialized run: (folder, evidence path)."""
        target = Path(tempfile.mkdtemp(prefix='run-', dir=self.work))
        shutil.copytree(self.root / name, target / name)
        return next((target / name).glob('Recording-*')), target / name / 'evidence.json'

    def test_output_is_byte_identical_to_the_pinned_digests(self):
        lines = (LIVE / 'materialized.sha256').read_text().splitlines()
        pinned = dict(reversed(line.split('  ', 1)) for line in lines)
        made = sorted(p.relative_to(self.root).as_posix() for p in self.root.rglob('*') if p.is_file())
        self.assertEqual(sorted(pinned), made)
        for relative, digest in pinned.items():
            self.assertEqual(hashlib.sha256((self.root / relative).read_bytes()).hexdigest(), digest, relative)

    def test_base_validates_and_passes_every_check(self):
        events.validate(json.loads((self.base / 'session.json').read_text()))
        process, result = run_check(self.base, self.root / 'base/evidence.json', self.work / 'base.result.json')
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
        self.assertEqual(failed(result), ([], []))
        self.assertEqual([c['id'] for c in result['checks']], ['O0', 'O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7'])
        lines = [json.loads(line) for line in process.stdout.splitlines()[:-1]]
        self.assertEqual([(line['id'], line['pass']) for line in lines], [(c['id'], True) for c in result['checks']])
        self.assertEqual(result['checks'][0]['measured']['O0.schema']['value'], 'validated')

    def test_check_needs_only_the_standard_library(self):
        # -S: no site-packages at all, so no jsonschema; the schema step says so and nothing else changes.
        process, result = run_check(self.base, self.root / 'base/evidence.json', self.work / 'bare.result.json', '-S')
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
        self.assertTrue(result['checks'][0]['measured']['O0.schema']['value'].startswith('unavailable'))

    def test_each_mutant_fails_exactly_its_checks(self):
        for name, (_, checks, rule) in sorted(make.MUTANTS.items()):
            with self.subTest(mutant=name):
                folder = next((self.root / name).glob('Recording-*'))
                process, result = run_check(folder, self.root / name / 'evidence.json', self.work / f'{name}.result.json')
                self.assertEqual(process.returncode, 1, process.stderr)
                ids, rules = failed(result)
                self.assertEqual(ids, checks)
                self.assertIn(rule, rules)

    def test_every_check_has_a_mutant(self):
        named = {check for _, checks, _ in make.MUTANTS.values() for check in checks}
        self.assertEqual(named, {f'O{n}' for n in range(8)})

    def test_mutants_keep_the_folder_valid_where_they_do_not_target_o0(self):
        for name, (_, checks, _) in make.MUTANTS.items():
            if 'O0' not in checks:
                with self.subTest(mutant=name):
                    events.validate(json.loads(next((self.root / name).glob('Recording-*/session.json')).read_text()))

    def evidence_case(self, change):
        folder, evidence = self.copy()
        value = json.loads(evidence.read_text())
        change(value)
        evidence.write_text(json.dumps(value))
        return run_check(folder, evidence, evidence.with_name('result.json'))

    def test_evidence_facts_fail_only_their_check(self):
        cases = [
            ('O4', lambda e: e['slotC'].update(packetsReceived=12)),
            ('O4', lambda e: e.update(maxSourceCount=2)),
            ('O3', lambda e: e['actions']['kill'].update(requestedAtMs=96000, observedAtMs=96500)),
            ('O5', lambda e: e['nativeTones'].update(microphone=440)),
            ('O0', lambda e: e.update(newFolders=e['newFolders'] * 2)),
            ('O6', lambda e: e['actions']['stop'].update(requestedAtMs=112000, observedAtMs=112500)),
            ('O1', lambda e: e['actions']['lateRemote'].update(requestedAtMs=71000, observedAtMs=72000)),
        ]
        for index, (check, change) in enumerate(cases):
            with self.subTest(case=index, check=check):
                process, result = self.evidence_case(change)
                self.assertEqual(process.returncode, 1, process.stderr)
                self.assertEqual(failed(result)[0], [check])

    def test_unusable_evidence_is_refused(self):
        for change in (lambda e: e['actions'].pop('kill'), lambda e: e.update(protocolCommit='abc'),
                       lambda e: e['actions']['mute'].update(observedAtMs=0), lambda e: e.pop('nativeTones')):
            process, result = self.evidence_case(change)
            self.assertEqual(process.returncode, 2)
            self.assertIn('unusable input: evidence', process.stderr)

    def test_rotated_wavs_are_read_through_spans(self):
        # GNOME's RotatingWAV keeps one logical track in several WAVs, listed in `spans`.
        folder, evidence = self.copy()
        document = json.loads((folder / 'session.json').read_text())
        track = next(t for t in document['tracks'] if t['id'] == 'span-b1')
        with wave.open(str(folder / track['file'])) as reader:
            data = reader.readframes(reader.getnframes())
        cut = 100000
        rows = []
        for index, (first, last) in enumerate(((0, cut), (cut, track['frames']))):
            name = f"track-b1-part{index}.wav"
            with wave.open(str(folder / name), 'wb') as writer:
                writer.setnchannels(2)
                writer.setsampwidth(2)
                writer.setframerate(track['sampleRate'])
                writer.writeframes(data[first * 4:last * 4])
            rows.append(dict(file=name, sampleRate=track['sampleRate'], channels=2, frames=last - first,
                             startOffsetMs=track['startOffsetMs'] + first * 1000 / track['sampleRate'], ended=True))
        (folder / track['file']).unlink()
        track.update(file=rows[0]['file'], spans=rows)
        (folder / 'session.json').write_text(json.dumps(document))
        process, result = run_check(folder, evidence, evidence.with_name('spans.result.json'))
        self.assertEqual(process.returncode, 0, process.stdout)
        rows[1]['frames'] += 1
        (folder / 'session.json').write_text(json.dumps(document))
        process, result = run_check(folder, evidence, evidence.with_name('bad.result.json'))
        self.assertEqual(failed(result)[0], ['O0'])

    def test_compare_lines_up_two_results(self):
        def result(name):
            folder = next((self.root / name).glob('Recording-*'))
            return oracle.check(folder, oracle.load_evidence(self.root / name / 'evidence.json'))
        base = result('base')
        code, report = oracle.compare(base, copy.deepcopy(base))
        self.assertEqual(code, 0, report)
        code, report = oracle.compare(base, result('b-early'))
        self.assertEqual(code, 1)
        self.assertFalse(report['numeric']['bStartMs']['within'])
        self.assertTrue(report['categorical']['othersSource']['same'])
        code, report = oracle.compare(base, result('resumed-new-key'))
        self.assertEqual(code, 1)
        self.assertFalse(report['categorical']['remoteSources']['same'])
        later = copy.deepcopy(base)
        later['facts']['numeric']['restoredMs'] += 999
        later['facts']['numeric']['resumeLatencyMs'] += 999
        self.assertEqual(oracle.compare(base, later)[0], 0)
        later['facts']['numeric']['restoredMs'] += 2
        self.assertEqual(oracle.compare(base, later)[0], 1)
        for name in ('protocolCommit', 'extensionVersion'):
            other = dict(base, **{name: 'f' * 40})
            self.assertEqual(oracle.compare(base, other)[0], 2)

    def test_corpus_constants_are_read_not_copied(self):
        scenario = json.loads((LIVE / 'scenario.json').read_text())
        corpus = json.loads((ROOT / 'conformance/multistream/corpus.json').read_text())['constants']
        names = scenario['corpus']['constants']
        self.assertEqual(set(names), {'LATE_REMOTE_MS', 'BLEED_DB', 'SPAN_RATIO_MIN', 'SPARSE_DENSITY_MAX'})
        self.assertFalse(set(names) & set(scenario['constants']))
        self.assertEqual({n: oracle.C[n] for n in names}, {n: corpus[n] for n in names})
        self.assertTrue((LIVE / scenario['corpus']['file']).resolve() == ROOT / 'conformance/multistream/corpus.json')

    def test_scenario_tones_clear_the_app_tones_and_their_low_harmonics(self):
        # 440/880 Hz peers, 660 Hz replacement and GNOME microphone, 1210 Hz: none within 100 Hz.
        constants = json.loads((LIVE / 'scenario.json').read_text())['constants']
        for tone in (constants['TONE_A_HZ'], constants['TONE_B_HZ']):
            for base in (440, 660, 880, 1210):
                for harmonic in range(1, 5):
                    self.assertGreaterEqual(abs(tone - base * harmonic), 100, (tone, base, harmonic))

    def test_goertzel_reads_a_full_scale_sine_as_a_quarter(self):
        table = make.table(1000, 32767)
        self.assertAlmostEqual(pcm.goertzel(list(table) * 8, make.RATE, 1000), 0.25, places=3)
        self.assertLess(pcm.goertzel(list(table) * 8, make.RATE, 2000), 1e-9)


if __name__ == '__main__':
    unittest.main()
