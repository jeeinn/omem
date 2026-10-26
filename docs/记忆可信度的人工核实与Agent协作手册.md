# 记忆可信度标记：人工验证与终端 Agent 操作手册

> 适用范围：omem V0.1。实测环境：Windows 11 / Node v22.22.2 / 项目根 `X:/omem`。
> 姊妹篇：`docs/手动测试指南.md`（CLI 全量手工测试）、`docs/knowledge验证与Agent自动接入指南.md`（knowledge 里有什么、怎么让 omem 被自动调用、Cursor prompt 模板）。本文只聚焦**「可信度」这一条线**：怎么手工测、怎么借 Cursor / CodeBuddy 这类终端 Agent 批量核实。
> 本文所有命令与输出均在隔离 `OMEM_HOME` 下实测通过，标注「实测」的行为已秋季验证；未标注的为代码推断。

---

## 0. 结论摘要

标记可信度有**三条路径**，能力不同，别混用：

| 路径 | 载体 | 能做什么 | 留痕 | 推荐度 |
| --- | --- | --- | --- | --- |
| **A. 让 Agent 跑 CLI** | Cursor / CodeBuddy 的终端或对话 | 全能力：`review` / `review --confirm` / `--dismiss` / `--stale` / 直接改 md | 有（`confirmations+1`、`last_confirmed` 刷新） | **★ 推荐** |
| **B. MCP 工具** | `memory_feedback`（默认关闭） | 只能「+1 确认」，不能否认（见 §4.4） | 有（等同 `review --confirm`） | 有条件使用 |
| **C. 直接编辑 md** | 任意编辑器 / Agent 的文件编辑 | 改 `verified` 与 `confidence` 任意值 | **无**（不递增<｜hy_place▁holder▁no▁813｜> `confirmations`，不刷新 `last_confirmed`） | 批量改分时用 |

三条铁律：

1. **`review --confirm` 只翻 `verified`，不动 `confidence`。** 一条规则抽出来的 `confidence: 0.4` 条目，确认后依然是 0.4。要提分必须走路径 C 改 md。
2. **只有人才是高可信度的来源。** 让 Agent 自己给它自己刚写入的条目盖章（路径 B），等于取消整套防投毒设计。
3. **`save_memory` 写出来的永远是 `verified: false`**（实测 `confidence: 0.6`）。它必须回到人工/半人工队列才升可信。

---

## 1. 开机前置检查（P0，不做后面全废）

先别急着操作。本机现状是「配置已写、命令不存在」，直接进客户端必然失败。

### 1.1 P0：`omem` 不在 PATH

实测：`~/.workbuddy/mcp.json` 与 `~/.cursor/mcp.json` 都已经写好了 omem 条目：

```json
"omem": { "command": "omem", "args": ["serve"] }
```

但 `which omem` 无输出，`npm ls -g omem` 为空 → **客户端 spawn 会直接失败（ENOENT）**，Cursor / WorkBuddy 里看不到任何 omem 工具。

两个解法，选一个：

| 方案 | 命令 | 适用 | 备注 |
| --- | --- | --- | --- |
| **A1 直接指到本机可执行文件**（推荐，不动全局环境） | 手改 mcp.json，见下方片段 | 从源码目录测试 | 最可控，随时改回 |
| A2 全局安装 | `cd /x/omem && npm link` | 想验证「安装后」体验 | npm prefix 实测为 `C:\Users\wei\.workbuddy\binaries\node\versions\22.22.2-6`，**在 PATH 内**，link 后 `omem` 可用；`npm unlink -g omem` 撤销 |

A1 的精确片段（已实测 `spawn(node, [bin, serve])` 握手成功、stdout 纯协议、日志走 stderr）：

```json
{
  "mcpServers": {
    "omem": {
      "command": "C:\\Users\\wei\\.workbuddy\\binaries\\node\\versions\\22.22.2-6\\node.exe",
      "args": ["X:\\omem\\bin\\omem.js", "serve"]
    }
  }
}
```

> 修改前请备份：`cp ~/.workbuddy/mcp.json ~/.workbuddy/mcp.json.mybackup`。
> 不要用 `omem install --target workbuddy` 来修：它的写入纪律是「只 merge `mcpServers.omem`」，会把你的 command 改回默认的 `omem`（可用 `omem install --command "X:\\omem\\bin\\omem.js"` 指定，但它同样不写 env，见 1.3）。
> 改完必须**重启客户端**。

### 1.2 P0：`~/.omem` 不存在

实测 `~/.omem` 尚未创建 → MCP server 用默认 home，即使起来也会报「未初始化」。

