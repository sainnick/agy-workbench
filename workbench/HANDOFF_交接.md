# 交接：工作站审计 + 微信桥加固 + 波妞工作台

> 2026-11-06 22:05 · 交接人：Claude 会话「工作站架构审视与工作台设计」
> 接手前先读：本文件 → `workbench/工作流审计与Claude主导改造方案.md`（来龙去脉）→ `MEMORY_MASTER.md` 末尾几条 eru 定调
> 最新分拣状态见文末。22:05 与 22:20 条目保留作排查记录。

## 一、现在有什么（都在跑）

| 东西 | 位置 | 怎么用 / 状态 |
|---|---|---|
| 微信桥（V3 + 加固） | `.agents/clawbot/` | `watchdog.sh`（守护）→ `bridge.mjs`。**改了 bridge.mjs 才需要重启**：`kill <bridge 的 PID>`，watchdog 3 秒内用干净环境自动拉起；不要从 Claude Code 的 shell 直接 `node bridge.mjs`。其它脚本每次调用都是新进程，改完立刻生效 |
| 版本记录 | `.agents/clawbot/.git`（只在本机） | `git log` 看每次改动；`18e7403` 是加固前基线。提交时用 `git -c user.name=eru -c user.email=eru@local commit` |
| 路由表 / 验收模板 / 分拣开关 | `.agents/clawbot/rules.json` | 唯一事实来源。每条消息重新读，改完不用重启 |
| 波妞工作台 | `workbench/server.mjs` + `index.html` + `projects.json` | 桌面 `波妞工作台.app` 双击：没起服务就先起（127.0.0.1:4800），再用独立 Chrome 窗口（单独配置目录 `~/Library/Application Support/PonyoWorkbench`）打开 |

### 桥现在的行为
- **路由顺序**：精确引用回原窗口，明确改投、窗口锁定和唯一项目关键词仍可直达。普通追问、附件、引用失配和分发反馈由原总控结合微信上下文处理。独立 Flash 分拣已停用。
- **自然语言**（eru 不打斜杠）：「还有啥待办」「截个屏」「电脑状态怎么样」「发给 X / 不对转给 X」「（引用提醒）不用做了」。实现在 `bridge.mjs` 的 `handleNaturalIntent`
- **验收闸门**（`weixin-send.mjs` → `applyProofGate`）：声称完成但不够格 → 降级「🟡 进度」；文稿/成片够格 → 交 Claude 只读审查（`job-runner.mjs` 的 `engine=review`），不过就退回 AGY 窗口，最多 2 轮。`cmd:` 回执已停用
- **承诺追踪**（`commitments.mjs`）：「马上 / 正在 / 接下来做 X」计时，只有验收通过才算兑现；到期提醒 eru + 催窗口（每窗口 2 小时最多 2 次）
- **看门狗**（`agy-route.mjs` 的 `watchDelivery` / `watchTurnEnd`）：窗口卡住、或一轮停了 5 分钟没回话 → 告诉 eru；最后一步 RUNNING 不算停
- **收信**：处理完才推进游标 + `handled_ids.json` 去重（至少一次）；agentapi 调用 90 秒超时
- **给 eru 的话**：不显示 msg 编号、不教斜杠指令；提醒里引用回复能回到对应窗口（编号存在 `msg_session_map.json` 里）

### 测试开关
`CLAWBOT_DRY_RUN=1`（不真发微信）、`CLAWBOT_BRAIN_DIR=<假目录>`、`CLAWBOT_WATCH_{MS,ERR_MS,POLL_MS,TOTAL_MS}`、`CLAWBOT_TURN_QUIET_MS`、`CLAWBOT_AGENTAPI_TIMEOUT_MS`、`CLAWBOT_LLM_ROUTER=1`（恢复旧的 Argon 总控兜底）。测试用的 delegations 记录要带 `"test": true`，否则会被当成真实 Claude 调用证据。

## 二、没做完（按优先级）

1. **分拣器卡住**：eru 定了用 **Gemini 4 Argon Low**（不要用 Claude）。代码已写好（`bridge.mjs` 的 `classifyRoute`，调用 `agy --model gemini-4-argon-low --output-format json --json-schema … -p=…`，在空目录 `classifier_cwd/` 里跑）。在完整终端环境实测约 24 秒、8.5k token、判对；**但在 bridge 的精简环境（只有 HOME/USER/PATH）里 `agy -p` 卡住不返回**，所以 `rules.json` 的 `classifier` 暂时设为 `off`。排查方向：补 `TMPDIR` / `LANG` / `SHELL` / `XPC_*` 等环境变量，或用 `/bin/zsh -lc` 包一层再跑；修好后把 `classifier` 改回 `agy-argon-low`（不用重启）。注意 bridge 收信是串行的，分拣期间后面的消息会等着
2. **用量页按 eru 给的参考图重做**：eru 说用量不用在首页占这么多地方，首页以项目和待拍板为主。做法：在侧栏加一个「用量」页，参考样式是一排数字（累计 / 峰值单日 / 今天 / 连续天数）+ 日历热力图 + 每日趋势 + 模型占比环图；概览只留一行用量摘要。数据都在 `server.mjs` 的 `days` / `spend` / `burn` 里，热力图需要把 `days` 扩到更长周期
3. **新流程还没被真实交付完整走过**：Claude 审查、退回、承诺到期都只在测试里跑过。下次有窗口真交东西时，在工作台「验收」页和 `bridge.log` 里看实际效果
4. **精简版 GEMINI.md**：草案在 `workbench/GEMINI_精简版草案.md`，等 eru 拍板。注意 `GEMINI.md` 在 21:08 被别的会话改过（删了「点点」条款），替换前要重新对照
5. **开机自启没装**：重启电脑后 watchdog / bridge 不会自己起来。V3 会话写了 `.agents/clawbot/com.ponyo.clawbot.plist`，需要 eru 手动装（往 `~/Library/LaunchAgents` 写会被权限拦）。工作台服务靠桌面 App 拉起，不用自启

