#!/usr/bin/env bash
# Example 01: Basic Chat
# ──────────────────────
# ส่ง message ธรรมดาเข้า proxy แล้วให้ Claude ตอบผ่าน /chat UI
#
# Prerequisites:
#   1. npm run dev   (CF Worker at localhost:8787)
#   2. claude --dangerously-load-development-channels server:poc-ws-channel
#   3. เปิด http://localhost:8787/chat ใน browser

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
ROOM="${ROOM:-default}"

echo "📨 Sending chat message to room: $ROOM"
echo ""

curl -s -X POST "$BASE_URL/webhook?room=$ROOM" \
  -H "Content-Type: application/json" \
  -d '"สวัสดี Claude! ช่วยบอกหน่อยว่าตอนนี้กี่โมงแล้ว?"' \
  | jq .

echo ""
echo "✅ Message sent — check http://localhost:8787/chat?room=$ROOM for Claude's reply"