```bash
omem init                 # 不带 OMEM_HOME，落到 ~/.omem
# 或直接：node X:/omem/bin/omem.js init
```

### 1.3 P1：`install` 不写 `env`，`OMEM_HOME` 无法透传

`src/install/writer.ts` 的 `omemEntry()` 只产出 `{command, args}`，**没有 env 字段**。后果：

- 终端里 `OMEM_HOME=/tmp/x` 隔离测试 → 客户端里的 MCP server 仍然读 `~/.omem`，两边数据不一致。
- 想开 `memory_feedback` 必须手工加 `env`（见 §4.2）。

需要时用 mcp.json 的 `env` 解决（这是 MCP 标准能力，stdio server 继承环境变量）：

```json
"omem": {
  "command": "...\\node.exe",
  "args": ["X:\\omem\\bin\\omem.js", "serve"],
  "env": { "OMEM_HOME": "C:\\Users\\wei\\.omem", "OMEM_MCP_TOOLS": "feedback" }
}
```

---

## 2. 可信度模型速查（实测值）

一条记忆的可信度由 frontmatter 里的四个字段共同表达：

| 字段 | 含义 | 谁改 |
| --- | --- | --- |
| `verified` | 是否经人工确认。**决定 `MEMORY-INDEX.md` 排序**（verified 优先排最前） | `review --confirm` / `memory_feedback(helpful=true)` / 手改 md |
| `confidence` | 0~1 抽取置信度 | **只能手改 md**，CLI 无 `--confidence` 参数 |
| `confirmations` | 确认次数，**无节流，可无限累加** | `review --confirm` / feedback（每次 +1） |
| `source` | 来源：`rules` / `agent` / `manual` | 写入时确定 |

三条写入路径的默认值（实测）：

| 写入路径 | `confidence` | `verified` | `confirmations` | `source` |
| --- | --- | --- | --- | --- |
| 规则抽取 `omem sync` | 0.35 ~ 0.45（指令式语气减半并打 `low-weight`） | `false` | 0 | `rules` |
| MCP `save_memory` | **0.6** | **`false`** | 0 | `agent` |
| CLI `omem add` | **0.9** | **`true`** | 0 | `manual` |

也因此，**用 `omem add` 手工补记是最快拿到「已确认」状态的路径**——人写的就是可信的，这条默认值设计是对的。

---

## 3. 路径 A（推荐）：让终端 Agent 帮你核实

### 3.1 为什么推荐

`omem review` 的默认输出只有 id + 50 字标题 + confidence，**没有正文**。实测一次 fixture 抽取会产生 **771 条**未验证候选——人肉逐条判断不可行，但把它整段喂给 Agent 恰好合适：它能读 md 全文、能判断、还能替你敲命令。

### 3.2 接线

只需让 Agent 能执行 `omem`。两条路：

- **有 MCP**（推荐）：按 §1.1 修好配置并重启。此时 Agent 除了跑命令，还能用 `search_memory` 直接拿到 `id+\`id\`` 格式的结果，方便接着确认。
- **无 MCP**：Agent 只要在 shell 里能调到 `omem`（`npm link` 或绝对路径）即可。`omem install` 选中 claude-code 时会往 `~/.claude/CLAUDE.md` 幂等写入 marker-fenced 指令段（让非 MCP harness 也知道有这个 CLI）；未选 claude-code 则不动该文件。

### 3.3 可直接粘贴的 prompt 模板

**模板 1：初筛一轮（保守版，推荐首跑）**

```text
我的记忆库在 C:/Users/wei/.omem（如需请用 OMEM_HOME 指定，命令用 omem 或 node X:/omem/bin/omem.js）。

请帮我核实未确认的记忆条目，规则如下：
1. 先执行 omem review，只看前 30 条。
2. 对每一条，读取 knowledge/ 下对应的 md 文件全文（文件名就是 id）。omem review 只给标题，必须读全文才能判断。
3. 判定为「真」的条件：这是一条可跨会话复用的稳定偏好 / 事实 / 决策 / 经验，且不是某次任务的一次性上下文、不是临时报错日志、不是纯代码片段。
4. 判定为真：执行 omem review --confirm <id>
5. 判定为假：执行 omem review --dismiss <id>（归档，可逆，不要删）
6. 拿不准：跳过，不要确认。
7. 如果新条目与某条旧条目冲突且应该覆盖它，用 omem review --confirm <id> --supersedes <旧id>。
完成后汇报：确认 X 条 / 归档 Y 条 / 跳过 Z 条，每条给一句理由。不要修改 memory 的正文本身。
```

