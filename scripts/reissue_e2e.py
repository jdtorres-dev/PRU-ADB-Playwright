# -*- coding: utf-8 -*-
"""Reissue the whole E2E feed set under a fresh generation.

The environment has no data reset. A bundle whose firm record passes validation
commits its organisation, and presenting the same identifiers again raises B0700
instead of the condition under test. So every execution needs its own generation.

    python scripts/reissue_e2e.py 7

rebuilds every feed file in data/feeds.json with generation 7 identifiers,
refreshes the record indexes, rebuilds the test-case registry, and writes
data/generation.json.

Run this immediately before an execution, never during one.

Requires make_feeds.py, make_feeds_dest.py, make_feeds_t1.py and
make_feeds_state.py to be runnable - see their module docstrings and
README.md > "How to reissue test data" for the additional source materials
(the demo merged file, the E2E Test Data spec folder, and the dated BRD
workbook copy) they need that were not part of the delivered reference
package. Without those, this script cannot regenerate feed content; it is
kept and documented so the mechanism is not lost.
"""
import json
import os
import subprocess
import sys
from datetime import datetime

from _paths import FEED_DIR

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
FEEDS = FEED_DIR
STAMP = os.path.join(DATA, "generation.json")


def main():
    if len(sys.argv) != 2 or not sys.argv[1].isdigit():
        prev = json.load(open(STAMP))["generation"] if os.path.exists(STAMP) else None
        sys.exit("usage: python scripts/reissue_e2e.py <generation>\n"
                 "last generation issued: %s" % (prev if prev is not None else "(none)"))

    gen = int(sys.argv[1])
    if not 0 <= gen <= 99:
        sys.exit("generation must be 0-99; it occupies two positions in every identifier")

    if os.path.exists(STAMP):
        prev = json.load(open(STAMP))
        if prev["generation"] == gen:
            print("WARNING: generation %d was already issued on %s." % (gen, prev["issuedAt"]))
            print("Re-uploading it will hit B0700 on every bundle that committed. "
                  "Use a generation that has not been run.")
            if input("continue anyway? [y/N] ").strip().lower() != "y":
                sys.exit(1)

    env = dict(os.environ, E2E_GENERATION=str(gen))
    for script in ("make_feeds.py", "make_feeds_dest.py", "make_feeds_t1.py",
                   "make_feeds_state.py"):
        print("\n--- %s (generation %d) ---" % (script, gen))
        r = subprocess.run([sys.executable, os.path.join(HERE, script)], env=env, cwd=HERE)
        if r.returncode:
            sys.exit("%s failed" % script)

    print("\n--- rebuilding the test-case registry ---")
    r = subprocess.run([sys.executable, os.path.join(HERE, "build_registry.py")], cwd=HERE)
    if r.returncode:
        sys.exit("build_registry.py failed")

    os.makedirs(DATA, exist_ok=True)
    json.dump(dict(generation=gen, issuedAt=datetime.now().isoformat(timespec="seconds"),
                   feedDir=FEEDS), open(STAMP, "w"), indent=1)
    print("\ngeneration %d issued. Identifiers carry %02d in positions 2-3." % (gen, gen))
    print("Stamp written to data/generation.json.")


if __name__ == "__main__":
    main()
