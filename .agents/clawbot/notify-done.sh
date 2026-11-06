#!/usr/bin/env bash
# 🦞 长耗时渲染/任务完成自动微信推送钩子
# 用法: bash /Users/eru/Desktop/agy工作站/.agents/clawbot/notify-done.sh "第零诊室 EP01 渲染完成" [/绝对路径/成片.mp4]
set -euo pipefail
MSG="${1:-🎉 后台任务已完成！}"
shift || true
node /Users/eru/Desktop/agy工作站/.agents/clawbot/weixin-send.mjs "$MSG" "$@"
