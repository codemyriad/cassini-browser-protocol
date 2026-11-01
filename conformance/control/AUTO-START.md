# Desktop auto-start vectors (D30.1)

`auto-start-vectors.json` is shared by GNOME and Mac. Each app must run these
unchanged inputs against its production auto-start policy and its manual Record
path after adopting this protocol snapshot. The extension has no automatic-start
policy: it publishes discovery and accepts explicit app commands.

Each case contains the hello `capabilities`, one listed `meeting`, and hand-written
`expect.automatic` / `expect.manual` booleans. These are full hello capability
lists on a compatible transport: pre-D30 companion 0.2.1 advertises
`["independent-sessions-v1"]`; D30 adds `"call-evidence-v1"` to that baseline.
The legacy cases mean this usable pre-D30 transport, not older peers that an app
may accept only for stopping an existing capture. Keep both apps' transport and
start guards unchanged. The protocol tests compare D30 lists with the real
extension hello and require the baseline list for pre-D30 cases. Assume automatic recording is On,
no capture/start is pending, and no other lifecycle or ownership guard blocks a
start. `automatic` says whether this candidate may start automatically; `manual`
says whether explicitly recording that tab is allowed. The zero-source cases
check the existing no-audio guard. A false/missing heard value never prevents
manual Record of a positive-source candidate. Unrelated capabilities do not
activate the heard requirement.

D52.5 cases add optional `recordings`: recordings of this browser instance the
app already holds (captureId, tabId, callGeneration and current othersSource,
always `{"source":"system","reason":"lost"}`), and optional `expect.resume`
(absent means false). A recording on system/lost for the meeting's tab and
callGeneration blocks the automatic Start (`automatic:false`); with heard and a
positive count the app instead asks once to resume that recording through
resume-capture-v1 (`resume:true`). A lost recording of another callGeneration
or another tab blocks nothing. `manual` is unchanged. Desktop adapters seed
these recordings into their real recording registry before delivering the
hello and meetings packets, then check that no Start is sent and that exactly
one resume for that captureId is (or is not) sent. `auto_start.py` is the
independent protocol-side oracle for these expectations, not a desktop runner.

The protocol tests validate the wire inputs and exercise every manual expectation
through the real extension control handler. Desktop adapters must test their own
automatic policy as well; recomputing an expected boolean in a fixture runner is
not conformance.

`call-evidence-vectors.json` separately exercises the real page hook with a fake
monotonic clock and generated receiver stats. No recorded user audio or private
dump is included. A new peer does not borrow a disconnected owner's latch while
awaiting proof. One qualifying packet delta within the five-second handoff grace
inherits it; after expiry, a fresh baseline plus two qualifying ticks is needed.
