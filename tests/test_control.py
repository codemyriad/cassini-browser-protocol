import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
from jsonschema import Draft202012Validator
ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('control_runner', ROOT / 'conformance/control/run.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

class ControlTests(unittest.TestCase):
    def test_schemas_and_both_runners(self):
        for name in ['extension', 'host']:
            Draft202012Validator.check_schema(json.loads((ROOT / f'schemas/control-{name}.schema.json').read_text()))
        cases = json.loads((ROOT / 'conformance/control/vectors.json').read_text())
        fixture = ROOT / 'conformance/control/fixture-host.py'
        with contextlib.redirect_stdout(io.StringIO()):
            for case in cases:
                with self.subTest(case=case['name']): self.assertTrue(runner.run(fixture, case))
        # Envelopes are schema-checked and exact-match compared in the host runner;
        # extension semantics and the same corpus are exercised by the VM runner.
        subprocess.run(['node', str(ROOT / 'conformance/control/run-extension.cjs')], check=True, stdout=subprocess.DEVNULL)

    def test_mutated_control_hosts_are_rejected(self):
        cases = json.loads((ROOT / 'conformance/control/vectors.json').read_text())
        fixture = ROOT / 'conformance/control/fixture-host.py'
        case = next(c for c in cases if c['name'] == 'start-by-tab-id')
        for fault in ['status', 'tab']:
            with self.subTest(fault=fault), patch.dict(os.environ, CASSINI_CONTROL_FAULT=fault), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertFalse(runner.run(fixture, case))

    def test_audio_vectors_and_runner_are_unchanged(self):
        import hashlib
        self.assertEqual(len(json.loads((ROOT / 'conformance/vectors.json').read_text())), 88)
        self.assertEqual(hashlib.sha256((ROOT / 'conformance/vectors.json').read_bytes()).hexdigest(), 'b3cbc8efa9decd119b3a5e7ef1e99584c488b12ba49b73824fb490b55b4eecbd')
        self.assertEqual(hashlib.sha256((ROOT / 'conformance/run.py').read_bytes()).hexdigest(), '94087b8076f6a7f135fcd8b13c8fea6fd4fa08ccba5c0da94350e2b064756c62')

if __name__ == '__main__':
    unittest.main()
