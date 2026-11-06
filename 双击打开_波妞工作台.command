#!/bin/zsh
# 双击：启动波妞工作台本地服务（已在跑就直接打开）
DIR="/Users/eru/Desktop/agy工作站/workbench"
if ! /usr/sbin/lsof -nP -iTCP:4800 -sTCP:LISTEN >/dev/null 2>&1; then
  nohup /opt/homebrew/bin/node "$DIR/server.mjs" > "$DIR/server.log" 2>&1 &
  sleep 1
fi
open "http://127.0.0.1:4800"
