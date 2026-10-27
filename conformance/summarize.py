#!/usr/bin/env python3
"""Summarize real saved WAVs in bounded memory. --start is session-relative seconds."""
import argparse, json, math, pathlib, struct, unicodedata, wave
p=argparse.ArgumentParser();p.add_argument('folder',type=pathlib.Path);p.add_argument('--start',type=float);p.add_argument('--duration',type=float);p.add_argument('--tones',default='');a=p.parse_args()
root=a.folder.resolve();m=json.loads((root/'session.json').read_text());tones=[int(v) for v in a.tones.split(',') if v];assert all(20<=v<=10000 for v in tones)
def display(value):return ''.join(c for c in str(value) if unicodedata.category(c) not in ['Cc','Cf'])
print(f"{root.name}: state={m['state']} title={display(m.get('title'))!r} problem={display(m.get('problem'))!r}")
for t in m['tracks']:
 try:
  file=(root/t['file']).resolve();assert file.parent==root,'unsafe WAV path'
  with wave.open(str(file)) as w:
   rate,ch,total=w.getframerate(),w.getnchannels(),w.getnframes();assert w.getsampwidth()==2,'PCM16 required'
   offset=t.get('startOffsetMs');start=0
   if a.start is not None:
    assert offset is not None,'start offset unknown; cannot select a session-relative interval'
    start=max(0,round((a.start-offset/1000)*rate))
   start=min(start,total);w.setpos(start);left=total-start
   if a.duration is not None:left=min(left,max(0,round(a.duration*rate)))
   squares=0;count=0;peak=0;active=0;power={}
   while left:
    frames=min(left,max(1,rate//2));data=w.readframes(frames);samples=struct.unpack('<'+'h'*(len(data)//2),data)
    if not samples:break
    peak0=max(map(abs,samples));peak=max(peak,peak0);squares+=sum(v*v for v in samples);count+=len(samples)
    if peak0/32768>0.003:active+=len(samples)/ch/rate
    if tones and not power and peak0/32768>0.003:
     n=len(samples)//ch
     for frequency in tones:
      coeff=2*math.cos(2*math.pi*frequency/rate);value=0
      for channel in range(ch):
       q1=q2=0.0
       for sample in samples[channel::ch]:q0=sample+coeff*q1-q2;q2=q1;q1=q0
       value+=(q1*q1+q2*q2-coeff*q1*q2)/(n*n*32768**2)
      power[frequency]=value/ch
    left-=len(samples)//ch
   rms=math.sqrt(squares/max(1,count))/32768
   spectrum=' '.join(f'power{f}={v:.6g}' for f,v in power.items())
   print(f"  {t['kind']:<11} {display(t['label'])[:48]:<48} {total/rate:7.2f}s start={offset if offset is not None else 'unknown'}ms rms={rms:.5f} peak={peak/32768:.4f} active={active:.2f}s {spectrum}")
 except (OSError,ValueError,AssertionError,wave.Error) as e:print(f"  {display(t.get('id'))}: unavailable: {e}")
