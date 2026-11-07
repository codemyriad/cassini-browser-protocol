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

if __name__ == '__main__':
    unittest.main()
