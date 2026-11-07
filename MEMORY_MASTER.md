# 波妞工作站总记忆（MEMORY_MASTER.md）

> 更新：2026-11-06 21:20（Claude Code 按审计 P2 重构；旧版全文在 `_archive/2026-11-06/MEMORY_MASTER_旧版.md`）
>
> 本文件只放**长期不变的全局规则**和**窗口登记**，所有窗口开工先读。
> - 各项目的进度、最近一次拍板、项目专属规则 → `workbench/projects.json`（工作台 http://127.0.0.1:4800「项目」页可看可改）。项目里有新定调，写回那里。
> - 会话 ID、目录、路由关键词 → `.agents/clawbot/rules.json` 的 `routes`（唯一事实来源，改会话 ID 只改这里）。

---

## 一、全局铁律（eru 定）

1. **不拍脑袋**：选题、开场、剧本、玩法、技术选型、选品与定价，先查证再下结论。来源可以是点点 / 小红书（`agent-reach`）、GPT（`codex exec`）/ Claude、Gemini Deep Research。
   - 汇报时附 `--proof=research:/绝对路径/证据.md`。证据文件里至少要有 5 个真实来源链接，脚本会抽查能不能打开；没附会被自动标【调研未经核验】。
   - 只跑了普通搜索就说普通搜索，不准说成 Deep Research。
2. **先拍板再动手**：eru 明确说「可以 / 就按这个做 / 开干」之前，不写业务代码、不跑全片渲染、不开下一集。
3. **原话不改**：转发 eru 的话只传 msg 编号（见第三节），不替 eru 加需求、不替 eru 定方案。
4. **文件化**：eru 批过的规则和定调当轮写进文件。项目级的写进该项目自己的 `CLAUDE.md` / `GEMINI.md` / `MEMORY.md` 和 `projects.json`；全局级的写进本文件。
5. **诚实**（`weixin-send.mjs` 会当场核验，不靠自觉）：
   - 说「完成 / 上线 / 跑通 / 修好」，必须带能通过核验的回执。`echo`、`true`、占位页、本机地址都不算。
   - 说「Claude 做的 / GPT 审的」，就必须真的调了 Claude CLI / Codex（标准调用方式见 `GEMINI.md` 红线第 5 条）。脚本会查该项目目录 6 小时内的调用记录，查不到会标【疑似冒充】。
   - 没接真实后端就说是原型 / Mock；扫到 mock / `SAMPLE_` 特征会被自动标【原型/Mock】。
   - 本机地址、临时隧道（trycloudflare 等）不能说成生产站。

---

## 二、窗口登记

| 路由键 | 窗口 | AGY 会话 ID | 目录 |
|---|---|---|---|
| `sanhao` | 叁号暗房 | `a71da96f-396c-44bd-8b68-4d04679cda4c` | `/Users/eru/work/philosophy-remotion` |
| `zhezhou` | 折舟像塑特效 | `32cca896-e92c-4078-860e-d0d24be7dcf6` | `/Users/eru/effect` |
| `echo` | 回声档案 Echo | `497616b9-c116-48c5-9e7f-5a8d4baea92a` | `/Users/eru/echo` |
| `zeroclinic` | 第零诊室 Zero Clinic | `f5fc7b1d-3bf0-4bc6-897f-7d902efd07d3` | `/Users/eru/AIGC` |
| `game` | 时代进化小游戏 | `4331ec68-bb75-45d7-88f5-042d86c0a4cb` | `/Users/eru/Desktop/agy工作站/小游戏研发_灰盒原型` |
| `h3` | H3 算力工作台 | `ad706c0a-e897-4fe7-85f6-7b8fc557708e` | `/Users/eru/Desktop/agy工作站/.agents/ultra_hub/h3_studio_webui` |
| （总控） | 波妞总控路由 | `df666dc1-4b27-4fe4-ae54-5911bf805f99`（前任 `f9055825…`） | 本目录 |

