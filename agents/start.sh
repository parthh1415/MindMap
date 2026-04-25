#!/bin/sh
set -e
cd "$(dirname "$0")"
python topology_agent.py &
python enrichment_agent.py &
wait
