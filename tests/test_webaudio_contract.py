"""D73 draft contract fixtures only; no graph code, adapter or runtime oracle."""
import copy
import json
import unittest
from pathlib import Path
from test_schemas import schema

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'conformance/webaudio'

class WebAudioContractTests(unittest.TestCase):
    def test_literal_schema_acceptance_and_refusal_vectors(self):
        vectors = json.loads((FIXTURES / 'schema-vectors.json').read_text())
        for group, accepted in [('valid', True), ('invalid', False)]:
            for case in vectors[group]:
                with self.subTest(group=group, name=case['name']):
                    validator = schema(case['schema'])
                    self.assertEqual(validator.is_valid(case['message']), accepted,
                                     list(validator.iter_errors(case['message'])))

    def test_mixed_metadata_is_required_on_all_wire_source_paths(self):
        validator = schema('request')
        source = dict(sourceTrackId='document-A:graph:1', kind='media', label='Page audio',
                      sourceClass='page-audio-mix', localAudio='may-contain-local')
        declarations = [dict(type='track', id='A', sampleRate=48000, channels=1, **source),
                        dict(type='sources', discoveredSources=[source]),
                        dict(type='stop', discoveredSources=[source])]
        for declaration in declarations:
            validator.validate(declaration)
            for key, value in [('kind', 'remote'), ('localAudio', None), ('sourceClass', None)]:
                invalid = copy.deepcopy(declaration)
                target = invalid if invalid['type'] == 'track' else invalid['discoveredSources'][0]
                target[key] = value
                self.assertFalse(validator.is_valid(invalid), (declaration['type'], key))
        # Null/absent optional additions preserve ordinary legacy declarations.
        legacy = dict(type='track', id='old', kind='remote', sampleRate=48000, channels=1)
        validator.validate(legacy)
        validator.validate(dict(legacy, sourceClass=None, localAudio=None))

    def test_draft_format_overlay_and_consistent_saved_source_metadata(self):
        session = json.loads((FIXTURES / 'draft-format-session.json').read_text())
        schema('session').validate(session)
        schema('draft/page-audio-session').validate(session)
        source = session['captureOutcome']['sources'][0]
        for track in session['tracks']:
            if track['id'] in source['trackIds']:
                for field in ['kind', 'sourceTrackId', 'sourceClass', 'localAudio']:
                    self.assertEqual(track[field], source[field])
        for target in ['track', 'outcome']:
            for field, value in [('kind', 'remote'), ('localAudio', None), ('sourceClass', None)]:
                bad = copy.deepcopy(session)
                item = bad['tracks'][0] if target == 'track' else bad['captureOutcome']['sources'][0]
                item[field] = value
                self.assertFalse(schema('draft/page-audio-session').is_valid(bad))
        # Existing files need neither new persisted field; amendment remains isolated.
        legacy = json.loads((ROOT / 'conformance/examples/session.json').read_text())
        schema('session').validate(legacy)
        schema('draft/page-audio-session').validate(legacy)
        self.assertNotIn('pageAudioMetadata', schema('session').schema.get('$defs', {}))

    def test_test_scope_is_not_a_production_authorization_flag(self):
        selection = json.loads((FIXTURES / 'test-controller-selection.json').read_text())
        schema('draft/page-audio-test-selection').validate(selection)
        command = dict(type='command', action='start', requestId='test-is-not-authority', tabId=2,
                       mode='tracks', independent=True, callGeneration='call-A', captureLocal=True,
                       sourceSelection=selection)
        self.assertFalse(schema('control-host').is_valid(command))
        command['testController'] = True
        self.assertFalse(schema('control-host').is_valid(command))

    def test_diagnostics_cannot_claim_automatic_admission_or_invent_unknown_inactive(self):
        vectors = json.loads((FIXTURES / 'schema-vectors.json').read_text())
        message = copy.deepcopy(next(c['message'] for c in vectors['valid']
                                     if c['name'] == 'unknown-call-with-available-mix'))
        validator = schema('control-extension')
        validator.validate(message)
        row = message['tabs'][0]
        row['automaticAdmission'] = True
        self.assertFalse(validator.is_valid(message))
        row['automaticAdmission'] = False
        row['callEvidence']['state'] = 'inactive'
        self.assertFalse(validator.is_valid(message))
        row['callEvidence'].update(state='active', reason='activeCall')
        self.assertFalse(validator.is_valid(message), 'active requires adapter and generation')
        row['callEvidence'].update(adapter=dict(name='synthetic-contract-fixture', version='1'),
                                   callGeneration='call-A')
        validator.validate(message)  # Shape only: not proof of actual WhatsApp markers.

    def test_literal_first_delivery_fixture_policy_has_no_auto_start_exception(self):
        # Assert review fixtures are consistent, without implementing a second runtime
        # admission engine and presenting it as real adapter/browser coverage.
        vectors = json.loads((FIXTURES / 'semantics-vectors.json').read_text())
        for case in vectors['negativesAndLifecycle']:
            if 'steps' in case:
                self.assertEqual([s['callState'] for s in case['steps']], ['active', 'inactive', 'unknown'])
                for step in case['steps']:
                    self.assertTrue(step['graphEnergy'])
                    self.assertFalse(step['expect']['automaticAdmission'])
                self.assertTrue(case['steps'][1]['expect']['retireCallSpan'])
                self.assertFalse(case['steps'][1]['expect']['callCaptureEligible'])
                self.assertFalse(case['steps'][2]['expect']['callCaptureEligible'])
            else:
                self.assertFalse(case['expect']['automaticAdmission'])
                self.assertFalse(case['expect']['nativeStart'])
                self.assertEqual(case['expect']['legacySourceCount'], 0)
                self.assertFalse(case['expect']['legacyHeard'])
        for refusal in vectors['refusals']:
            self.assertFalse(refusal['expect']['ok'])
            self.assertTrue(refusal['expect']['noGraphTap'])
            self.assertTrue(refusal['expect']['noTrackAudio'])
            self.assertTrue(refusal['expect']['noFallback'])


