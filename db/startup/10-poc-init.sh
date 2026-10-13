# Mounted into /opt/oracle/scripts/startup (see compose.yaml). The Oracle image's runUserScripts.sh SOURCES this
# file (it is not executed), once per container start, after the CDB is open. So: no `exit`, no `set -e`, and
# nothing else in this directory (every *.sql here would be run as SYS).
#
# The image ignores a hook's exit status, so the outcome is recorded where the healthcheck and bootstrap can see
# it: /dev/shm/poc-init.status holds "<PID 1 start time> ok|failed". /dev/shm survives `docker restart`, so the
# start time is what tells this start's result from a stale one (db/init-status.sh does the comparison).
poc_token=$(cut -d' ' -f22 /proc/1/stat)
rm -f /dev/shm/poc-init.status
if bash /opt/poc/db/init.sh; then
  echo "${poc_token} ok" > /dev/shm/poc-init.status
else
  echo "${poc_token} failed" > /dev/shm/poc-init.status
  echo "POC INIT FAILED: see the output above. The container stays up but will not report healthy."
fi
unset poc_token
