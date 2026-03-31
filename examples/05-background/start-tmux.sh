#!/usr/bin/env bash
# Example 05: Background Agent (tmux)
# ─────────────────────────────────────
# รัน Claude Code เป็น always-on agent ผ่าน tmux
# ทีมส่ง message มาได้ตลอดเวลา แม้ไม่มีคนนั่งดู terminal
#
# Usage:
#   ./start-tmux.sh              # start
#   ./start-tmux.sh stop         # stop
#   ./start-tmux.sh logs         # attach to session

set -euo pipefail

SESSION="claude-agent"
PROXY_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

ACTION="${1:-start}"

case "$ACTION" in

  start)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "⚠️  Session '$SESSION' already running"
      echo "   tmux attach -t $SESSION"
      exit 0
    fi

    echo "🚀 Starting Claude Code agent in background (tmux session: $SESSION)"

    tmux new-session -d -s "$SESSION" -x 220 -y 50 \
      "cd '$PROXY_DIR' && claude \
        --mcp-config .mcp.json \
        --dangerously-load-development-channels server:poc-ws-channel \
        --dangerously-skip-permissions"

    sleep 1

    if tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "✅ Agent running"
      echo ""
      echo "   Attach   : tmux attach -t $SESSION"
      echo "   Detach   : Ctrl+B then D"
      echo "   Stop     : $0 stop"
      echo "   Log file : /tmp/claude-agent.log"
    else
      echo "❌ Failed to start — check /tmp/claude-agent.log"
      exit 1
    fi
    ;;

  stop)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      tmux kill-session -t "$SESSION"
      echo "✅ Session '$SESSION' stopped"
    else
      echo "ℹ️  No session '$SESSION' found"
    fi
    ;;

  logs)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      tmux attach -t "$SESSION"
    else
      echo "❌ No session '$SESSION' found — run: $0 start"
      exit 1
    fi
    ;;

  *)
    echo "Usage: $0 [start|stop|logs]"
    exit 1
    ;;
esac