- 一事一窗：不同业务线不塞进同一个窗口。
- 总控只负责选目标，不替子窗口干活。
- 不进路由、Claude 不参与的两条线（均已停）：闲鱼批量注册账号转卖卡密（`450abda7`）、Task Portal 海外认证派单（`b8f31126`，前任 `a4907a6b`）。Task Portal 的落地事实：Persona / SheerID 身份验证不支持第三方代验，服务器会拦截相关链接；闲鱼只做了订单号手动绑定；临时 cloudflared 预览不得称为固定生产站。

---

## 三、微信 ClawBot（V3）

- **进程**：bridge 由 `.agents/clawbot/watchdog.sh` 托管，独立进程组，崩了 3 秒内重启，日志在 `.agents/clawbot/bridge.log`。
  - **不要**在 AGY 终端里另起 `node bridge.mjs`，会出现双实例重复处理消息。
  - 要重启时，按 PID 结束 `bridge.mjs`，watchdog 会自动拉起。不准用 `pkill` / `killall`。
- **路由顺序**：精确引用、明确项目、改投和窗口锁定继续直达。其余有文字的消息由 Gemini 4 Argon Low 结合上条原话与同一微信最近答复后台判断。超时、无法确认、引用失配及分发纠错交原总控。相邻拆开的文字和附件补上上下文，后到附件跟随已确认去向。
- **总控转发**（原话由脚本逐字投递，`--note` 会被标成「非 eru 原话」）：
  `node /Users/eru/Desktop/agy工作站/.agents/clawbot/agy-route.mjs route --msg=<编号> --to=<路由键|会话ID|codex:<线程ID>|claude:<路由键>|new:<标题>> [--note="一句话备注"]`
- **回复微信**：
  `node /Users/eru/Desktop/agy工作站/.agents/clawbot/weixin-send.mjs '结论' [/绝对路径/文件] --session=<本窗口会话ID> [--proof=…]`
  - 不带 `--session` 会被记为未归属。
  - **🔴 微信短消息铁律（2026-11-07 eru 批评「发这么长一段干嘛」后定）**：微信是手机聊天窗口。日常汇报 150~300 字、最多 500 字，只写「一句结论 + 下一步 / 要拍板的事」。严禁把整篇 .md 报告 `read_text()` 塞进正文，严禁表格、长列表；详细内容写进文件留电脑，eru 要看就作为附件发，正文只写一句说明。
  - 脚本硬卡控：正文超 600 字、含 Markdown 表格、列表超 8 条、正文照抄所附 .md，`weixin-send` 直接拒发（退出码 3），必须缩写后重发，不许拆成多条绕过。job-runner 系统消息和 `notifyWeixin` 超规时，全文自动落盘到 `.agents/clawbot/outbox/`，微信只发摘要和路径。
  - 回执写法：`file:/路径` | `url:地址` | `cmd:"测试命令"` | `mock:/项目目录` | `research:/证据.md`，可以写多个。
- **执行引擎**：默认 AGY，按 project 分发。Claude / Codex 只在 eru 点名（`/claude <路由键> <指令>`、`/codex <指令>`）或重投（`/retry <msg编号> claude`）时使用，由 `job-runner.mjs` 在独立进程里跑，记账到 `delegations.jsonl`。
- **卡死告警**：每次投递后会起一个 `watch` 进程盯着窗口。消息送达后报错停住，或者 4 分钟没有任何动作，会发微信告警；窗口在忙、消息还在排队时不算卡死。
- **微信指令**：`/status` `/screen` `/sessions` `/use` `/unlock` `/todo` `/verify` `/codex` `/claude` `/retry` `/qwen` `/help`
- **调用方式**：调 `weixin-send` / `agy-route` 时用同步执行（普通命令或 `subprocess.run`），不要用 `subprocess.Popen` 裸退，否则会被沙盒回收。
- **总控窗口不要直接 `read_file` 读大图**：用 `swift` Vision 做本地 OCR，或者把路径交给子窗口去读。
- **总控轮换**：总控超过 500 步变慢时，新建一个总控会话，然后执行 `node /Users/eru/Desktop/agy工作站/.agents/clawbot/agy-route.mjs set-router <新会话ID>`（会自动记下旧 ID）。

---

## 四、近期记录