class ConsumerClarificationTests(unittest.TestCase):
    def test_composition_epochs_preserve_distinct_metadata_and_exclusion_boundary(self):
        full = json.loads((FIXTURES / 'composition-epochs.session.json').read_text())
        excluded = json.loads((FIXTURES / 'composition-exclusion-refused.session.json').read_text())
        for session in [full, excluded]:
            schema('session').validate(session)
            schema('draft/page-audio-session').validate(session)
            sources = session['captureOutcome']['sources']
            self.assertEqual(len({s['sourceTrackId'] for s in sources}), 2)
            self.assertEqual([s['localAudio'] for s in sources], ['excluded', 'may-contain-local'])
            by_key = {s['sourceTrackId']: s for s in sources}
            for track in session['tracks']:
                source = by_key[track['sourceTrackId']]
                self.assertEqual(track['localAudio'], source['localAudio'])
                self.assertIn(track['id'], source['trackIds'])
        self.assertEqual(full['tracks'][0]['endOffsetMs'], 1000)
        self.assertEqual(full['tracks'][1]['startOffsetMs'], 1000)
        self.assertEqual(excluded['tracks'], full['tracks'][:1])
        refused = excluded['captureOutcome']['sources'][1]
        self.assertEqual((refused['captureOutcome'], refused['audioMs'], refused['trackIds']), ('failed', 0, []))
        self.assertEqual(excluded['captureOutcome']['sources'][0], full['captureOutcome']['sources'][0])

    def test_portable_details_literals_keep_both_surfaces_unknowns_and_record_version(self):
        fixture = json.loads((FIXTURES / 'portable-details-roundtrip.json').read_text())
        self.assertEqual(fixture['before'], fixture['after'])
        for phase in ['before', 'after']:
            message = fixture[phase]
            schema('draft/page-audio-details').validate(message)
            # JSON serialization preservation only; actual exporter proof is an app gate.
            self.assertEqual(json.loads(json.dumps(message)), message)
            record = message['recordingDetails']['captureRecord']
            self.assertEqual(record['version'], 1)
            self.assertTrue(record['futureRecordField']['keep'])
            self.assertTrue(record['tracks'][0]['futureTrackField']['keep'])
            self.assertTrue(record['sources'][0]['futureSourceField']['keep'])
            for track in record['tracks']:
                source = next(s for s in record['sources'] if s['sourceTrackId'] == track['sourceTrackId'])
                for field in ['sourceClass', 'localAudio']:
                    self.assertEqual(track[field], source[field])
                for field in ['sourceClass', 'localAudio']:
                    bad = copy.deepcopy(message)
                    del bad['recordingDetails']['captureRecord']['tracks'][0][field]
                    self.assertFalse(schema('draft/page-audio-details').is_valid(bad))
        # Reader/merge implementations must preserve this whole future record untouched.
        self.assertEqual(fixture['futureVersionRecord']['version'], 2)

    def test_preflight_literals_cannot_create_native_inputs_or_a_recording(self):
        cases = json.loads((FIXTURES / 'consumer-lifecycle-vectors.json').read_text())['nativePreflight']
        old = next(c for c in cases if c['name'] == 'old-writer-mic-true')
        self.assertTrue(old['microphone'])
        for step in old['sequence']:
            if 'send' in step:
                schema('request').validate(step['send'])
                self.assertNotEqual(step['send']['type'], 'start')
            if 'reply' in step:
                schema('response').validate(step['reply'])
        for field in ['startSent', 'nativeInputOpened', 'nativeAudio', 'visibleRecording', 'folderCreated']:
            self.assertFalse(old['expect'][field])
        modern = next(c for c in cases if c['name'] == 'supported-writer-delayed-ack')
        self.assertTrue(modern['expect']['sameConnection'])
        before = next(s['assertBeforeAck'] for s in modern['sequence'] if 'assertBeforeAck' in s)
        self.assertTrue(all(value is False for value in before.values()))
        for step in modern['sequence']:
            if 'send' in step:
                schema('request').validate(step['send'])
            if 'reply' in step:
                schema('response').validate(step['reply'])

    def test_lifecycle_literals_keep_selection_before_wav_and_disallow_implicit_recovery(self):
        cases = json.loads((FIXTURES / 'consumer-lifecycle-vectors.json').read_text())['selectionLifecycle']
        self.assertEqual(len(cases), 5)
        for case in cases:
            self.assertEqual(case['selectedBeforeFirstWav']['sourceClass'], 'page-audio-mix')
            for field in ['ownerSelectionRetained', 'retireGraphSpan', 'requireFreshExplicitStart']:
                self.assertTrue(case['expect'][field])
            for field in ['allowAutomaticFallback', 'allowRtpResume', 'allowOmittedSelectionRecovery']:
                self.assertFalse(case['expect'][field])
            schema('control-extension').validate(dict(type='status', recording=False, tabId=2,
                path=None, message='Selected graph side ended.', sourceSelection=case['selectedBeforeFirstWav'],
                selectionEnd=case['end']))

if __name__ == '__main__':
    unittest.main()
