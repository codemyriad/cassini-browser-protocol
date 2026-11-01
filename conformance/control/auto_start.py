"""Independent oracle for auto-start-vectors.json (D30.1, D52.5); never production code.

Desktop apps must run the literal vectors through their own automatic-start,
manual Record and resume paths; this file only cross-checks the hand-written
expectations.
"""
LOST = {'source': 'system', 'reason': 'lost'}


def lost_recording(case):
    """D52.5: a recording of this browser instance on system/lost for this call."""
    meeting = case['meeting']
    return any(r['tabId'] == meeting['tabId'] and r['callGeneration'] == meeting.get('callGeneration')
               and r['othersSource'] == LOST for r in case.get('recordings', []))


def decide(case):
    capabilities, meeting = case['capabilities'], case['meeting']
    receivers = meeting['sourceCount'] > 0
    heard = meeting.get('heard') is True
    evidence = heard or 'call-evidence-v1' not in capabilities
    lost = lost_recording(case)
    return {
        # Never a second folder for the lost call: it may only be resumed.
        'automatic': receivers and evidence and not lost,
        # Explicit Record is unchanged (R67: a fresh manual Record is an ordinary Start).
        'manual': receivers,
        'resume': lost and receivers and heard and 'resume-capture-v1' in capabilities,
    }
