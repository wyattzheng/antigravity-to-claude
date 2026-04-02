#!/bin/bash
# Quick E2E test — run after adding hosts: 127.0.0.1 daily-cloudcode-pa.googleapis.com
set -e
cd "$(dirname "$0")"

echo "=== Starting agcc server ==="
node dist/cli.js > /tmp/agcc.log 2>&1 &
SERVER_PID=$!

# Wait for server ready
for i in $(seq 1 30); do
  if curl -s http://localhost:8080/health 2>/dev/null | grep -q ok; then
    echo "=== Server ready (${i}s) ==="
    break
  fi
  sleep 1
done

echo ""
echo "=== Sending test request ==="
RESPONSE=$(curl -s --max-time 5 http://localhost:8080/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-pro","max_tokens":50,"messages":[{"role":"user","content":"say hello in 5 words"}]}')

echo "Response: $RESPONSE"
echo ""
echo "=== Server log ==="
cat /tmp/agcc.log
echo ""

# Cleanup
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
echo "=== Done ==="
