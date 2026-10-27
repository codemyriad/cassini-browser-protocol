# Manual product compatibility

Priority: Microsoft Teams web, Zoom web, Google Meet. Chromium only, Chrome 116 minimum.
Use dedicated test calls and generated test audio with authorized test participants. Real
accounts are required, so live product checks are manual and do not run in CI. Record Chrome
version, OS/app/extension commit, product build/version (or URL/date if the product hides it),
call topology and each result in a new file under results/. Do not store account credentials,
meeting URLs containing access tokens, or real participant identities/audio in this repo.

The fixtures are deliberately controlled topology models, not claims that any current vendor
always uses that topology. A live pass must not be inferred from their green tests.

- [Teams web](teams.md): one mixed remote receiver; individual speakers may not be separable.
- [Zoom web](zoom.md): model a PC-free Web Audio path; fall back explicitly to tab audio.
- [Meet](meet.md): three receive-only slots; a changed speaker may keep the same receiver ID.

Write results using TEMPLATE.md. No live product/account run has been claimed as of SPEC v1.1.