## 三、已知的小毛病
- 5 分钟内跟某项目聊过后，随口问的全局问题会先到那个项目窗口；eru 说「交给总控」可改投
- 自然语言识别靠词表，漏掉的说法会当普通消息投出
- 窗口被催过、承诺还没兑现时，不登记它的新承诺，直到 eru 给它派新消息
- 审查任务拿不到 msgId 时（窗口从没经桥投递过），轮数不会按新任务清零
- 工作台「最新汇报」读 `msg_session_map.json`，只保留最近 200 条发件

## 四、eru 的定调（必须遵守）
- 全程中文；称自己「波妞」
- 工作台：Mac 原生风、极简，**页面上不写任何防御式 / 解释性文字**；不替 eru 加他没说的审美（他反感「极简暗黑美学」这类自作主张）
- 微信里：**不用斜杠指令、不显示编号**，按语义直接办；回复要短
- AGY 保留当主力执行，靠强约束管；判断类的轻活用 **Gemini（Argon Low）**，不用 Claude 额度
- Antigravity 权限（第一层）**先不设**，有时需要让 AGY 改规则；验收脚本被改的风险靠 git 兜底
- Persona / SheerID 代认证、批量注册账号转卖这两条线：Claude 不参与，工作台里只显示「已停」
- 红线照旧：不碰 `~/.mihomo-claude`、`LaunchAgents`、`/etc/hosts`；不读凭据；Claude CLI 只用 `CLAUDE_CONFIG_DIR=/Users/eru/.claude-cli` + 7897 代理

## 五、协作
- **桥只允许一个会话改**。改之前确认没有别的会话在动 `.agents/clawbot/`（看 `git status` 和文件修改时间）
- 「AGY 工作站架构深度审计」那个 Claude 会话写了 V3，答应只读，可以叫它做复审；Codex 线程「审计并改造 AGY 微信工作站」做过只读审计

## 22:12 追加
- **用量页已做完**：侧栏「用量」，包含一排数字、26 周热力图、7/30 日趋势、模型环图和「花在哪」。概览改成以待拍板和进行中为主，用量只留顶部一行。桥发的系统提醒不再算作窗口汇报。
- **分拣器排查进行到一半**：只给 HOME/USER/PATH 时，`agy -p` 50 秒超时；再补 TMPDIR/SHELL/LOGNAME 仍然超时。完整环境（变体 C）的结果还没出来，对照脚本在 scratchpad 的 `agy_env_test.mjs`。下一步：把完整环境的变量逐个二分，找出缺的是哪个，补进 `bridge.mjs` 的 `classifyRoute` 里 spawn 的 env。如果完整环境也超时，就说明不是环境变量的问题，改查后台进程运行时缺什么（比如登录态、钥匙串）。

### 22:20 追加（接手会话排查分拣器）
- 结论：**不只是环境变量的问题**。完整环境（变体 C）同样超时：0 token，finished_reason=print_timeout。
- 不带代理（bridge 现在的 HOME/USER/PATH）：日志里是 `dial tcp …googleapis… i/o timeout`，直连 Google 不通，而且 agy 会**无视 --print-timeout 一直挂着**（测试进程 4 分钟后还在）。所以 classifyRoute 的 env 至少要补 `HTTPS_PROXY/HTTP_PROXY=http://127.0.0.1:7897`、`NO_PROXY=localhost,127.0.0.1`，外加 spawn 层自己的硬超时 + SIGKILL。
- 带上 7897 代理以后：登录（钥匙串）、loadCodeAssist、fetchAvailableModels 都通，消息也发出去了，但回合不出结果。一次是 streamGenerateContent 有 ResponseID 却没有内容，另外两次（45 秒、150 秒）干脆没有发起生成请求。所以卡在 agy 回合本身，还不确定是不是残留的 agy 进程或 Antigravity App 的影响。
- 残留进程：PID 70158（上一会话的对照测试，已经跑了 14 分钟以上）、71014（本会话的直连测试）。按 PID 结束被权限拦了，等 eru 处理。清掉后再用带代理的环境测一次，如果能出结果，就把代理变量补进 classifyRoute。
- rules.json 的 classifier 维持 off，bridge.mjs 没改。日志在本会话 scratchpad 的 agyA.log（直连）、agyP.log / agyL.log（带代理）。

