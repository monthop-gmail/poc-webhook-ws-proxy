#!/usr/bin/env bash
# Example 01: Basic Chat
# ──────────────────────
# ส่ง message ธรรมดาเข้า proxy แล้วให้ Claude ตอบผ่าน /chat UI
#
# Prerequisites:
#   1. bash examples/06-multi-agent/start-agents.sh start
#   2. เปิด https://cf-webhook-ws-proxy.monthop-gmail.workers.dev/chat ใน browser

set -euo pipefail

BASE_URL="${BASE_URL:-https://cf-webhook-ws-proxy.monthop-gmail.workers.dev}"
ROOM="${ROOM:-default}"

echo "📨 Sending chat message to room: $ROOM"
echo ""

curl -s -X POST "$BASE_URL/webhook?room=$ROOM" \
  -H "Content-Type: application/json" \
  -d '"สวัสดี Claude! ช่วยบอกหน่อยว่าตอนนี้กี่โมงแล้ว?"' \
  | jq .

echo ""
echo "✅ Message sent — check https://cf-webhook-ws-proxy.monthop-gmail.workers.dev/chat?room=$ROOM for Claude's reply"
