#!/usr/bin/env bash
# Example 03: CI/CD Alert → Claude วิเคราะห์
# ────────────────────────────────────────────
# จำลอง GitHub Actions / GitLab CI webhook ส่ง alert มา
# Claude จะรับ → วิเคราะห์ error → แนะนำวิธีแก้
#
# ทดสอบ 3 scenario: build fail, test fail, deploy success

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
ROOM="${ROOM:-ci}"
SCENARIO="${1:-build-fail}"   # build-fail | test-fail | deploy-success

case "$SCENARIO" in

  build-fail)
    echo "🔴 Simulating: Build Failed"
    PAYLOAD=$(cat <<'EOF'
{
  "event": "workflow_run",
  "action": "completed",
  "workflow_run": {
    "name": "CI",
    "status": "completed",
    "conclusion": "failure",
    "html_url": "https://github.com/org/repo/actions/runs/1234",
    "head_branch": "main",
    "head_sha": "abc1234"
  },
  "repository": { "full_name": "org/my-app" },
  "error_log": "ERROR: Cannot find module '@/components/Button'\nRequire stack:\n- src/pages/index.tsx:5\n  at Function.Module._resolveFilename (node:internal/modules/cjs/loader:1039:15)"
}
EOF
)
    ;;

  test-fail)
    echo "🟡 Simulating: Tests Failed"
    PAYLOAD=$(cat <<'EOF'
{
  "event": "workflow_run",
  "action": "completed",
  "workflow_run": {
    "name": "Test Suite",
    "status": "completed",
    "conclusion": "failure",
    "html_url": "https://github.com/org/repo/actions/runs/5678",
    "head_branch": "feat/checkout"
  },
  "failed_tests": [
    "CheckoutFlow > should apply discount code",
    "CheckoutFlow > should handle expired card"
  ],
  "coverage": { "lines": 68, "threshold": 80 }
}
EOF
)
    ;;

  deploy-success)
    echo "🟢 Simulating: Deploy Successful"
    PAYLOAD=$(cat <<'EOF'
{
  "event": "deployment_status",
  "action": "created",
  "deployment_status": {
    "state": "success",
    "environment": "production",
    "target_url": "https://my-app.vercel.app"
  },
  "deployment": {
    "ref": "v2.3.1",
    "sha": "def5678"
  },
  "repository": { "full_name": "org/my-app" }
}
EOF
)
    ;;

  *)
    echo "Usage: $0 [build-fail|test-fail|deploy-success]"
    exit 1
    ;;
esac

echo ""
curl -s -X POST "$BASE_URL/webhook?room=$ROOM" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Source: github-actions" \
  -d "$PAYLOAD" \
  | jq .

echo ""
echo "✅ Alert sent to room: $ROOM"
echo "   → http://localhost:8788/chat?room=$ROOM"
