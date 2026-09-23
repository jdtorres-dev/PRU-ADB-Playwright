# -*- coding: utf-8 -*-
"""Portable path configuration for the registry-building scripts.

The original scripts (build_registry.py, reissue_e2e.py) hardcoded a single
author's machine: C:\\Users\\RSERRANO\\PRU ADB\\... This module replaces that
with paths relative to the project, overridable by environment variable for
anyone running from a different layout.

PRU_ADB_FEED_DIR   where feed files are read from / written to.
                    Default: <project>/data/feeds
PRU_ADB_WORKBOOK    the E2E Test Scenarios workbook (definition of record).
                    Default: <project>/reference-docs/Test Cases/PRU_ADB_E2E_Test_Scenarios_v4.xlsx

Note: make_feeds.py, make_feeds_dest.py, make_feeds_t1.py and
make_feeds_state.py (the scripts that generate feed *content*) still
reference their original author's machine for a few source inputs that were
not part of the delivered reference package (the demo merged file, the
PRU_ADB_E2E_Test_Data_v4 spec folder, and a dated BRD workbook copy). They are
kept as historical/reference implementations - see README.md > "How to
reissue test data" for what would be needed to make them portable too.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.join(HERE, "..")
DATA_DIR = os.path.join(PROJECT_ROOT, "data")

FEED_DIR = os.environ.get("PRU_ADB_FEED_DIR", os.path.join(DATA_DIR, "feeds"))
WORKBOOK = os.environ.get(
    "PRU_ADB_WORKBOOK",
    os.path.join(PROJECT_ROOT, "reference-docs", "Test Cases", "PRU_ADB_E2E_Test_Scenarios_v4.xlsx"),
)
