# Examples

ตัวอย่างการใช้งาน poc-webhook-ws-proxy แต่ละ scenario

## เตรียม environment ก่อนรัน

```bash
# Terminal — Start all background agents
bash examples/06-multi-agent/start-agents.sh start

# Browser — Chat UIs
# https://cf-webhook-ws-proxy.monthop-gmail.workers.dev/chat?room=default
# https://cf-webhook-ws-proxy.monthop-gmail.workers.dev/chat?room=ci
# https://cf-webhook-ws-proxy.monthop-gmail.workers.dev/chat?room=chat
# https://cf-webhook-ws-proxy.monthop-gmail.workers.dev/chat?room=line
```

---

## 01 · Basic Chat

ทดสอบการส่ง message เข้า Claude แบบพื้นฐาน

```bash
bash examples/01-basic-chat/test.sh
```

---

## 02 · LINE Webhook

จำลอง payload จาก LINE Messaging API

```bash
bash examples/02-line-webhook/test.sh
```

ใช้ทดสอบ logic ก่อน wire ขึ้น LINE จริง — เพียงแค่ตั้ง webhook URL ใน LINE Console
ให้ชี้มาที่ `/webhook?room=line` ของ Worker

---

## 03 · CI/CD Alert

จำลอง GitHub Actions webhook ส่ง build/test result มา

```bash
# Build failed
bash examples/03-ci-alert/test.sh build-fail

# Tests failed (with coverage drop)
bash examples/03-ci-alert/test.sh test-fail

# Deploy successful
bash examples/03-ci-alert/test.sh deploy-success
```

---

## 04 · Permission Relay

ทดสอบ flow การ approve tool จาก browser แทน terminal

```bash
bash examples/04-permission-relay/test.sh
```

เมื่อ Claude ต้องรัน command → popup จะขึ้นใน `/chat` ให้กด **Allow** / **Deny**

---

## 05 · Background Agent

รัน Claude เป็น always-on agent

**tmux (development):**
```bash
chmod +x examples/05-background/start-tmux.sh
bash examples/05-background/start-tmux.sh start   # start
bash examples/05-background/start-tmux.sh logs    # attach
bash examples/05-background/start-tmux.sh stop    # stop
```

**systemd (production):**
```bash
# 1. แก้ PROXY_WS_URL และ PROXY_WEBHOOK_URL ใน .service file
# 2. Install
sudo cp examples/05-background/claude-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claude-agent

# ดู log
sudo journalctl -fu claude-agent
```

**CLAUDE.md (บอก Claude ว่าต้องทำอะไร):**
```bash
cp examples/05-background/CLAUDE.md.example CLAUDE.md
# แก้ตาม context ของ project จริง
```
