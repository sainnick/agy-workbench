#!/usr/bin/env bash
# 🦞 微信 ClawBot V3.0 自动自愈守护脚本（崩溃 3 秒自动重启）
DIR="/Users/eru/Desktop/agy工作站/.agents/clawbot"
LOG="$DIR/bridge.log"
while true; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting ClawBot bridge.mjs V3.0..." >> "$LOG"
  node "$DIR/bridge.mjs" >> "$LOG" 2>&1
  EXIT_CODE=$?
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] bridge.mjs exited with code $EXIT_CODE, restarting in 3s..." >> "$LOG"
  sleep 3
done