**模板 2：确认指定条目**

```text
请执行 omem review --confirm <id>，然后 omem search "<关键词>" 确认该条目的时效标注已经从 unconfirmed 变成 confirmed。
```

**模板 3：批量（已知 id 列表时）**

```bash
# Git Bash
for id in 2026-10-16-0557e1 2026-10-16-a86344; do omem review --confirm "$id"; done
```

> 一条 `--confirm` 只接受**一个 id**，逗号列表不支持（`--supersedes` 才支持逗号列表）。

### 3.4 红线

- **不要让 Agent 确认它自己在本次会话里写入的条目。** 这类条目必须经过你本人过目。
- 大批 `--dismiss` 前先 `omem snapshot`，归档虽可逆（文件还在 `archive/`），但混在一起不好捞回来。
- 涉及公司项目的条目，先确认当前 profile：`omem profile`（`work` 档默认禁同步与导出，退出码 2 是设计不是 bug）。

---

## 4. 路径 B：MCP `memory_feedback`

### 4.1 默认工具面

默认只有 `search_memory` / `save_memory`（实测 `tools/list` 确认）。`memory_feedback` 必须显式开启。

### 4.2 开启方法（`install` 做不到，只能手改）

`OMEM_MCP_TOOLS=feedback` 必须进入 MCP server 的进程环境。按 §1.3 的片段往 mcp.json 加 `"env"`，然后重启客户端。实测工具清单变为：

```
tools: search_memory, save_memory, memory_feedback
```

### 4.3 用途与风险

调用 `memory_feedback({id, helpful: true})` 实测返回：

```
Recorded: confirmation refresh for <id> (confirmations=1, verified=true).
```

等价于 `review --confirm`。**这是让 Agent 自助盖章的入口，风险等级 P1**：一次调用就把一条 `confidence: 0.4` 的规则候选抬到 `verified=true`，而 `MEMORY-INDEX.md` 的排序是「verified 优先」→ 它会一路顶到 L0 热层最前面。

建议：**给 Agent 开 `search_memory` / `save_memory` 就够了，`feedback` 留给你自己在会话里手动点。** 真要给，prompt 里必须显式禁止「对自己刚写入的条目发 helpful=true」。

### 4.4 `helpful: false` 目前是空操作（P1 缺口）

工具返回语写着 will be used for later down-weighting，但 `src/mcp/tools.ts` 的 `toolFeedback` 在 `helpful=false` 分支**只有一句 `appendLog`**，既不降 `confidence` 也不置 `stale`。V0.1 没有降权实现。

要真正降权，现在只能走：

```bash
omem review --stale <id>     # status=stale，检索降权 ×0.5 仍可见
omem review --dismiss <id>   # 归档，默认检索不可见，可逆
```

---

## 5. 路径 C：直接编辑 md（批量调整最快）

omem 的 catch-up 会吸收外部编辑：**改完 md 无需重连，下次访问即生效**（实测 `(size, mtime)` 快路径 2000ms 去抖 + 内容哈希慢路径）。

实测有效的改法：

```bash
# 单条：翻开的态度改为已确认，并把置信度提到 0.9
sed -i 's/^verified: false$/verified: true/; s/^confidence: 0.4$/confidence: 0.9/' \
  ~/.omem/knowledge/coding/2026/<id>.md
```

```bash
# 批量：把一个域名下所有未验证 rules 候选一次性标为已确认（先 grep 看清单，确认无误再 -i）
grep -rl "^verified: false" ~/.omem/knowledge/coding --include="*.md" | head -20
# 确认清单后：
grep -rl "^verified: false" ~/.omem/knowledge/coding --include="*.md" \
  | xargs sed -i 's/^verified: false$/verified: true/'
```

> **代价（实测）**：这条路**不递增 `confirmations`、不刷新 `last_confirmed`**。也就是说 memory 变成了 verified 但没有"何时被谁确认过"的痕迹，将来做信任审计时这段是空白。批量冲数据可以，常规核实请走路径 A。
> 别改 `id`、别动 `---` 分隔符，frontmatter 会被 `FM_ORDER` 重排，但字段值不会丢。
> 用 Obsidian 打开 `~/.omem/knowledge` 直接改也可以，同样生效。

---

## 6. 端到端验收清单（可信度专项，~10 分钟）

在 Git Bash 里整段跑。所有断言均为实测结果。

