// Only describe evidence exposed by the current worker. A native port, a page
// hook, a recording request, and confirmed saved audio are different things.
export function popupState(result, tab) {
  const health = result?.browserHealth;
  const current = health?.tabs?.find(item => item.tabId === tab?.id);
  const capture = result?.recording === true && result.tabId === tab?.id;
  const view = {connected: health?.nativeControl === 'connected', fileIssue: health?.filesOk === false, tone: 'neutral', reloadTabId: null,
    note: 'Recording is managed in Cassini.'};
  if (!health) return {...view, title: 'Meeting detection is unavailable',
    description: 'The extension did not return connection details. Try reopening this popup.'};
  if (!tab || !/^https?:/.test(tab.url || '')) return {...view, title: 'This page isn’t supported',
    description: 'Open this popup on the browser tab where your meeting is running.'};
  if (capture) return {...view, tone: result.failedSources?.length ? 'warning' : 'good',
    title: result.stopping ? 'Finishing browser capture' : 'Browser capture is active',
    description: result.failedSources?.length ? 'Some browser audio sources have a problem. Check the meeting in Cassini.' :
      result.tracks > 0 ? 'The extension is capturing audio for this tab. Check Cassini for the recording and its saved audio.' :
        'Capture has started, but no audio tracks have been reported yet. Check the meeting in Cassini.',
    note: result.tracks > 0 ? `${result.tracks} browser audio ${result.tracks === 1 ? 'track' : 'tracks'} · manage recording in Cassini` : 'Waiting for browser audio tracks'};
  if (current?.state === 'reloadRequired') return {...view, tone: 'warning', reloadTabId: tab.id,
    title: 'This tab needs to reload', description: 'Cassini cannot reach the meeting’s audio sources on this page. Reload the tab, then rejoin your call.'};
  if (current?.state === 'checking') return {...view, title: 'Checking the page connection…',
    description: 'The extension is checking whether it can reach this meeting’s audio sources. Recording is not confirmed.'};
  if (current?.state === 'ready') return {...view, tone: 'good', title: 'Meeting sources detected',
    description: view.connected ? 'The extension can reach audio sources on this page. Open Cassini to check or manage the recording.' :
      'The extension can reach audio sources on this page. Open Cassini to connect the app and manage recording.'};
  return {...view, title: 'No meeting sources detected',
    description: 'No meeting audio sources are currently reported for this tab. If your call is active, check the connection details. This does not confirm that the page connection is working.'};
}
