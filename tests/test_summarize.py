import json,pathlib,subprocess,sys,tempfile,unittest,wave
ROOT=pathlib.Path(__file__).resolve().parent.parent
class SummaryTests(unittest.TestCase):
 def test_silence_threshold_is_normalized_and_empty_ranges_are_not_silent_evidence(self):
  with tempfile.TemporaryDirectory() as temp:
   root=pathlib.Path(temp);(root/'session.json').write_text(json.dumps(dict(state='completed',tracks=[dict(id='x',kind='local',label='Test',file='track-x.wav',startOffsetMs=0)])))
   with wave.open(str(root/'track-x.wav'),'wb') as out:
    out.setnchannels(1);out.setsampwidth(2);out.setframerate(8000);out.writeframes(b'\1\0'*8000)
   text=subprocess.check_output([sys.executable,str(ROOT/'conformance/summarize.py'),str(root)],text=True)
   self.assertIn('active=0.00s',text);self.assertIn('measured=1.00s',text)
   text=subprocess.check_output([sys.executable,str(ROOT/'conformance/summarize.py'),str(root),'--start','10','--duration','6'],text=True)
   self.assertIn('unavailable: selected interval contains no saved samples',text)
if __name__=='__main__':unittest.main()