```bash
export OMEM_HOME=/tmp/omem-cred-test && rm -rf $OMEM_HOME
cd /x/omem

# T1 建仓 + 造出未验证候选（fixture 合成数据，不碰真实会话）
node bin/omem.js init --no-scan
OMEM_CLAUDE_PROJECTS=/x/omem/tests/fixtures/claude-projects node bin/omem.js run
# 预期：candidates 1809, written 771；它们全是 verified:false

# T2 三种写入的默认可信度
node bin/omem.js review | head -3
# 预期：Pending candidates (unverified, 771 total)，标注 "recorded just now, unconfirmed"
ID=$(node bin/omem.js review | sed -n '3p' | grep -o '`[0-9-]*-[0-9a-f]*`' | tr -d '`')
echo "candidate id = $ID"

# T3 路径 A：CLI 确认
node bin/omem.js review --confirm $ID
# 预期：Confirmed: <id> (verified=true, confirmations=1)
#       md 里 confidence 保持原值不变（这是设计，不是 bug）
#       review 队列 771 → 770

# T4 时效性标注已翻转
node bin/omem.js search "<该条目关键词>" --detail | head -6
# 预期：第 3 行出现 "confidence=0.4 verified=true source=rules status=active"
#       列表行从 "unconfirmed" 变成 "confirmed just now"

# T5 路径 C：直接改 md（挑另一条）
F=$(find $OMEM_HOME/knowledge -name "*.md" | head -1)
sed -i 's/^verified: false$/verified: true/' "$F"
node bin/omem.js review | head -2
# 预期：队列再减 1；无需 rebuild、无需重连

# T6 路径 B：MCP feedback（需要 OMEM_MCP_TOOLS=feedback）
OMEM_MCP_TOOLS=feedback node tests/mcp-probe.mjs bin/omem.js
# 预期：tools/list 出现 memory_feedback；
#       memory_feedback(helpful=true) → verified=true, confirmations+1
#       注意：自带的 mcp-probe 不开 feedback 时，tools/list 断言的是「memory_feedback 不出现」

# T7 MCP 视角能看到可信度
# search_memory detail=true 返回行含 confidence/verified/source/status

# T8 降权与回退
node bin/omem.js review --stale $ID   # status=stale，检索降权 ×0.5 仍可见
node bin/omem.js review --dismiss $ID # 归档，默认检索不可见
node bin/omem.js search "<关键词>" --all   # 预期：--all 才能找回带 "superseded/archived" 的条目

# T9 确认结果落到 git（凡 schema 改动最终都进版本历史）
node bin/omem.js backup status   # 预期：未提交改动 N ≥ 1

rm -rf $OMEM_HOME   # 收尾
```

---

## 7. 已知缺口与坑

| 级别 | 问题 | 影响 | 规避 |
| --- | --- | --- | --- |
| **P1** | `install` 写入的 command 是 `omem`，本机无全局安装 | 客户端 MCP 直接 ENOENT | §1.1 A1/A2 |
| **P1** | `install` 不写 `env` | `OMEM_HOME` / `OMEM_MCP_TOOLS` 无法透传 | 手工改 mcp.json，见 §1.3 |
| **P1** | `confirmations` 无节流，`review --confirm` 与 feedback 可无限累加 | MEMORY-INDEX 排序（verified → confidence → last_confirmed）可被刷 | 不要让 Agent 自助发 helpful=true；同一条目重复确认前先看 `confirmations` |
| **P1** | `memory_feedback(helpful=false)` 只写日志，不降权 | 「负面反馈」是空承诺 | 需要降权用 `--stale` / `--dismiss` |
| **P1** | CLI 没有设置 `confidence` 的参数，也没有批量筛选/分页 | 771 条队列无法有效人肉处理 | 借 Agent（路径 A）或 `sed` 批量（路径 C） |
| **P2** | `review` 输出不含正文预览 | Agent 必须额外读 md 全文 | prompt 模板里已强制要求第 2 步读全文 |
| **P2** | `omem eval sample` 依赖 golden 目录的 `annotations.json`，无法导出当前 store 的未验证候选 | 没有官方的「待确认清单导出」 | 用 `omem review` 输出 + `xargs` 落到文件 |
| **P2** | 批量硬删的筛选维度只有 `source`（`--source rules\|agent\|llm\|manual`），不能按 domain / 日期 / confidence 批量删 | 想清掉「某个域名下的低质条目」做不到 | 先 grep 出 id 列表再逐条 `omem redact --id`，或走路径 C 改 md |
| **P2** | `omem redact --source` 不加 `--yes` 时**只预览不删**（防误触设计） | 以为跑了就会删，实际什么都没发生 | 预览末尾会打印 `Re-run to actually delete: … --yes`，照抄即可 |
