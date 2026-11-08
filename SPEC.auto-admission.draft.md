# Draft: verified automatic admission, separate from source observation

**Review proposal; no runtime behavior or capability advertisement is enabled.** Proposed canonical SPEC/schema/vector amendments now accompany this draft for review; the producer and consumers are not implemented by them. D80.1, 2026-11-08. Companion version remains0.2.25. No hostname-specific rules, marker implementation, graph capture or user-browser study is proposed here.

## Confirmed failure at the consumer Start boundary

An actual Chromium0.2.25 passive WebRTC viewer received a generated440 Hz stream with RMS0.2482050933764155, no getUserMedia/local microphone and no call controls. The shipped MAIN hook truthfully reported sourceCount1/heardtrue. This alone did not prove automatic recording.

A second isolated test now establishes the missing boundary:

1. The shipped0.2.25 worker/control code, run in its existing VM harness, projects those facts at a neutral origin (`https://media.invalid/viewer`) into legacy `meetings`: sourceCount1, sourceCountKnowntrue, heardtrue, pageStatepresent. It opens no real native host.
2. That serialized hello/inventory is fed into actual GNOME0.4.2 release code, commit `a03252df5336f8d9ed7117cd31d4c12191f269ba`, with auto-record enabled and an explicitly simulated application present. The call-signals handshake is also acknowledged; it is not omitted to manufacture legacy behavior.
3. Production `policy` → `_automatic` → `command` sends a real control packet to `BrowserConnection.send`: `action:start`, `mode:tracks`, `captureLocal:false`, `microphone:true`. Only the final wire sink is mocked; it acknowledges recordingfalse. Native fallback/input is forbidden and zero captures are created.
4. With auto-record off, no command is sent. A desired no-Start regression fails at the final packet assertion on the released code, not at setup/imports.

This proves an **automatic Start request**, not actual microphone/device opening or a saved recording. Browser RTP source observation, worker inventory projection, and consumer admission are separate stages. All must be covered; the browser observation is not to be falsified to make the regression pass.

GNOME's `_auto_start_ready()` currently accepts positive known sourceCount plus heardtrue for a `call-evidence-v1` companion. That capability's legacy name must not be treated as proof of an independently observed call: heard is still received-media evidence. `call-signals-v1` negotiation alone does not strengthen that legacy predicate.

## Independent Meet source-observation receipt

The supplied 2026-11-08 two-browser Meet study used companion0.2.25 with observer Chrome for Testing149.0.7827.55 and actor Chrome156.0.8078.47. After manually verified joins, the observer had one connected/ICE-connected PC and three live recvonly audio tracks; inventory was sourceCount3/heardfalse. Speech made a previously muted receiver unmuted and moved the fresh inventory to heardtrue, with increasing RTP/sample counters. Leaving the observer produced a fresh empty inventory.

This is evidence of received-source discovery, observed audibility and retirement in that tested flow. Three receivers are **not proof of three participants**; active-speaker slots remain an unproven hypothesis. The observer's inputs were denied, and a sendonly/live/muted slot is not proof of an actual page-captured microphone on a sender. No native recording host, Start command or PCM capture was used. Independent call admission, per-participant separation and saved recording remain unvalidated. This Meet result is separate from the isolated GNOME automatic-Start-request proof above; neither may be substituted for the other.

The generic contract must preserve those source facts without promoting heardtrue to active evidence, must not infer a new logical call from receiver/PC changes, and must not treat an empty inventory alone as an affirmative user-call end. A listen-only receiver can have genuine media while failing a mic-sender candidate: that is unknown automatic admission, not unavailable source capture. Add a literal regression for heardfalse → heardtrue → fresh empty inventory with admission still unknown unless independent evidence exists; maintain no automatic Start/fallback/input and no per-person claim. Automated guest-join/codec failures remain a separate precondition issue, not an extension failure.

Receipts: coordination `REPLIES-EXTENSION-meet-observations-2026-11-08.md` and `evidence/extension/meet-observations-2026-11-08.json` (committed at623e9ed). They contain sanitized lifecycle/counter facts; do not copy room URLs, user identities, labels or media into protocol diagnostics. No Meet-specific selector or hostname rule is proposed.

## Proposed minimal semantic change

Keep existing sourceCount/sourceCountKnown/heard truthful and preserve explicit manual Start/record-all semantics. Require fresh **independent verified call/session evidence** for every automatic Start, including a system fallback following browser rejection. Missing, unknown, ambiguous or stale evidence never implicitly qualifies. Do not derive it from hostname, energy, playback, graph presence or receiver count. A connected PC plus microphone is still a candidate requiring D80.1's negative cases and explicit review, not a detector implemented by this draft.

Use the existing `callSignals` evidence vocabulary, identity/fencing and separate remoteAudio classification where possible, rather than duplicate the same facts in an automaticEligible boolean with a different lifetime. A generic detector may carry a stable algorithm identifier/version in the existing adapter descriptor; it must not be a hostname registry or a page assertion. Whether that descriptor can be reused verbatim must be checked by GNOME and Mac consumers before amendment.

Automatic browser capture requires all existing opt-in/application/permissions/Stop/busy/transport guards **plus** fresh correlated active evidence and browser-supported separated-source capability. Mixed active evidence keeps D74's app-owned system route; unknown/unavailable capability is not permission to invent a route. This proposal does not prove participant separation from one/multiple receivers.

