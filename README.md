# Cassini browser recording protocol

Canonical shared protocol, schemas, conformance vectors, extension and deterministic browser
fixtures for Cassini Mac and GNOME. SPEC v1.1 keeps wire/session version 1. Chromium only;
minimum Chrome 116. Team priorities: Teams web, Zoom web, then Meet. Live product compatibility
requires manual account testing; topology fixtures are not evidence of vendor behavior.

Changes land here first and are pushed before either app updates its vendored copy. Stage all
new/changed files, run `python3 refresh-hashes.py`, validate, commit and push. Do not hand-edit
an app's extension copy. From this clone, update an app with:

```
python3 vendor.py FULL_COMMIT_SHA /path/to/app/browser-protocol /path/to/app/BrowserExtension
```

GNOME uses `/path/to/app/browser-extension`. `vendor.py` records PINNED_COMMIT and the raw
upstream commit object. `verify.py --pinned` recomputes the commit SHA and complete Git tree
from vendored files, including SHA256SUMS, with no network credentials required in app CI.
Changing the pin alone or changing both a file and its checksum cannot bypass this check.
The vendored proof files are app metadata, not upstream source files.

```
python3 verify.py
node --test extension/tests/*.test.cjs
python3 conformance/run.py /absolute/path/to/native-host
python3 conformance/check-native-fixture.py
npm ci
npx playwright install chromium
npm test
```

See TESTING.md and products/README.md for coverage and the manual Teams/Zoom/Meet checklists.
Self-hosted Mac device jobs live in the Mac repo, only on manual/nightly triggers. Firefox
and Flatpak remain future work. The schemas permit optional additions, but lexical numeric
rules and UTF-8 byte limits also need the executable vectors.
