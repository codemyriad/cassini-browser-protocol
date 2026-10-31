"""D52 shared outcomes through the framed browser fixture, with bounded events."""
import base64
import contextlib
import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('wire', ROOT / 'conformance/run.py')
wire = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wire)


@contextlib.contextmanager
def host():
    with tempfile.TemporaryDirectory() as temporary:
        process = subprocess.Popen([sys.executable, str(ROOT / 'tests/browser_host_fixture.py'), temporary],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def send(value):
            payload = json.dumps(value).encode()
            process.stdin.write(struct.pack('=I', len(payload)) + payload)
            process.stdin.flush()
            return wire.response(process.stdout)
        try:
            started = send(dict(type='start', version=1, captureId='capture-current', features=['source-outcomes-v1']))
            assert started['features'] == ['source-outcomes-v1']
            yield send, Path(started['path']), Path(temporary)
        finally:
            process.stdin.close()
            try:
                process.wait(3)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(3)
                raise AssertionError('browser fixture did not exit after EOF') from None
            error = process.stderr.read().decode()
            process.stdout.close(); process.stderr.close()
            assert process.returncode == 0, error


def track(send, identifier, source=None):
    return send(dict(type='track', id=identifier, sourceTrackId=source or identifier,
                     label='Guest', kind='remote', sampleRate=8000, channels=1))


def audio(send, identifier, frames=8000, offset=0, value=0, sequence=0):
    return send(dict(type='audio', id=identifier, sequence=sequence, offsetMs=offset,
                     pcm=base64.b64encode(struct.pack('<h', value) * frames).decode()))


def end(send, identifier, reason='ended'):
    return send(dict(type='trackEnd', id=identifier, reason=reason, droppedFrames=0, endOffsetMs=None))


class MultistreamTests(unittest.TestCase):
    def test_hand_written_capture_outcomes(self):
        vectors = json.loads((ROOT / 'conformance/multistream/outcomes.json').read_text())
        for case in vectors['cases']:
            with self.subTest(case=case['name']), host() as (send, folder, _):
                for item in case['tracks']:
                    self.assertEqual(track(send, item['id'], item['sourceTrackId'])['type'], 'ack')
                for item in case['writes']:
                    self.assertEqual(audio(send, item['id'], item['frames'], item['offsetMs'], item['value'])['type'], 'ack')
                self.assertEqual(send(dict(type='stop', captureId='capture-current',
                                           discoveredSources=case.get('discoveredSources', [])))['type'], 'stopped')
                metadata = json.loads((folder / 'session.json').read_text())
                wire.VALIDATORS['session'].validate(metadata)
                self.assertEqual({t['id']: t['captureOutcome'] for t in metadata['tracks']}, case['expected'])
                self.assertEqual({s['sourceTrackId']: s['captureOutcome'] for s in metadata['captureOutcome']['sources']},
                                 case['sourceExpected'])
                for item in case['tracks']:
                    stored = next(t for t in metadata['tracks'] if t['id'] == item['id'])
                    self.assertEqual(stored['receivedFrames'], sum(w['frames'] for w in case['writes'] if w['id'] == item['id']))

    def test_source_refusal_io_and_wrong_stop_leave_other_audio_alive(self):
        with host() as (send, folder, root):
            track(send, 'a'); track(send, 'b')
            marker = root / 'fail-audio-b'; marker.touch()
            failure = audio(send, 'b')
            self.assertEqual((failure['code'], failure['scope'], failure['id']), ('io', 'source', 'b'))
            self.assertEqual(audio(send, 'a')['type'], 'ack')
            stale = send(dict(type='stop', captureId='old-capture'))
            self.assertEqual((stale['type'], stale['scope']), ('error', 'command'))
            self.assertEqual(json.loads((folder / 'session.json').read_text())['state'], 'recording')
            end(send, 'b', 'failed'); marker.unlink()
            self.assertEqual(track(send, 'b2', 'b')['type'], 'ack')
            self.assertEqual(audio(send, 'b2', offset=1000)['type'], 'ack')
            self.assertEqual(audio(send, 'a', offset=1000, sequence=1)['type'], 'ack')
            send(dict(type='stop', captureId='capture-current'))
            metadata = json.loads((folder / 'session.json').read_text())
            self.assertEqual(metadata['problemKind'], 'io')
            self.assertEqual({s['sourceTrackId']: s['captureOutcome'] for s in metadata['captureOutcome']['sources']},
                             {'a':'captured', 'b':'failed'})

    def test_duplicate_declaration_and_seventy_cycles_do_not_close_the_session(self):
        with host() as (send, folder, _):
            self.assertEqual(track(send, 'a')['type'], 'ack')
            self.assertEqual(track(send, 'a')['type'], 'ack')
            for n in range(70):
                identifier = f'span-{n}'
                reply = track(send, identifier, 'returning-source')
                if n < 63:
                    self.assertEqual(reply['type'], 'ack')
                    audio(send, identifier, frames=400, offset=n * 1000)
                    end(send, identifier)
                else:
                    self.assertEqual((reply['type'], reply['code'], reply['scope']), ('error', 'limit', 'source'))
                self.assertEqual(audio(send, 'a', frames=400, offset=n * 50, sequence=n)['type'], 'ack')
            send(dict(type='stop', captureId='capture-current'))
            metadata = json.loads((folder / 'session.json').read_text())
            self.assertEqual(len(metadata['tracks']), 64)
            self.assertEqual(next(t for t in metadata['tracks'] if t['id'] == 'a')['receivedFrames'], 28000)

    def test_overlapping_live_and_closed_spans_are_refused_without_merging(self):
        with host() as (send, folder, _):
            track(send, 'a', 'same'); audio(send, 'a')
            refused = track(send, 'simultaneous', 'same')
            self.assertEqual((refused['code'], refused['scope']), ('source', 'source'))
            end(send, 'a'); track(send, 'b', 'same')
            refused = audio(send, 'b', offset=500)
            self.assertEqual((refused['code'], refused['scope']), ('source', 'source'))
            self.assertEqual(audio(send, 'b', offset=1000)['type'], 'ack')
            send(dict(type='stop', captureId='capture-current'))
            metadata = json.loads((folder / 'session.json').read_text())
            self.assertEqual([t['frames'] for t in metadata['tracks']], [8000, 8000])

    def test_ninety_second_gap_is_refused_per_source_and_a_new_span_can_resume(self):
        with host() as (send, folder, _):
            track(send, 'a', 'same'); audio(send, 'a')
            refused = audio(send, 'a', offset=90000, sequence=1)
            self.assertEqual((refused['code'], refused['scope']), ('chunk', 'source'))
            end(send, 'a'); track(send, 'after', 'same')
            self.assertEqual(audio(send, 'after', offset=90000)['type'], 'ack')
            send(dict(type='stop', captureId='capture-current'))
            metadata = json.loads((folder / 'session.json').read_text())
            self.assertEqual([t['frames'] for t in metadata['tracks']], [8000, 8000])


if __name__ == '__main__':
    unittest.main()