Correlate browser/profile, tab, current browser document and call generation. Document and generation encodings must be consistent between legacy inventory and the evidence stream; never join by URL/title or assume unrelated generation counters are interchangeable. Evidence updates and commands can race: check admission at scheduling, immediately before wire send, and immediately before any native-fallback/input reservation. Stale ends or async replies cannot admit/end a replacement call. Existing app policy owns the evidence-loss grace and fixed recording route.

**Producer refusal alone is insufficient.** GNOME0.4.2 may respond to a browser Start rejection by opening a native fallback. Suppressing an unsupported Start in the extension without fixing consumer admission can therefore still produce an unwanted recording. No production fallback test opens a device for this work; the regression's factory is forbidden.

## Compatibility decision required before implementation

Adding an optional admission field to a legacy meeting is insufficient: existing consumers ignore it and still start from heardtrue. Redefining heard to mean call-active silently corrupts the source observation contract. Existing behavior cannot be made safe for every old consumer merely by an unknown extra field.

Proposed additive negotiation, **name provisional**: `verified-auto-admission-v1`, carried by the existing hello/configure/configured capability mechanism alongside `call-signals-v1`. No new message type or public automatic Start flag is needed merely to express the guard. Proposed canonical schema/vector additions are now included for review; their runtime adoption still requires consumer/coordinator review.

| Pairing | Proposed safety behavior / migration cost |
| --- | --- |
| New consumer + new producer, guard negotiated | Consumer may list source observations, but auto-starts only from fresh correlated positive call evidence. Preserve manual source-based actions. |
| New consumer + old producer, or missing acknowledgement/evidence | Automatic Start/fallback fails closed as unverified; manual workflows remain explicit. UI must disclose that automatic call detection is not verified instead of silently promising it. This intentionally tightens old auto behavior. |
| Old consumer + new producer | Producer must not place unverified/passive observations into legacy auto-driving `meetings`; retain raw source facts in its observation/diagnostic model. Verified calls/existing recording control must remain safe. This may reduce the old client's source-only/manual inventory and needs explicit consumer/UX review. Do not call this migration behavior free. |
| Old consumer + old producer | The released failure remains; document the need for the reviewed producer/consumer update, not a claim that this draft fixes deployed binaries. |

If the coordinator rejects the old-consumer projection cost, the alternative is an explicit supported consumer minimum with an upgrade/auto-disabled state. Do not choose an unsafe silent fallback to the old predicate. Consumers must review which migration to ship; this document is not authorization to remove legacy manual rows or upgrade user installations.

Fail closed from the **first publication**, before capability acknowledgement: never send auto-driving unverified legacy rows and retract them only after discovering an old consumer. New consumers keep automatic dispatch disabled while the stricter negotiation is pending or absent. Preserve existing recording status/control even when observations are withheld from an old client's automatic inventory; suppression is not a fabricated call-ended event or permission to start another recording.

D80.3 overrides an interim blanket consumer guard: fast-track the generic producer/SPEC first, then matched consumer adoption and boundary regressions. Legacy inventory withholding/manual-UI cost remains an explicit rollout decision, not shipped by these documents. Do not advertise the new capability until both halves are implemented and conformance-tested. No companion version reservation is taken by a docs-only proposal.

## Required literal cases / actual boundary regressions

| Case | Source observation | Independent evidence | Expected automatic boundary |
| --- | --- | --- | --- |
| Passive real RTP viewer | One source, heardtrue, healthy transport | Unknown, no interactive call proof | No browser Start and no native fallback/input; raw source facts retained |
| WebAudio/AudioWorklet or ordinary media-only | Graph/media activity may be real | Unknown/non-call | No automatic Start, no graph browser capture |
| Reviewed generic interactive separated session | Actual independent sources and delivery evidence | Fresh active with matching identity | One eligible browser Start, subject to existing app guards |
| Active mixed session | Honest mixed capability | Fresh active with matching identity | No browser Start; app-owned system route only under existing policy |
| Active queued, then unknown/end/navigation | Source may still play | Admission withdrawn before dispatch | Cancel queued auto Start and fallback reservation |
| Browser refuses while evidence becomes unknown | Source possibly present | Admission no longer valid | No native fallback/input |
| Old document/generation active or late end | Source facts belong elsewhere | Does not match current association | No Start or termination of a newer recording |
| Explicit manual request with unverified call | Actual source is available | Unknown | Preserve reviewed manual semantics; do not implicitly apply auto policy |
| Auto-record off or no required app | Any | Even active | No automatic Start |
| Reconnect/replayed evidence | Same current identity | Same valid call | No duplicate automatic Start; manual Stop suppression retained |

Test the real consumer dispatch through its final wire/input boundary with private transports and forbidden device factories. For generic positives, separately prove the detector against representative actual-site flows; synthetic fixtures alone do not establish site support. Keep real passive RTP plus media-only and unrelated-mic negatives, with no hostname exceptions. Require Mac and GNOME consumer review, then agy/coordinator review, before merging any schema/policy/runtime change.

The concrete identity mapping and updated separated-existing-rtp-ready/passive-rtc-viewer literals are in the D80.3 section of SPEC-CONTROL.md and conformance/control/call-signals-vectors.json. Chrome documentGeneration and MAIN-hook documentGeneration are distinct namespaces; use the explicit browserDocumentId/sourceDocumentGeneration aliases and the shared background callGeneration, never raw cross-namespace equality.
