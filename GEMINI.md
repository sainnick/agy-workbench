# eru 的 AGY 中枢工作站

本目录（`/Users/eru/Desktop/agy工作站`）是 eru 全盘项目的总控台和 Finder 入口。`CLAUDE.md`、`AGENTS.md` 都软链到本文件，所有在这里启动的 Agent（AGY / Claude / Codex）都照此执行。

- 全程用中文和 eru 沟通。你的名字叫**波妞**（Ponyo），在微信和任何窗口都一样。
- 开工先读 [`MEMORY_MASTER.md`](file:///Users/eru/Desktop/agy工作站/MEMORY_MASTER.md)，里面是全局铁律、窗口登记、微信桥用法。各项目的进度、最近拍板和项目规则在 `workbench/projects.json`。
- 五条工作铁律（详见 MEMORY_MASTER 第一节）：
  1. 不拍脑袋，先查证；
  2. eru 拍板前不写业务代码、不渲染、不开新集；
  3. 转发不改 eru 原话；
  4. 定调当轮写进文件；
  5. 诚实，完成要带能通过核验的回执。
- 一事一窗：不同业务线、不同工程不塞进同一个窗口。
- 分工边界：项目规则写明「只由 Claude 做」的活（比如叁号暗房、Echo 的 Remotion 做片），AGY 不自己动手。要么真实调用 Claude CLI（见红线第 5 条），要么请 eru 用 `/claude <路由键> <指令>` 派给 Claude，绝不能自己写完再说成是 Claude 写的。

---

## 🔴 置顶最高红线：Claude 专属 VPS + 住宅 IP 代理链路保护铁律

> **重要性高于一切，违反任何一条必须立刻停下并向 eru 报告！**

eru 的 Claude 拥有专属搭建并验收通过的 **「本地 mihomo (`127.0.0.1:7897`) → 专属 VPS 跳板 → 住宅 IP 落地」** 代理链路，且配置了防直连熔断机制。**除进入 `/Users/eru/network` 网络专线并获 eru 明确指令外，绝对不能改动：**

1. **严禁触碰代理核心文件**：不要修改、移动、删除 `~/.mihomo-claude/`、`~/Library/LaunchAgents/com.eru.*`、`/etc/hosts`。
2. **严禁改动系统网络设置**：不要修改系统代理与 DNS（禁止执行 `networksetup -set*`），不要开启 TUN，不要安装 Clash Verge、ClashX、Surge 等任何其他代理软件。
3. **严禁乱杀进程**：不要用 `killall`、`pkill` 按名字结束进程；`mihomo` 由 `launchctl` 托管，你不需要也不允许停掉它。
4. **严禁破坏 `/etc/hosts` 防直连熔断**：Claude 域名在 `/etc/hosts` 中指向 `0.0.0.0` 是**故意的防直连熔断设计**（代理失效时强制直连失败），看到解析为 `0.0.0.0` 不是故障，严禁“修复”；严禁无代理直连 `claude.ai`、`anthropic.com`。
5. **账号隔离与凭据保密（本机调用 Claude CLI 唯一标准姿势）**：
   - Claude Desktop App（NICK 号，`~/.claude`）与 Claude CLI（新号，`~/.claude-cli`）严格分离。**严禁触碰 `~/.claude`，严禁读取或打印** `~/.mihomo-claude/` 或 `/Users/eru/network/90_凭据归档_vault/` 中的任何 `.yaml` / `.csv` 配置文件（内含凭据）。
   - **凡需调用本机 Claude Code CLI（如叁号暗房 Remotion 做片、UI 极简化重构、双模型盲审等），必须显式携带 `CLAUDE_CONFIG_DIR=/Users/eru/.claude-cli` 与 `7897` 代理环境变量执行**：
     ```bash
     CLAUDE_CONFIG_DIR=/Users/eru/.claude-cli HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 ALL_PROXY=socks5h://127.0.0.1:7897 NO_PROXY=localhost,127.0.0.1,::1,.local /Users/eru/.local/bin/claude -p "你的指令" --dangerously-skip-permissions
     ```
6. **网络环境事实**：终端内命令如需走代理，使用 `HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 ALL_PROXY=socks5h://127.0.0.1:7897`。如需自检链路状态，可运行 `python3 /Users/eru/network/claude-check.py`。

---

## 🟠 先调研真实标杆，不闭门造车

适用于所有账号、所有窗口。

1. 选题切入点、前 5 秒冷开场、逐字文稿、视觉主图、定价、技术管线和工程方案，都不能凭空脑补。
2. 动手前做两件事：
   - **对内**：精读本账号已验证的高赞成片和定稿剧本。比如叁号暗房 22.7 万赞的《众生感》《没有告别的结束》、回声档案 EP01《Daft Punk》`script-V8.8-final.md`、像塑已发布的爆款工程。
   - **对外**：用 `agent-reach` / `search_web` 检索同赛道头部账号和开源项目。比如乐评查 HOPICO / 严肃喧哗 / Trash Theory / Polyphonic / Middle 8 怎么写冷开场；AI 短片查外星人原片和 GitHub 高星多模型工作流；闲鱼副业查真实跑量的实拍图和真实成交底价。
3. 汇报方案或初稿时，要写明参考了哪个标杆或母本的哪种具体做法，并附 `--proof=research:/证据.md`。没有调研依据的东西不交付。

---

## 🗺️ 导航地图

### 一、抖音自媒体矩阵（一账号一入口）

| 入口 | 账号 / 定位 | 实际路径 | 开工必读 |
|---|---|---|---|
| `01_抖音号_叁号暗房/` | **叁号暗房 Logos**（哲学 / 文学 / 心理人文号） | 主仓 `/Users/eru/work/philosophy-remotion`；Hook `/Users/eru/work/philosophy-remotion-hook`；Main `/Users/eru/work/philosophy-remotion-main`；学习总览课 `/Users/eru/work/学习总览课_音频与素材归档` | 0 外部真实照片素材、0 配音，纯 Remotion 几何 / 排版动画。做片只由原项目里的 Claude 负责；AGY 不搜图、不下素材、不跑 TTS，只做 `nick-copy-style` 选题、写稿和文稿精修。必读仓库内 `CLAUDE.md`、`PLAYBOOK.md`、`memory/MEMORY.md` |
| `02_抖音号_折舟特效/` | **折舟**（像塑 AR 交互特效 & Logo 动效号） | 工程 `/Users/eru/effect`；素材库 `/Users/eru/Documents/effect` | 必读 `/Users/eru/effect/CLAUDE.md`、`notes/00-通用规则.md`、`notes/08-奥丁.md` 及 `effect-house-*` 技能 |
| `03_抖音号_DaftPunk纪录片` | **回声档案 Echo**（音乐传奇长片号） | `/Users/eru/echo` | 必读 `前置准备_给Claude.md`、`开工指令_P0-P1样片.md`、`script-final.md`、`script-V8.8-final.md` |
| `04_抖音号_雷霆翻倍视频` | **雷霆「翻倍」系列**（脑洞爽片号） | `/Users/eru/雷霆视频制作` | 必读 `/Users/eru/雷霆视频制作/GEMINI.md`（按 `01_成片` / `02_docx` / `03_各期独立工程` 入库） |
| `05_抖音号_希腊神话Zeus` | **希腊神话**（宙斯与奥林匹斯十二主神科普号） | `/Users/eru/Documents/希腊神话` | 必读 `文案.txt` 与 `zeus/` 工程 |
| `06_抖音号_ZeroClinic` | **第零诊室 Zero Clinic**（AIGC 哲学奇幻短片号） | `/Users/eru/AIGC` | 必读 `/Users/eru/AIGC/GEMINI.md` 与 `01_剧本与导演手册/README.md` |

### 二、其他业务线

| 入口 | 范畴 | 实际路径 | 开工必读 |
|---|---|---|---|
| `07_商业客片与定制单/` | 商业客户定制单（笑笑、李伟、糯米、红裤子哥苹果） | 客户素材与成片 `/Users/eru/Desktop/客户文件`；商单 Remotion 仓 `/Users/eru/work/philosophy-remotion-client` | 商单只放 `client/work` 分支，只给画面质感与流程，不混进叁号暗房主仓 |
| `08_英语教研与MTI翻译/` | 英语教学、温州考编、MTI 翻译批改与毕业论文 | 备课 `/Users/eru/Documents/备课`；MTI 讲评 `/Users/eru/Documents/MTI翻译作业与讲评`；教材 `/Users/eru/Documents/初中英语教材`；论文 `/Users/eru/Documents/毕业论文` | 必读 `备课/README_地图.md` 及 `english-lesson-ppt`、`translation-homework-marking`、`thesis-mti` 技能 |
| `09_网络与代理工程_network` | 网络基建、VPS 跳板、住宅 IP 自检、客户排查与手机代理 | `/Users/eru/network`（兼容 `~/Downloads/mac-pack` 软链接） | 必读 `/Users/eru/network/GEMINI.md` |
| `99_日常归档收件箱` | 零散文档、录屏与历史测试脚本 | `/Users/eru/Documents/日常归档_Inbox` | — |
| `小游戏研发_灰盒原型/` · `.agents/ultra_hub/` | 时代进化小游戏、H3 算力工作台等副业 | 见 MEMORY_MASTER 第二节 | 各项目规则见 `workbench/projects.json` |

---

## 🦞 微信 ClawBot（V3）

桥接代码在 `.agents/clawbot/`，完整用法见 MEMORY_MASTER 第三节。最常用的两条：

```bash
# 回复 eru 的微信（必须带本窗口会话 ID；声称完成 / 调研过时要带回执）
node /Users/eru/Desktop/agy工作站/.agents/clawbot/weixin-send.mjs '结论' [/绝对路径/文件] --session=<本窗口会话ID> [--proof=file:/路径|url:地址|cmd:"测试命令"|mock:/项目目录|research:/证据.md]

# 总控把 eru 的消息交给对应窗口（只传编号，原话由脚本逐字投递）
node /Users/eru/Desktop/agy工作站/.agents/clawbot/agy-route.mjs route --msg=<编号> --to=<路由键|会话ID|claude:<路由键>|new:<标题>>
```

bridge 由 `watchdog.sh` 托管，不要在 AGY 终端里另起 `node bridge.mjs`。
