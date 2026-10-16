#!/command/with-contenv sh
# with-contenv: under s6-overlay's /init, the container environment (SUPERVISOR_TOKEN) is only
# passed on through with-contenv. Options are read by Python from /data/options.json; nothing here
# logs them.
set -e
exec python3 -m luminorium
