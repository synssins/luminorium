#!/bin/sh
# Options are read by Python from /data/options.json; nothing here logs them.
set -e
exec python3 -m luminorium
