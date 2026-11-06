import { popupState } from './popup-state.mjs';

const element = id => document.getElementById(id);
let pending = false, actionPending = false, reloadTabId = null, diagnosticText = '';
let requestGeneration = 0;
function showActionError(message) {
  element('action-error').textContent = message;
  element('action-error').hidden = !message;
}
function render(result, tab) {
  const view = popupState(result, tab);
  reloadTabId = view.reloadTabId;
  element('connection').textContent = view.connected ? 'App link connected · audio checked separately below' : 'Cassini app link is not connected';
  element('connection').dataset.connected = String(view.connected);
  element('tab-title').textContent = tab?.title || 'No meeting tab selected';
  try { element('site').textContent = new URL(tab.url).hostname; }
  catch { element('site').textContent = ''; }
  element('card').dataset.tone = view.tone;
  element('status').textContent = view.title;
  element('explanation').textContent = view.description;
  element('recording-note').textContent = view.note;
  element('installation-warning').hidden = !view.fileIssue;
  element('reload').hidden = reloadTabId === null;
  element('reload-warning').hidden = reloadTabId === null;
  // Do not copy meeting URLs/titles or filesystem paths into the report.
  diagnosticText = JSON.stringify({currentTabId: tab?.id ?? null,
    browserHealth: result.browserHealth ?? null,
    currentTabCapture: result.tabId === tab?.id ? {recording: !!result.recording, stopping: !!result.stopping,
      tracks: result.tracks ?? 0, failedSources: result.failedSources || []} : null}, null, 2);
  element('diagnostics').textContent = diagnosticText;
  element('copy').disabled = false;
}
async function refresh() {
  if (pending || actionPending) return;
  pending = true;
  const generation = ++requestGeneration;
  try {
    const [result, tabs] = await Promise.all([
      chrome.runtime.sendMessage({target: 'background', type: 'status'}),
      chrome.tabs.query({active: true, currentWindow: true})
    ]);
    if (generation !== requestGeneration) return;
    if (!result || result.error) throw new Error(result?.error || 'No reply from the extension');
    render(result, tabs[0]);
  } catch (error) {
    if (generation !== requestGeneration) return;
    reloadTabId = null;
    element('connection').textContent = 'App connection is unverified';
    element('connection').dataset.connected = 'false';
    element('installation-warning').hidden = true;
    element('card').dataset.tone = 'warning';
    element('status').textContent = 'Meeting detection is unavailable';
    element('explanation').textContent = error.message;
    element('recording-note').textContent = 'Recording status is unavailable. Check Cassini.';
    element('reload').hidden = element('reload-warning').hidden = true;
    diagnosticText = JSON.stringify({error: error.message});
    element('diagnostics').textContent = diagnosticText;
    element('copy').disabled = false;
  } finally { pending = false; element('tab-status').setAttribute('aria-busy', 'false'); }
}
element('reload').addEventListener('click', async () => {
  if (actionPending || reloadTabId === null) return;
  // Keep the action bound to the displayed tab even if an in-flight poll finishes.
  const tabId = reloadTabId;
  actionPending = true;
  ++requestGeneration;
  element('reload').disabled = true;
  showActionError('');
  try {
    const result = await chrome.runtime.sendMessage({target: 'background', type: 'reloadMeetingTab', tabId});
    if (!result || result.error) throw new Error(result?.error || 'The tab could not be reloaded');
    element('status').textContent = 'Tab reloaded · rejoin your call';
    element('explanation').textContent = 'Waiting for fresh meeting sources. Reloading does not confirm that audio is available.';
    element('card').dataset.tone = 'neutral';
    reloadTabId = null;
    element('reload').hidden = element('reload-warning').hidden = true;
  } catch (error) { showActionError(error.message); }
  finally { actionPending = false; element('reload').disabled = false; }
});
element('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(diagnosticText);
    element('copy-result').textContent = 'Diagnostics copied.';
  } catch { element('copy-result').textContent = 'Could not copy. Select the connection details above to copy them manually.'; }
  element('copy-result').hidden = false;
});
void refresh();
setInterval(() => void refresh(), 1000);