- **2026-11-06 架构审计与 V3 改造**（Claude Code 会话）：见 `AUDIT_2026-11-06_工作站架构审计.md`。
  - 同一晚有个 Codex 线程「审计并改造 AGY 微信工作站」（`01a1b0e2`），它只读、没改文件。它指出"空命令 / 占位页也能拿到绿色回执"，这个问题已修复。
  - V3 的改造是 Claude Code 会话做的，不是 Codex 线程。工作台方案文档里写成了 Codex，那是记错了。
- **2026-11-06 波妞工作台**：在 `workbench/` 目录，地址 127.0.0.1:4800，双击 `双击打开_波妞工作台.command` 启动。配套方案文档是 `workbench/工作流审计与Claude主导改造方案.md`。
  - eru 定调：工作台 Mac 风极简，页面上不要放防御式的说明文字。
  - 那份方案里还有一个缺口没拍板：规则都不中时，仍然交给总控 LLM 选目标。
- **eru 定调（2026-11-06 21:20）**：AGY 能力过关但不靠谱，**保留 AGY 当主力执行，不把项目切给 Claude**；改为三层强约束——Antigravity 权限 deny/ask 规则（禁止改验收器与代理文件、渲染/部署/付费须批准）、桥层任务卡 + 只有验收器能发「完成」+ 停滞看门狗、Claude CLI 在文稿/方案/成片交付节点做只读审查。详见 `workbench/工作流审计与Claude主导改造方案.md` 末节。
- **2026-11-06 21:25 强约束上线**（Claude「工作站架构审视与工作台设计」会话实现，eru 授权）：rules.json 加 acceptance 验收模板；weixin-send 只有验收通过才算「完成」；文稿/成片自动交 Claude CLI 只读审查，不过退回 AGY 最多 2 轮；承诺追踪（/todo、/drop）；没回话看门狗；cmd: 回执停用。clawbot 目录已建本地 git 可回滚。桥只由本会话改，V3 会话与 Codex 只读复审。
- **eru 定调（2026-11-06 21:40）**：① Antigravity 权限先不设（需要时得让 AGY 改规则）；② 微信里不打斜杠指令，桥要按语义直接办（待办/截屏/状态/改投/撤销已支持）；③ 兜底路由不再交给 Argon 总控，改为沿用 5 分钟内项目 + 编号/项目名选择。
- **2026-11-06 22:05 交接**：工作台/微信桥加固的接手说明在 `workbench/HANDOFF_交接.md`（现状、没做完的 5 件、eru 定调）。eru 定调：分拣判断用 Gemini 4 Argon Low（不用 Claude）；用量挪到单独页面、首页以项目为主；桌面有 `波妞工作台.app`。
- **2026-11-06 Flash 后台分拣试行（历史）**：eru 拍板用 Gemini 3.8 Flash Low 做后台分拣，确定性路由继续直投。一次只跑一个分拣进程，模型 35 秒硬超时。用户先选项目时丢弃迟到结果。桥已通过 watchdog 重载，`rules.json` 分拣已开启。本地版本 `0de693f`，验收记录见交接。
- **微信误投第一轮修复（历史）**：总控引用以微信消息 ID 回原会话，「客户端」不触发客单关键词。不存在的改投目标与投错反馈由桥当场回话。最近项目只用于明确续话，模糊新话题交 Flash Low 判断。四条现场案例回归通过，已重载，提交 `c4fcc7b`。

- **微信分发现行规则（23:17 误投后）**：独立 Flash 分拣判错项目，已停用。短追问、附件和分发反馈由原总控结合上下文处理。只改微信分发。明确的「发错了」也由总控接手，保留原消息供后续改投。隔离回归已通过，watchdog 重载后已进入微信收信，提交 `a7e867e`、`51f51bf`。

- **总控投递看门狗**：23:39 真实微信确认进入原总控。总控直接投递补接看门狗，区分桥回执与总控答复，转交后由下游流程跟进。隔离回归与重载通过，提交 `4774283`。

- **2026-11-07 微信分发定调**：eru 指定波妞接手，将需要语义判断的微信切到 Gemini 4 Argon Low。队列先落盘，模型判断不挡明确投递。精简环境的真实模型合成样例分别在 16.9 秒和 15.7 秒归到回声档案与总控。微信桥已重载，提交 `3f533ca`。
