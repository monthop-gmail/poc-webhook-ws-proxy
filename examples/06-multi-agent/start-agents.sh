#!/usr/bin/env bash
# Example 06: Multi-Agent Background (tmux)
# ──────────────────────────────────────────
# รัน Claude หลาย agent พร้อมกัน แต่ละตัว listen คนละ room
#
#   room=ci    → วิเคราะห์ CI/CD alerts
#   room=chat  → ตอบ chat ทั่วไป
#   room=line  → ตอบ LINE webhook
#
# Usage:
#   ./start-agents.sh start [ci|chat|line|all]   # default: all
#   ./start-agents.sh stop  [ci|chat|line|all]
#   ./start-agents.sh status
#   ./start-agents.sh logs  [ci|chat|line]

set -euo pipefail

PROXY_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
EXAMPLE_DIR="$(cd "$(dirname "$0")" && pwd)"

AGENTS=(ci chat line)

start_agent() {
  local name="$1"
  local session="agent-$name"
  local mcp_config="$EXAMPLE_DIR/agents/$name/mcp.json"
  local claude_md="$EXAMPLE_DIR/agents/$name/CLAUDE.md"

  if tmux has-session -t "$session" 2>/dev/null; then
    echo "⚠️  agent-$name already running"
    return
  fi

  echo "🚀 Starting agent-$name  (room=$name)"

  tmux new-session -d -s "$session" -x 220 -y 50 \
    "cd '$PROXY_DIR' && claude \
      --mcp-config '$mcp_config' \
      --dangerously-load-development-channels server:poc-ws-channel \
      --dangerously-skip-permissions \
      --append-system-prompt \"$(cat "$claude_md")\""

  sleep 1

  if tmux has-session -t "$session" 2>/dev/null; then
    echo "   ✅ agent-$name running  (tmux: $session)"
  else
    echo "   ❌ agent-$name failed to start"
  fi
}

stop_agent() {
  local name="$1"
  local session="agent-$name"

  if tmux has-session -t "$session" 2>/dev/null; then
    tmux kill-session -t "$session"
    echo "✅ agent-$name stopped"
  else
    echo "ℹ️  agent-$name not running"
  fi
}

ACTION="${1:-status}"
TARGET="${2:-all}"

case "$ACTION" in

  start)
    if [[ "$TARGET" == "all" ]]; then
      for name in "${AGENTS[@]}"; do start_agent "$name"; done
    else
      start_agent "$TARGET"
    fi
    echo ""
    echo "Chat UIs:"
    for name in "${AGENTS[@]}"; do
      echo "  https://cf-webhook-ws-proxy.monthop-gmail.workers.dev/chat?room=$name"
    done
    ;;

  stop)
    if [[ "$TARGET" == "all" ]]; then
      for name in "${AGENTS[@]}"; do stop_agent "$name"; done
    else
      stop_agent "$TARGET"
    fi
    ;;

  status)
    echo "Agent status:"
    for name in "${AGENTS[@]}"; do
      if tmux has-session -t "agent-$name" 2>/dev/null; then
        echo "  ✅ agent-$name  (tmux: agent-$name)"
      else
        echo "  ⬜ agent-$name  not running"
      fi
    done
    ;;

  logs)
    if [[ -z "${2:-}" ]]; then
      echo "Usage: $0 logs [ci|chat|line]"
      exit 1
    fi
    log_session="agent-$2"
    if tmux has-session -t "$log_session" 2>/dev/null; then
      echo "Attaching to $log_session — Ctrl+B then D to detach"
      tmux attach -t "$log_session"
    else
      echo "❌ agent-$2 not running — run: $0 start $2"
      exit 1
    fi
    ;;

  *)
    echo "Usage: $0 [start|stop|status|logs] [ci|chat|line|all]"
    exit 1
    ;;
esac
