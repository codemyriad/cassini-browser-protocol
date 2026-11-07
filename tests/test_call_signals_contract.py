"""D74 literal/control-schema checks; not a site detector or app audio engine."""
import copy
import json
import unittest
from pathlib import Path
from test_schemas import schema
ROOT = Path(__file__).resolve().parents[1]
VECTORS = json.loads((ROOT / 'conformance/control/call-signals-vectors.json').read_text())

class CallSignalContractTests(unittest.TestCase):
    def test_literal_message_shapes(self):
        for group, accepted in [('valid', True), ('invalid', False)]:
            for case in VECTORS[group]:
                with self.subTest(group=group, name=case['name']):
                    validator = schema(case['schema'])
                    self.assertEqual(validator.is_valid(case['message']), accepted,
                                     list(validator.iter_errors(case['message'])))

    def test_unknown_call_and_remote_design_are_independent(self):
        message = copy.deepcopy(next(c['message'] for c in VECTORS['valid']
                                     if c['name'] == 'mixed-design-unknown-call'))
        validator = schema('control-extension')
        validator.validate(message)
        for classification in ['mixed', 'separated', 'unknown']:
            message['tabs'][0]['remoteAudio'] = classification
            validator.validate(message)
            self.assertEqual(message['tabs'][0]['callEvidence']['state'], 'unknown')
        message['tabs'][0]['callEvidence']['state'] = 'inactive'
        self.assertFalse(validator.is_valid(message), 'unknown evidence cannot become affirmative inactive')

    def test_passive_media_literals_never_start_and_do_not_fabricate_rtp(self):
        cases = VECTORS['passiveMediaNegatives']
        self.assertEqual(len(cases), 5)
        for case in cases:
            schema('control-extension').validate(case['signal'])
            self.assertTrue(case['fixtureAudioPlaying'])
            self.assertTrue(case['autoRecordOptIn'])  # opt-in alone is insufficient
            self.assertEqual(case['signal']['tabs'][0]['callEvidence']['state'], 'unknown')
            for field in ['signalAutoCandidate', 'appSystemStart', 'browserStart', 'legacyHeard']:
                self.assertFalse(case['expect'][field])
            self.assertEqual(case['expect']['legacySourceCount'], 0)

    def test_routing_literals_distinguish_opt_in_system_and_existing_rtp(self):
        cases = {case['name']: case for case in VECTORS['routing']}
        for case in cases.values():
            schema('control-extension').validate(case['signal'])
        self.assertTrue(cases['mixed-positive-opt-in']['expect']['appSystemStart'])
        self.assertFalse(cases['mixed-positive-opt-out']['expect']['appSystemStart'])
        self.assertFalse(cases['mixed-with-one-rtp-still-not-browser']['expect']['browserStart'])
        self.assertEqual(cases['mixed-with-one-rtp-still-not-browser']['expect']['browserCommandRefused'], 'unsupported')
        self.assertTrue(cases['separated-existing-rtp-ready']['expect']['browserStart'])
        self.assertFalse(cases['separated-signal-without-rtp-is-insufficient']['expect']['browserStart'])
        self.assertFalse(cases['active-call-unknown-design-no-guess']['expect']['appSystemStart'])

    def test_positive_end_stops_associated_auto_call_while_media_continues(self):
        case = VECTORS['lifecycle']
        self.assertEqual([s['signal']['tabs'][0]['callEvidence']['state'] for s in case['steps']],
                         ['active', 'inactive', 'unknown'])
        for step in case['steps']:
            schema('control-extension').validate(step['signal'])
            self.assertTrue(step['fixtureAudioPlaying'])
        self.assertEqual([s['expect']['appSystemStart'] for s in case['steps']], [True, False, False])
        self.assertEqual([s['expect']['appStop'] for s in case['steps']], [False, True, False])
        ended = case['steps'][1]['signal']['tabs'][0]['callEvidence']
        self.assertEqual((ended['reason'], ended['callGeneration']), ('callEnded', 'call-A'))
        self.assertEqual(case['steps'][1]['expect']['stopAssociation'], 'document-A/call-A')

    def test_known_classification_and_inactive_state_need_adapter(self):
        message = copy.deepcopy(next(c['message'] for c in VECTORS['valid']
                                     if c['name'] == 'mixed-design-unknown-call'))
        message['tabs'][0]['callEvidence']['adapter'] = None
        self.assertFalse(schema('control-extension').is_valid(message))
        message['tabs'][0]['remoteAudio'] = 'unknown'
        schema('control-extension').validate(message)
        message['tabs'][0]['callEvidence'].update(state='inactive', reason='nonCall')
        self.assertFalse(schema('control-extension').is_valid(message))

if __name__ == '__main__':
    unittest.main()