## 2026-11-06 Flash Low 后台分拣（历史）

- eru 确认由波妞接手并按推荐实施。引用、锁定、唯一关键词及 5 分钟内的话题续接仍由规则直接判断。只有模糊文本会先回确认，再后台调用 `gemini-3.8-flash-low`。一次最多一个模型进程，其他模糊消息直接询问项目名。35 秒硬超时，手动选定项目后丢弃迟到的分类结果。
- 保留提交 `0400f2b` 中的 `7897` 代理与单键输出方案。`rules.json` 当前已启用 Flash Low，改回 `off` 后，模糊消息直接询问项目名。
- 验收覆盖后台返回、手动抢先选择、明确的新指令、过期分类、引用旧待选消息、未知结果、超时及非法返回。新版函数用合成消息和完整项目表实跑约 15 秒，正确判为商业客单。watchdog 已拉起新桥进程并进入微信长轮询。首次真实歧义消息的往返仍待观察。提交 `0de693f`。

### Argon Low 试跑记录（后续已改用 Flash Low 后台分拣）
- 残留的 agy 进程 70158 / 71014 后来自己退出了，不用再管。
- 已修，提交在 clawbot git：① classifyRoute 启动 agy 时显式带上 7897 代理（HTTPS_PROXY / HTTP_PROXY / NO_PROXY）；② 去掉 `--json-schema`，改成让模型只回一个路由键，由 bridge 本地解析。带 schema 时 agy 答完还要强制再调一次提交工具（`force_invocation`），回合会卡到超时：带 schema 2/2 失败，不带 2/2 成功。
- 还剩的问题：上游生成太慢。同一句话连跑 5 次，3 次判对（15 / 39 / 51 秒），2 次 50 秒还没生成完。日志显示时间耗在等 streamGenerateContent 返回，本机没卡，是 Google 后端慢还是代理慢分不出来。
- 这轮试跑期间 classifier 关闭。现用的 Flash Low 后台分拣和开关见上节。

### 微信引用和改投误发修复

- 微信消息 ID 已查到总控时，直接回原总控并登记实际投递。未登记或原窗口不可用的引用由用户指定，不按内容片段或近期项目猜。
- 「客户端」不会因含「客户」进入商业客单。未知的「发给 X」与「投错了」等反馈由桥直接回应。最近项目只供明显续话直投或作为 Flash Low 的上下文。
- 四条实际误投案例已用隔离收信夹具回归。另验证了正常客单关键词、指定窗口、过期分拣和原窗口不可达。修复已通过 watchdog 重载，提交 `c4fcc7b`。
- 此轮两条无引用的合成客户端问题都达到 Flash Low 的 35 秒硬超时。未取得模型分类。超时后询问项目的行为通过隔离测试，实际微信尚待复测。

### 23:06 真实引用验收与服务复查

- 真实微信已按引用 ID 进入原总控。桥记录投递成功，微信确认和总控随后发出的回复都已登记。无引用的模糊话题仍待用真实消息验收。
- 复查时发现工作台服务和微信桥守护进程均已退出，日志未记录退出原因。已按现有方式恢复，随后独立复查确认工作台首页和数据接口返回 HTTP 200，微信桥重新进入长轮询。桥的开机自启服务尚未登记。
- 工作台微信页能显示该条消息的引用标记，但没显示已回总控。页面目前用桥日志中的直投行推断去向，而总控路径写的是另一类投递行。真实去向以桥收发记录为准。

### 23:17 误投复盘与总控分发恢复

- 「还没进去啊怎么？」和截图相隔不到一秒到达，桥的收信日志两条都没有解析出引用 ID。旧桥分别提示选择去向，后来又把分发纠错用 Flash 判给了商业客单。
- 无明确去向的消息交回原总控，带上同一微信最近两条真实答复。同一联系人 5 秒内文字和附件拆开发来时补上相邻上下文，后到附件跟随已确认的去向。精确引用和明确项目直达。
- 两种文字与截图到达顺序、分发纠错、指定项目、引用和总控不可达均用隔离收信夹具回归通过。watchdog 重载后进入微信收信。提交 `a7e867e`。
- 「发错了」优先交总控，即使引用了误投回执，也保留原消息供后续「发给某项目」改投。两步隔离回归通过，已重载，提交 `51f51bf`。

### 23:44 实际收信复查与总控看门狗

- 23:39 的真实微信已进入原总控，桥记录投递成功，总控 transcript 出现了原消息和后续处理步骤。单凭投递成功不能确认已回微信。
- 原总控路径现已接入投递看门狗。转交其他窗口后由下游流程跟进，桥发的投递回执不算总控答复。隔离回归通过，watchdog 重载后重新进入收信，提交 `4774283`。
