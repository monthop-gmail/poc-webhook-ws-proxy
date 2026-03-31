#!/usr/bin/env bash
# Example 06: Multi-Agent Test
# ─────────────────────────────
# ส่ง test event ไปยังแต่ละ agent room
#
# Usage:
#   ./test.sh              # ส่งทุก room
#   ./test.sh ci           # ส่งเฉพาะ CI alert
#   ./test.sh chat         # ส่งเฉพาะ chat
#   ./test.sh line         # ส่งเฉพาะ LINE

set -euo pipefail

BASE_URL="${BASE_URL:-https://cf-webhook-ws-proxy.monthop-gmail.workers.dev}"
TARGET="${1:-all}"

send() {
  local room="$1"
  local label="$2"
  local payload="$3"

  echo "$label"
  curl -s -X POST "$BASE_URL/webhook?room=$room" \
    -H "Content-Type: application/json" \
    -H "X-Webhook-Source: test" \
    -d "$payload" | jq .
  echo ""
}

if [[ "$TARGET" == "all" || "$TARGET" == "ci" ]]; then
  send "ci" "🔴 CI room — build failure alert" \
    '{"event":"workflow_run","action":"completed","workflow_run":{"name":"CI","conclusion":"failure","head_branch":"main"},"repository":{"full_name":"org/my-app"},"error_log":"ERROR: Cannot find module '\''@/components/Button'\''\n  at src/pages/index.tsx:5"}'
fi

if [[ "$TARGET" == "all" || "$TARGET" == "chat" ]]; then
  send "chat" "💬 Chat room — general message" \
    '"สวัสดีครับ ทดสอบ multi-agent ทุก agent ทำงานปกติไหม?"'
fi

if [[ "$TARGET" == "all" || "$TARGET" == "line" ]]; then
  send "line" "📱 LINE room — message event" \
    '{"events":[{"type":"message","replyToken":"abc123","source":{"userId":"U123","type":"user"},"message":{"type":"text","text":"สวัสดีครับ สนใจสมัครสมาชิก"}}],"destination":"channel123"}'
fi

echo "Chat UIs:"
for room in ci chat line; do
  echo "  $BASE_URL/chat?room=$room"
done
