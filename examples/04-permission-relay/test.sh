#!/usr/bin/env bash
# Example 04: Permission Relay
# ──────────────────────────────
# ทดสอบ flow การ approve/deny tool ผ่าน chat UI
#
# Flow:
#   1. ส่ง message ที่จะทำให้ Claude ต้องขอ permission (เช่น รัน bash command)
#   2. Claude Code แสดง permission dialog ใน terminal
#   3. MCP server forward prompt ไปที่ /chat
#   4. กด Allow/Deny ใน browser แทนการพิมพ์ใน terminal
#
# NOTE: ต้องมี claude --dangerously-load-development-channels รันอยู่

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
ROOM="${ROOM:-default}"

echo "🔐 Sending a message that will trigger a permission prompt"
echo "   Watch the /chat UI for the permission request"
echo ""

curl -s -X POST "$BASE_URL/webhook?room=$ROOM" \
  -H "Content-Type: application/json" \
  -d '"ช่วย list ไฟล์ทั้งหมดใน working directory ให้หน่อยนะ"' \
  | jq .

echo ""
echo "✅ Message sent"
echo "   → เปิด http://localhost:8787/chat?room=$ROOM"
echo "   → รอ permission request popup ใน browser"
echo "   → กด Allow เพื่ออนุญาตให้ Claude รัน command"
echo ""
echo "💡 หรือส่ง verdict ตรงๆ ผ่าน curl:"
echo "   curl -X POST \"$BASE_URL/webhook?room=$ROOM\" \\"
echo "        -H 'Content-Type: application/json' \\"
echo "        -d '\"yes abcde\"'   # แทน abcde ด้วย request_id จริง"
