# D73 mixed page-audio contract — draft, not implemented

This corpus specifies the D73.10 direction before graph production code. It is
not a live WhatsApp result, graph implementation, adapter or production admission
oracle. Allowlist: HTTPS/default-port web.whatsapp.com only. Actual call markers
remain unknown until coordinator approves a disposable test-account study.

- schema-vectors.json: accepted/refused message shapes for negotiated diagnostics,
  explicit call selections, metadata pairing and legacy null/absent compatibility.
- semantics-vectors.json: literal consumer negotiation, passive-media, hypothetical
  independent lifecycle and refusal expectations. graphEnergy is knowledge of the
  test producer, NOT a pre-Start observer measurement or transmitted call evidence.
  The lifecycle fixture uses synthetic supplied facts, not invented site selectors.
- test-controller-selection.json: a separate trusted isolated-controller selection;
  this scope is invalid on production control, even with a testController flag.
- draft-format-session.json: a review-only proposed persisted session example.
  Validate BOTH canonical session.schema.json and the draft format overlay. No
  WAV/vendor recording or product-created file is implied by this metadata example.

Run `python3 -m unittest discover -s tests -p test_webaudio_contract.py` with the
pinned requirements-test.txt environment. This validates literal/schema contracts
and proposed saved metadata. Stateful negotiation, current document/source checks,
UTF-8 byte lengths, cross-message identity/composition consistency, routing proof,
real sample identity and actual capture/adapter behavior require later producer/
consumer implementation tests, not assertions that a JSON shape proves reality.

First delivery is explicit-only; automaticAdmission is ALWAYS false, even with
positive synthetic call evidence. Media-only AudioWorklet, YouTube-like playback
and WhatsApp voice-message/status/video never create automatic meetings/Start.
Their legacy sourceCount/heard remain RTP0/false; existing RTP policy is unchanged.
Unknown is unknown/non-admissible. Call end with continuing media retires the call
span and removes eligibility. Current real browser negatives live in separate
PR75, which stays negative-only until this contract merges.

Both control opt-in/ack and native feature acceptance are mandatory. An older host
ignoring optional fields is not an acceptable graph writer. Legacy inventories
never receive graph-only candidates. Microphone exclusion refuses unproved or
local-containing mixes, with no broader fallback. Page-media scope is only for
the trusted test controller; no user-facing option/popup action is approved.

The native/control draft changes and the DRAFT PERSISTED-FORMAT AMENDMENT in SPEC.md
have separate approval gates. Silvio approved the paired-field amendment in D73.11. The canonical session schema remains unchanged; the
overlay is explicitly not a complete validator. No format publication/release,
app adoption/pin, extension advertisement or browser installation occurs here.
agy reviews code; Mac and GNOME provide consumer comments; coordinator merges.


Mac consumer follow-up literals: consumer-lifecycle-vectors.json covers fresh
composition epoch identities (including exclusion refusal), no-input native
preflight with microphone:true/delayed acknowledgement, and sticky graph selection
through revoke/reconnect/transport loss before first chunk or with another RTP
source present. These remain declarative contract expectations, not a duplicate
state-machine implementation or proof that current hosts support negotiation.
composition-epochs.session.json and composition-exclusion-refused.session.json
retain old excluded metadata under a distinct key. portable-details-roundtrip.json
covers captureRecord v1 tracks AND sources, unknown fields, and future-record
non-downgrade expectations; actual app writer/reader/exporter tests remain mandatory.


D73.12 file-reader vectors: open-persisted-values.json includes unknown class,
unknown composition, both unknown, case/whitespace variants, trackless failed
sources and ordinary absent/null legacy metadata. Both file overlays accept paired
raw1–200-code-point strings, preserving exact values; native/control enums remain
strict and producers emit only defined values. Unknown class is generic/non-person,
unknown composition possibly own voice. Actual app typed/portable/export/import
adoption must preserve these values, not only accept original playable audio.
