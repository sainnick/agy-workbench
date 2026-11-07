# Computer Use (GUI Agent) 提速与自进化训练方案调研（2026-11-07）

## 一、为什么当前纯视觉点击显得“慢且笨”？
当前子 Agent 采用的是最原始的 **「全屏截图 → Qwen 27B 视觉推理算坐标（4~5秒/次） → 单步点击 → sleep 3秒 → 再截图」** 循环，且每次任务都患“失忆症”（不记住上次成功的按钮坐标与筛选逻辑）。

## 二、2026 GitHub 工业界三大“免重训权重”训练与提速方案（实测查证）

1. **轨迹记忆与动作缓存（JIT Action Caching / Trajectory Memory）**
   - **标杆开源项目**：
     - `simular-ai/Agent-S`：https://github.com/simular-ai/Agent-S
     - `browser-use/browser-use`：https://github.com/browser-use/browser-use
     - `wjhou/awesome-computer-use-agents`：https://github.com/wjhou/awesome-computer-use-agents
   - **核心机制**：第一次跑通某个平台（如 X 搜索筛帖、Gemini 提取报告）后，把成功的**动作原语（DOM Selector / macOS AXUIElement 路径 / 坐标偏移 + 意图过滤规则）**自动写入本地 `trajectories.json` 技能库。第二次执行同任务直接 0.1 秒回放，跳过 90% 的视觉大模型思考。
2. **你做一遍它学会：人类示范录制（Learn from Demonstration）**
   - **标杆开源项目**：
     - `GAIR-NLP/PC-Agent-E`（ICLR 2026 `Trajectory Collection + Thought Completion`）：https://github.com/GAIR-NLP/PC-Agent-E
   - **核心机制**：开一个轻量级 macOS 事件监听脚本，eru 亲自在屏幕上操作 30 秒（比如怎么在 X 上看主页识别真假兼职帖、点哪里回复），脚本自动把您的鼠标点击目标、停留位置反推成结构化 SOP 技能，以后 Agent 100% 复刻您的操作直觉。
3. **无障碍树骨架优先 + 视觉兜底（Accessibility Tree Skeleton + Vision Fallback）**
   - **标杆开源项目**：
     - `vercel-labs/agent-desktop`：https://github.com/vercel-labs/agent-desktop
     - `browser-use/macOS-use`：https://github.com/browser-use/macOS-use
     - `bytedance/UI-TARS-desktop`：https://github.com/bytedance/UI-TARS-desktop
   - **核心机制**：90% 的按钮定位直接读 macOS `AXUIElement` 无障碍树或 Chrome DOM `getBoundingClientRect()`（仅需 5~10 毫秒，省 96% Token），只有遇到 Canvas 画布或防爬输入框才调用 Qwen 27B 视觉 + `CGEvent` 物理点击。
