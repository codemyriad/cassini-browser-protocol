"""D52 shape guard: real speech, sparse spans, seams, overlap and two calls."""
import copy
import importlib.util
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('corpus',ROOT/'conformance/multistream/make.py')
corpus=importlib.util.module_from_spec(spec);spec.loader.exec_module(corpus)
spec=importlib.util.spec_from_file_location('annotations',ROOT/'conformance/check-session-events.py')
annotations=importlib.util.module_from_spec(spec);spec.loader.exec_module(annotations)

def shape(case):
    tracks=case['tracks']
    assert any(t.get('sourceTrackId') and t['startMs']>=30000 for t in tracks),'late remote missing'
    assert any(sum(b-a for a,b in t.get('presenceWindows',[]))<(t['endMs']-t['startMs'])/2 for t in tracks if 'presenceWindows' in t),'sparse span missing'
    spans=[t for t in tracks if t.get('sourceTrackId')=='source-a'];lengths=[t['endMs']-t['startMs'] for t in spans]
    assert len(spans)>=2 and max(lengths)>=5*min(lengths),'unequal repeated source spans missing'
    assert [e['reason'] for e in case['events'] if e['type']=='othersSource']==['missing','callConnected','lost','restored']
    assert any(g['kind']=='dropped' and g['durationMs']>0 for t in tracks for g in t.get('gaps',[])),'counted gap missing'
    for track in tracks:
        if 'presenceWindows' in track:
            received=sum(b-a for a,b in track['presenceWindows'])
            missing=sum(g['durationMs'] for g in track.get('gaps',[]))
            assert received+missing==track['endMs']-track['startMs'],'presence and gaps disagree'
    assert any(t.get('bleed',{}).get('db')==-35 for t in tracks),'bleed missing'

class CorpusTests(unittest.TestCase):
    def test_shape_and_real_pinned_speech(self):
        data,speech=corpus.load();self.assertEqual(len(data['sessions']),2)
        first=data['sessions'][0];shape(first)
        for session in data['sessions']:annotations.validate(corpus.metadata(session))
        self.assertTrue(all(any(samples) for samples in speech.values()))
        mic=first['tracks'][0];remote=first['tracks'][-1]
        self.assertTrue(any(corpus.sample(mic,t/48,speech) and corpus.sample(remote,t/48,speech) for t in range(60000*48,61000*48,173)))
        self.assertTrue(all(corpus.sample(remote,t,speech)==0 for t in (70000,71000,71999.99)))
    def test_presence_mask_mutation_fails_the_guard(self):
        data,_=corpus.load();case=copy.deepcopy(data['sessions'][0]);case['tracks'][3]['presenceWindows']=[[40000,50000]]
        with self.assertRaises(AssertionError):shape(case)
    def test_removing_a_gap_range_fails_the_guard(self):
        data,_=corpus.load();case=copy.deepcopy(data['sessions'][0]);case['tracks'][3]['gaps']=[]
        with self.assertRaises(AssertionError):shape(case)
