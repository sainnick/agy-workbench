# AGY 波妞工作台 (Antigravity Workstation Hub & WeChat ClawBot V3)

本仓库是 `/Users/eru/Desktop/agy工作站` 的架构与核心源码打包（供 GPT / 架构审计审阅）。

## 目录结构

- `GEMINI.md`（同 `CLAUDE.md` / `AGENTS.md`）：全局工作站导航地图、工作铁律与红线
- `MEMORY_MASTER.md`：全局总控记忆、窗口职责边界与微信桥用法
- `AUDIT_2026-11-06_工作站架构审计.md`：工作站历史架构审计记录
- `workbench/`：**波妞工作台（Web 控制台，`http://127.0.0.1:3899`）**
  - `server.mjs`：工作台本地后端服务（读取各项目窗口实时状态、未核验回执、承诺账本、一键唤醒 AGY / Claude / Finder）
  - `index.html`：工作台前端单页应用
  - `projects.json`：全盘业务线与专窗映射配置
  - `工作流审计与Claude主导改造方案.md` & `HANDOFF_交接.md`：最新架构改造与交接文档
- `.agents/clawbot/`：**微信 ClawBot V3 桥接与防造假核验层**
  - `bridge.mjs`：微信消息监听、引用溯源、自动入箱与总控分发守护进程
  - `agy-route.mjs`：总控向各业务专窗（AGY / Claude CLI）原话投递路由器
  - `weixin-send.mjs`：带强制 `--proof` 回执核验的微信下发工具
  - `proof.mjs`：物理文件 / URL / Mockup / Research 真实性自动核验器
  - `commitments.mjs`：承诺账本登记与完结闭环
  - `job-runner.mjs`：Claude 后台任务运行器
  - `rules.json`：各项目路由键、目录白名单与回执核验预设规则
  - `src/`：OpenClaw 微信通道 TypeScript 底层源码
