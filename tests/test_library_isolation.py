"""Conformance runs never touch a real user Library (drmeyers incident, 2026-11-01)."""
import contextlib, io, json, os, pathlib, pwd, subprocess, sys, tempfile, unittest
from unittest.mock import patch
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT/'conformance'))
import run as runner

CASES = json.loads((ROOT/'conformance/vectors.json').read_text())
# fake_host implements only the happy-path conversation of the first vector.
STARTING = CASES[:1]

def launcher(directory):
    executable = pathlib.Path(directory)/'host'
    fake = ROOT/'tests/fake_host.py'
    executable.write_text('#!'+sys.executable+'\nexec(compile(open('+repr(str(fake))+').read(),'+repr(str(fake))+',"exec"))\n')
    executable.chmod(0o700)
    return executable

def user_libraries():
    """The folders a legacy host derives from the system user record, not HOME."""
    try: home = pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir)
    except KeyError: home = pathlib.Path.home()  # containers may have no passwd entry
    return [home/'Music/Cassini', home/'Musique/Cassini', home/'Musica/Cassini', home/'Música/Cassini']

def listing(folders):
    return {str(f): sorted(p.name for p in f.iterdir()) if f.is_dir() else None for f in folders}

class LibraryIsolationTests(unittest.TestCase):
    def quiet(self):
        stack = contextlib.ExitStack()
        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        return stack

    def test_runner_replaces_any_inherited_library_with_a_private_one(self):
        with tempfile.TemporaryDirectory() as temp:
            inherited = pathlib.Path(temp)/'inherited'
            inherited.mkdir()
            inherited.chmod(0o500)  # any host write there fails the run
            host = launcher(temp)
            with patch.dict(os.environ, CASSINI_LIBRARY_DIR=str(inherited)), self.quiet():
                self.assertTrue(all(runner.run(str(host), case) for case in STARTING))
            self.assertEqual(list(inherited.iterdir()), [], 'the runner used an inherited Library')

    def test_a_host_that_ignores_the_override_stops_the_whole_run(self):
        with tempfile.TemporaryDirectory() as temp:
            real = pathlib.Path(temp)/'Music/Cassini'
            real.mkdir(parents=True)
            host = launcher(temp)
            with patch.dict(os.environ, CASSINI_FAKE_ROOT=str(real), CASSINI_BAD_HOST='ignore-library'), self.quiet():
                with self.assertRaises(runner.LibraryEscape):
                    runner.run(str(host), STARTING[0])
            env = dict(os.environ, CASSINI_FAKE_ROOT=str(real), CASSINI_BAD_HOST='ignore-library')
            completed = subprocess.run([sys.executable, str(ROOT/'conformance/run.py'), str(host)],
                                       env=env, capture_output=True, text=True, timeout=120)
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn('outside its test Library', completed.stderr)
            # The first escape stops the run: one stray meeting, not one per vector.
            self.assertEqual(len(list(real.iterdir())), 2)

    def test_runs_leave_the_real_user_library_untouched(self):
        before = listing(user_libraries())
        with tempfile.TemporaryDirectory() as temp, self.quiet():
            host = launcher(temp)
            self.assertTrue(all(runner.run(str(host), case) for case in STARTING))
        self.assertEqual(listing(user_libraries()), before)

    def test_browser_test_host_refuses_to_run_without_a_test_library(self):
        env = {k: v for k, v in os.environ.items() if k != 'CASSINI_LIBRARY_DIR'}
        completed = subprocess.run([sys.executable, str(ROOT/'tests/browser_host_fixture.py')],
                                   env=env, input=b'', capture_output=True, timeout=30)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn(b'CASSINI_LIBRARY_DIR', completed.stderr)

if __name__ == '__main__':
    unittest.main()
