#!/usr/bin/env bash
# Independent acceptance runner for the real Edge <-> Python E2E.
#
# Starts the demo server, then the E2E (which owns the Controller), then the
# browser agent. The E2E waits for the agent to appear.
#
# Usage: bash run_indep_e2e.sh [wsPort] [demoPort] [agentPort]
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
WS_PORT="${1:-8765}"
DEMO_PORT="${2:-8770}"
AGENT_PORT="${3:-8799}"
TOKEN="${INDEP_TOKEN:-TESTTOKEN12345678}"
OUT="${OUT:-/tmp/indep_e2e.out}"

cleanup() {
  echo "[runner] tearing down test processes"
  curl -s "http://127.0.0.1:${AGENT_PORT}/c/quit" >/dev/null 2>&1
  sleep 2
  # NOTE: never match bash.exe here - the runner's own command line contains
  # these patterns, so a command-line match would kill the runner itself.
  powershell -NoProfile -Command \
    "Get-CimInstance Win32_Process | Where-Object { (\$_.Name -eq 'node.exe' -and \$_.CommandLine -like '*indep-agent*') -or (\$_.Name -eq 'msedge.exe' -and \$_.CommandLine -like '*edge-indep-profile*') -or (\$_.Name -eq 'node.exe' -and \$_.CommandLine -like '*serve.js ${DEMO_PORT}*') } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" \
    >/dev/null 2>&1
}
trap cleanup EXIT

# Pre-flight: a stale listener on any of our ports would silently hijack the
# run (the E2E would talk to a previous run's agent), so refuse to start.
for p in "$AGENT_PORT" "$WS_PORT" "$DEMO_PORT"; do
  pids=$(netstat -ano | grep -E ":${p} " | grep LISTENING | awk '{print $5}' | sort -u)
  if [ -n "$pids" ]; then
    echo "[runner] port ${p} already in use by PID(s) ${pids} - killing"
    for pid in $pids; do taskkill //PID "$pid" //F >/dev/null 2>&1; done
  fi
done
sleep 2

echo "[runner] demo server on ${DEMO_PORT}"
node "$HERE/../serve.js" "$DEMO_PORT" > "/tmp/serve${DEMO_PORT}.log" 2>&1 &
sleep 2
curl -s -o /dev/null -w "[runner] demo status=%{http_code}\n" \
  "http://127.0.0.1:${DEMO_PORT}/test/demo.html"

echo "[runner] starting E2E (owns the Controller on ${WS_PORT})"
INDEP_WS_PORT="$WS_PORT" INDEP_DEMO_PORT="$DEMO_PORT" INDEP_AGENT_PORT="$AGENT_PORT" \
  INDEP_TOKEN="$TOKEN" \
  PYTHONIOENCODING=utf-8 python "$HERE/indep_e2e.py" > "$OUT" 2>&1 &
E2E_PID=$!

# Give the Controller time to bind before the agent tries to connect.
sleep 6

echo "[runner] starting browser agent on ${AGENT_PORT}"
node "$HERE/indep-agent.js" "$TOKEN" "$WS_PORT" "$DEMO_PORT" "$AGENT_PORT" \
  > /tmp/agent.log 2>&1 &

wait $E2E_PID
RC=$?
echo "[runner] E2E exit=$RC"
tail -8 "$OUT"
exit $RC
