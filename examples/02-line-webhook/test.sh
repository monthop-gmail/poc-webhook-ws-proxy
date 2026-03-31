#!/usr/bin/env bash
# Example 02: LINE Webhook Simulation
# ────────────────────────────────────
# จำลอง payload จาก LINE Messaging API
# ใช้ทดสอบก่อน wire ขึ้น LINE จริง
#
# LINE Webhook จริงจะ POST มาที่ /webhook?room=line
# แล้ว Claude ตอบกลับผ่าน reply tool → broadcast ไปที่ /chat

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
ROOM="${ROOM:-line}"

# สร้าง LINE-like payload
PAYLOAD=$(cat <<'EOF'
{
  "destination": "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "events": [
    {
      "type": "message",
      "mode": "active",
      "timestamp": 1462629479859,
      "source": {
        "type": "user",
        "userId": "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      },
      "replyToken": "nHuyWiB7yP5Zw52FIkcQobQuGDXCTA",
      "message": {
        "id": "444573844083572737",
        "type": "text",
        "text": "สวัสดี bot! วันนี้อากาศเป็นยังไงบ้าง?"
      }
    }
  ]
}
EOF
)

echo "📱 Simulating LINE webhook → room: $ROOM"
echo ""

curl -s -X POST "$BASE_URL/webhook?room=$ROOM" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Source: line-messaging-api" \
  -d "$PAYLOAD" \
  | jq .

echo ""
echo "✅ Done — open http://localhost:8787/chat?room=$ROOM to see Claude's reply"
echo ""
echo "💡 Claude จะเห็น events[0].message.text และตอบกลับผ่าน reply tool"
