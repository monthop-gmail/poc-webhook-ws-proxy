#!/usr/bin/env python3
"""
cf-webhook-ws-proxy — Python WebSocket Client Example
Connects to the proxy and prints every incoming webhook event.

Usage:
    pip install websockets
    python client.py
    python client.py --url wss://cf-webhook-ws-proxy.monthop-gmail.workers.dev/ws --room ci
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import signal
import sys
from datetime import datetime
from typing import Any

try:
    import websockets
    from websockets.asyncio.client import ClientConnection, connect
except ImportError:
    print("Error: websockets library not found.\nRun: pip install websockets>=13.0")
    sys.exit(1)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)


# ─── Pretty Printers ──────────────────────────────────────────────────────────

def _fmt_json(data: Any, indent: int = 2) -> str:
    return json.dumps(data, indent=indent, ensure_ascii=False, default=str)


def handle_message(raw: str) -> None:
    """Dispatch an incoming message to the appropriate handler."""
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("Received non-JSON message: %s", raw[:200])
        return

    msg_type = msg.get("type", "unknown")

    if msg_type == "connected":
        log.info("✅ Connected  clientId=%s  room=%s", msg.get("clientId"), msg.get("room"))

    elif msg_type == "webhook":
        ts = msg.get("timestamp", datetime.utcnow().isoformat())
        source = msg.get("source", "—")
        body = msg.get("body")
        print(
            f"\n{'─' * 60}\n"
            f"📨  WEBHOOK EVENT\n"
            f"    Time   : {ts}\n"
            f"    Source : {source}\n"
            f"    Room   : {msg.get('room', '—')}\n"
            f"    Body   :\n{_fmt_json(body)}\n"
            f"{'─' * 60}"
        )

    elif msg_type == "pong":
        log.debug("Pong received  ts=%s", msg.get("timestamp"))

    elif msg_type == "error":
        log.error("Server error: %s", msg.get("message"))

    else:
        log.info("Unknown message type=%s: %s", msg_type, _fmt_json(msg))


# ─── Client ───────────────────────────────────────────────────────────────────

async def run_client(url: str, room: str, ping_interval: int = 30) -> None:
    full_url = f"{url}?room={room}"
    log.info("Connecting to %s", full_url)

    reconnect_delay = 2  # seconds, doubles on each failure (max 60 s)

    while True:
        try:
            async with connect(
                full_url,
                ping_interval=ping_interval,
                ping_timeout=20,
                close_timeout=10,
            ) as ws:
                log.info("WebSocket open")
                reconnect_delay = 2  # reset on successful connect

                async for raw_message in ws:
                    handle_message(str(raw_message))

        except websockets.exceptions.ConnectionClosedOK:
            log.info("Connection closed cleanly. Reconnecting in %ds…", reconnect_delay)
        except websockets.exceptions.ConnectionClosedError as exc:
            log.warning("Connection closed with error: %s. Reconnecting in %ds…", exc, reconnect_delay)
        except OSError as exc:
            log.error("Network error: %s. Retrying in %ds…", exc, reconnect_delay)
        except Exception as exc:  # noqa: BLE001
            log.error("Unexpected error: %s. Retrying in %ds…", exc, reconnect_delay)

        await asyncio.sleep(reconnect_delay)
        reconnect_delay = min(reconnect_delay * 2, 60)


# ─── Entry Point ──────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Connect to cf-webhook-ws-proxy and receive webhook events."
    )
    parser.add_argument(
        "--url",
        default="wss://cf-webhook-ws-proxy.monthop-gmail.workers.dev/ws",
        help="WebSocket endpoint (default: wss://cf-webhook-ws-proxy.monthop-gmail.workers.dev/ws)",
    )
    parser.add_argument(
        "--room",
        default="default",
        help="Room/channel name (default: default)",
    )
    parser.add_argument(
        "--ping-interval",
        type=int,
        default=30,
        metavar="SECONDS",
        help="Heartbeat ping interval in seconds (default: 30)",
    )
    args = parser.parse_args()

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    # Graceful shutdown on Ctrl+C / SIGTERM
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, loop.stop)

    try:
        loop.run_until_complete(
            run_client(args.url, args.room, args.ping_interval)
        )
    finally:
        loop.close()
        log.info("Client stopped.")


if __name__ == "__main__":
    main()
