// Test-only observation installed before the disposable Talk page creates peers.
// No media, SDP, track/device IDs, URLs or DOM text enter the numeric report.
export function installRtcTopologyProbe() {
  const Native = window.RTCPeerConnection;
  const peers = new Set(), captured = new WeakSet();
  const senders = Native.prototype.getSenders, receivers = Native.prototype.getReceivers;
  const stats = Native.prototype.getStats;
  const devices = navigator.mediaDevices, gum = devices.getUserMedia;
  devices.getUserMedia = function (...args) {
    return Reflect.apply(gum, this, args).then(stream => {
      stream.getAudioTracks().forEach(track => captured.add(track));
      return stream;
    });
  };
  const clone = MediaStreamTrack.prototype.clone;
  MediaStreamTrack.prototype.clone = function (...args) {
    const result = Reflect.apply(clone, this, args);
    if (captured.has(this)) captured.add(result);
    return result;
  };
  window.RTCPeerConnection = new Proxy(Native, {
    construct(target, args, newTarget) {
      const pc = Reflect.construct(target, args, newTarget);
      peers.add(pc);
      return pc;
    }
  });
  if (window.webkitRTCPeerConnection === Native) window.webkitRTCPeerConnection = window.RTCPeerConnection;
  window.cassiniRtcTopology = async () => Promise.all([...peers].map(async (pc, index) => {
    const live = track => track?.kind === 'audio' && track.readyState === 'live';
    const row = {peer:index, connected:pc.connectionState === 'connected',
      liveCapturedSenders:Reflect.apply(senders, pc, []).filter(sender =>
        live(sender.track) && sender.track.enabled && !sender.track.muted && captured.has(sender.track)).length,
      liveReceivers:Reflect.apply(receivers, pc, []).filter(receiver => live(receiver.track)).length,
      outboundPackets:0, inboundPackets:0};
    (await Reflect.apply(stats, pc, [])).forEach(report => {
      if ((report.kind ?? report.mediaType) !== 'audio') return;
      if (report.type === 'outbound-rtp') row.outboundPackets += report.packetsSent || 0;
      if (report.type === 'inbound-rtp') row.inboundPackets += report.packetsReceived || 0;
    });
    return row;
  }));
}

export function summarizeRtcTopology(before, after) {
  const progressing = after.map(row => {
    const previous = before.find(value => value.peer === row.peer);
    return {...row, sending:!!previous && row.connected && row.liveCapturedSenders > 0 && row.outboundPackets > previous.outboundPackets,
      receiving:!!previous && row.connected && row.liveReceivers > 0 && row.inboundPackets > previous.inboundPackets};
  });
  return {peers:progressing, samePeerConnection:progressing.some(row => row.sending && row.receiving),
    sendingPeers:progressing.filter(row => row.sending).length,
    receivingPeers:progressing.filter(row => row.receiving).length};
}

// getStats is asynchronous. Await each sample before testing it, and return
// that exact sample. An async waitForFunction predicate can resolve its first
// Promise to false instead of polling the eventual state.
export async function waitRtcTopology(page,{previous=null,sending='none'}={}) {
  await page.bringToFront(); // Only a disposable headless fixture page.
  return page.evaluate(async({previous,sending})=>{
    const deadline=performance.now()+30000;
    let latest=[];
    while(performance.now()<deadline){
      const rows=await cassiniRtcTopology();
      latest=rows;
      const grows=(row,key)=>row[key]>(previous?previous.find(value=>value.peer===row.peer)?.[key]??Infinity:0);
      const received=rows.some(row=>row.connected&&grows(row,'inboundPackets'));
      const sent=sending==='none'||rows.some(row=>row.connected&&grows(row,'outboundPackets')&&
        (sending!=='captured'||row.liveCapturedSenders>0));
      if(received&&sent)return rows;
      await new Promise(resolve=>requestAnimationFrame(resolve));
    }
    throw Error('Timed out waiting for real RTC packet progress: '+JSON.stringify(latest));
  },{previous,sending});
}
