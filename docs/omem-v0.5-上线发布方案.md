# omem v0.5.0 上线发布方案（Phase 3 上线发布产出）

> 日期：2026-11-22 ｜ 基线：`0f37814`（Phase 2 修复已提交）｜ Phase 2 结论：**GO**
> 产出方式：全栈智造专家团 Phase 3 单模块模式，上线发布师依 `release-deployment.md` 产出，团长核实整合。
> 上游依据：[`omem-v0.5-Roadmap.md`](./omem-v0.5-Roadmap.md)、[`omem-v0.5-测试保障方案.md`](./omem-v0.5-测试保障方案.md)、`AGENTS.md`、`CHANGELOG.md`。

## 〇、结论与团长核实

**本轮只出方案，零发版动作。** 所有 commit / push / tag / npm publish / dist-tag / Release 均须逐项单独取得用户显式授权；「按方案推进」不等于授权发版。

团长核实（2026-11-22 实测，非转述）：

| 项 | 实测 |
|---|---|
| HEAD 链 | `465faf8`(0.4.0) → `3eac868`(v0.5.0 实施) → `0f37814`(Phase 2 修复) |
| 远端 main / tag | 均停在 `465faf8`；本地领先 **2 笔**未 push |
| `package.json` version | **0.4.0**（v0.5.0 代码已落地，版本未 bump） |
| CHANGELOG | v0.5.0 条目仍在 `[Unreleased]` |
| `prepublishOnly` | `npm run build && npm test && node scripts/release-check.mjs`（精确 tag 校验，见 `release-check.mjs:42` 的 `git describe --tags --exact-match`） |
| 工作区 | 仅 `M docs/omem-v0.5-Roadmap.md` —— 团长在 Phase 3 启动后更新档案所致，归属清楚，发版前须先提交或明确处置 |

**三个硬阻塞**（发版前必须解决）：① version 仍 0.4.0 + CHANGELOG 在 `[Unreleased]`；② 本地领先远端 2 笔、工作区有一处未提交档案改动；③ 0.4.0 仅打 tag、npm 未发包，「是否发包 / 是否升 latest」必须单独显式确认。

**团长对二选一的裁决**：采纳发布师推荐的 **B 案（beta 先行）**，但**第一决策点不是 A/B，而是「是否发包」**。用户此前明确「0.4.0 仅打 tag + 推远端、npm 暂不发包」，本轮同样可能延续该做法。因此顺序是：先确认是否发包 → 若发包再选形态 → 若选 B 再决定是否升 latest。未经确认不得默认任何一步。

**形态说明**：omem 是 npm CLI + stdio MCP 制品分发，无后端、静态站、演示地址或应用商店审核。部署 ≈ npm registry；四环境 ≈ dist-tag `beta` → `latest`；制品唯一性 ≈ 发布包必须来自打了精确 tag 的同一 HEAD 构建。App Store / 华为 / 小程序 / ICP 备案等均不适用。

---

## 一、发布前置 Checklist（十项）

1. ☐ bump version（A `0.5.0` / B `0.5.0-beta.N`）。**tag 名须精确等于 `v` + version**：`normalizeTag` 剥 `v` 比对，beta 亦须 `v0.5.0-beta.N` ↔ `0.5.0-beta.N`，否则 `prepublishOnly` / `release-check` 拒发。
2. ☐ 完整 `npm run release:check`（**非 `--no-tag`**）：version == HEAD 精确 tag、dist 与 src 1:1 无孤儿、无 tests/docs/src/`.omem-test` 残留、`files` 白名单含 dist/bin 且 main/bin 入口存在、包内数 = dist+5、引文 fixture 门禁。tarball md5 含时间戳，仅打印、**不作一致性判据**。
3. ☐ `npm pack --dry-run` 只列清单；`npm publish --dry-run` **不鉴权、会假成功**，两者都不能替代发布后验证。
4. ☐ `npm whoami --registry=https://registry.npmjs.org` 验登录态。
5. ☐ CHANGELOG `[Unreleased]` → `[0.5.0] - <日期>`；底部加 `[0.5.0]: …/compare/v0.4.0...v0.5.0`，`[Unreleased]` 改指 `…/compare/v0.5.0...HEAD`。
6. ☐ README + `docs/README.md` 索引同步（`AGENTS.md`）；0.x minor 可能含不兼容变更，须写明「升级前读 CHANGELOG 对应章节」。
7. ☐ **先 push 再 tag**：清工作区 → push main → 确认远端 = 最终 commit → `git tag v…` → push tag → 完整 `release:check`。tag 是对已落地 commit 的不可变指针，反序会让他人 clone 的 main 找不到 tag、精确校验错位；`git describe --tags --exact-match` 要求 HEAD 与 tag 同点，**tag 后不得再 commit**。
8. ☐ 密钥：token / OTP 不入库、`.npmrc` 不提交、交互注入；`publishConfig.registry` 与开发隔离；`git status` 泄露检查。
9. ☐ 发布权核验：registry HTTPS 证书、`@jeeinn` scope 发布权、`access=public`、2FA/OTP 可用。
10. ☐ 门禁 GO 未回退、回滚四情形已走查、发布窗口避开高峰/节假日、应急联系人到位。

## 二、分阶段流程（可独立暂停；下列命令本轮**只写不执行**）

| 阶段 | 动作 / 命令 | 前置 | 用户确认 | 失败处理 |
|---|---|---|---|---|
| **0 本地版本文档**（不联网） | bump；CHANGELOG / README / docs；`build && test && smoke` + 三套 eval + `release:check --no-tag` | Phase 2 GO | commit 授权 | 停在本阶段重跑 |
| **1 推远端 + 打 tag** | 清工作区 → `push origin main` → `git tag v…` → `push origin v…` → 完整 `release:check` | 阶段 0 全绿 | **每步单独授权** | 回滚①②③；**禁 `push --force`** |
| **2 npm 发包** | `whoami` → `npm publish --tag beta --otp=<码>`(B) / `--otp=<码>`(A) → 等约 3min → `dist-tag ls` | 精确 tag 在 HEAD | **「是否发包」单独确认** | 401 + `WWW-Authenticate: OTP` 补码；400 重登；重复 publish 403 |
| **3 升 latest / Release / 归档** | `npm dist-tag add @jeeinn/omem@0.5.0 latest --registry=https://registry.npmjs.org --otp=<码>`；可选 GitHub Release；发布单归档 | 观察期达标 | **「是否升 latest」单独确认** | dist-tag 回退；回滚④ |

## 三、回滚预案（FF05）

触发条件：48h 内 P0／安装或握手失败率 >1%／已发布包 smoke 失败／非零退出 >0／投诉集中。责任人：发布执行人 + 用户确认人。上线前至少走查一次。

| 情形 | 步骤 | 影响 |
|---|---|---|
| ① 仅本地 commit 未 push | 先 `git branch backup/...` **留回退点**，再 `git revert`（或 `reset --soft`）；**禁未经确认的 `reset --hard`** | ~2min，无远端/数据影响 |
| ② 已 push 未打 tag | 记 sha → `git revert` 反向 commit → push；不改写历史、**禁 `push --force`** | ~5min |
| ③ 已打 tag 未发包 | `git tag -d v0.5.0` + `git push origin :refs/tags/v0.5.0`；**远端影响**：已 fetch 者本地 tag 残留、基于该 tag 的分支需协调，须公告 | ~5min，registry 无影响 |
| ④ 已 npm publish | 优先 **dist-tag 回退**（按发布前 `dist-tag ls` 快照把 latest 指回上一稳定版，必带 `--registry` + `--otp`），不动已发版本；72h 内可 `npm unpublish @jeeinn/omem@0.5.0 --otp=<码>`（超时联系支持，**同版号不可再发、须换版号**）；tag 保留可追溯 + 公告 | 需公告 |

> **0.4.0 未发包，latest 当前指向必须实测快照、不得臆测**（发布前跑 `npm dist-tag ls @jeeinn/omem --registry=https://registry.npmjs.org` 留档）。

数据兼容性：`OMEM_HOME` 的 Markdown 不随包删除；0.x 升级读 CHANGELOG；新版写过的 `evidence_current` 等字段在回滚到旧版时须验证可读性；禁破坏性变更（先加后删）；回滚后跑核心链路冒烟 + 对外说明模板。

## 四、审核与合规风险

- npm 2FA/OTP 覆盖 **publish 与 dist-tag**：缺码 = 401 + `WWW-Authenticate: OTP`；token 失效表现为 400；dist-tag 操作必须显式 `--registry=https://registry.npmjs.org` 且带 OTP。
- **prerelease 不会自动成为 latest**；packument 比版本端点晚约 3 分钟，用 `npm view @jeeinn/omem@0.5.0 version` + `dist-tag ls` **双通道核对**，勿在 3 分钟内误判重复 publish。
- `@jeeinn` scope 权限与 `access=public` 前置核验；0.x 语义化版本如实记录，不写「测试版/Beta」字样。
- work profile 与 `logs/omem.log` 不入库、不外传、不进 MCP stdout；包内不得含真实 `~/.omem`。
- **发布后 CHANGELOG / README 作为 Markdown 事实源不可撤回**（镜像/缓存/抓取），发布前逐字核对版本号、日期、compare 链接、breaking 说明。

## 五、灰度与验证（在**已发布包**上复跑，非本地 dist）

B 案灰度路径：beta 自愿者 `npm i @jeeinn/omem@beta` → 48h 观察 → 手动升 latest，每档达标才放量。

分级验证：① 隔离目录安装、`omem --version` = 版本 + short commit；② 全局 `omem` bin / `--help`；③ MCP `initialize`（`serverInfo.version`、instructions ≤2048、`tools/list` 仅 2 工具、stdout 零日志）；④ `mcp-probe` payload ≤12,300；⑤ 隔离 `OMEM_HOME` 跑 smoke（S1 只读打标 / S3 session_id 真出口 / watch-once / work profile exit 2 零写盘）。

**升 latest 前必核**：5 项全绿、P0=0 / 未捕获异常=0 / 非零退出=0、packument 与 dist-tag 一致、无投诉、回滚已演练、用户显式授权。A 案「直接全量」仅在首发冷启动无存量用户时成立——本项目 latest 已有历史用户，不满足。

## 六、里程碑与回访

| 节点 | 检验项 |
|---|---|
| **T-7（上线前 1 周）** | 5 条核心链路回归清单；843 tests / smoke 93-0 / 三套评测复跑；预算三上限；隔离 home；CHANGELOG / README 逐字核对 |
| **T+48h** | 远端 tag 与 HEAD 一致、main = 最终 commit、dist-tag / packument 一致、未捕获异常 = 0、握手失败率、issue / 客诉；P0 立即回滚并同步团长与用户 |
| **T+7d** | 缺陷趋势、安装量 / 版本分布、客诉 Top3 入需求池、告警调优；发布单 24h 内归档、保留 ≥1 年；观察结论交运维守护师衔接监控告警与应急 |

## 七、发布形态二选一（已裁决：推荐 B，但先决于「是否发包」）

| | A 直接 `0.5.0` → latest | B `0.5.0-beta.N` → 观察 → latest（**推荐**） |
|---|---|---|
| 成本 | 低：一次 publish | 中：两次命令 + 48h 观察 |
| 收益 | 立即全量，无二次 dist-tag | 自愿灰度可控；问题在升 latest 前用 dist-tag 回退即可，无需 unpublish |
| 风险 | 直接触达全部 `npm i`；0.4.0 未发包 → 两版变更一次性推给 0.3.x 升级者；仅本地验证、无真实语料/多端真机；出事只剩 72h unpublish 或换版号 | beta 期 latest 仍指旧版，新用户默认装不到新功能，需主动沟通 |
| 用户影响 | 新装/升级立即拿到未充分观察版 | 尝鲜者 `@beta`，稳用户不受影响 |

**推荐 B 的理由**：0.x minor 可能含不兼容变更；仅本地验证（Phase 2 A 案明确真实语料准确率未覆盖）；用户此前对公开发布审慎（0.4.0 暂不发包）；beta 是 npm 原生灰度、回滚成本最低。

**但第一决策点仍是「是否发包」**：用户可能延续 0.4.0 做法，仅打 tag + 推远端。若选择不发包，阶段 2/3 整体跳过，只执行阶段 0（版本与文档）+ 阶段 1（push + tag）。

## 八、go / no-go 门槛

- ☐ 门禁 GO 未回退（843 tests / smoke 93-0 / 三套评测 / 预算三上限）
- ☐ 工作区干净、HEAD 为最终 commit
- ☐ version / tag / CHANGELOG / README / docs 一致
- ☐ 远端 main 已 push、精确 tag 已推且同点
- ☐ 完整 `release:check`（非 `--no-tag`）通过
- ☐ 登录态 / scope / OTP / access 核验
- ☐ **「是否发包」已确认**；形态 A/B 已定；升 latest 单独确认
- ☐ 每个 commit / push / tag / publish / dist-tag / Release 均**逐项显式授权**
- ☐ 回滚四情形已走查、sha 与 dist-tag 快照已留、应急到位
- ☐ 密钥泄露检查通过、发布窗口避开节假日

任一不满足 → **NO-GO**，注明阻塞项上报团长，禁止带病上线。

**当前状态：NO-GO**（三个硬阻塞未解决，且「是否发包」未获授权）。

## 九、阶段复盘卡（Phase 3 → Phase 4）

- 完成度：100%（前置清单、三阶段流程、四种回滚、合规、灰度、里程碑、AB 二选一、go/no-go 齐备；三个硬阻塞已定位）
- 阻塞：version / 远端 / 是否发包三项均待用户决策与授权；工作区一处档案改动待处置
- 下阶段：确认发版形态与授权 → 执行阶段 0/1（可仅打 tag + 推远端）→ Phase 4 运维守护师衔接监控告警与应急

## 十、下一步

建议：①先确认「是否发包」（沿用 0.4.0 做法则仅打 tag + 推远端）；②若发包，确认 A/B 形态；③按阶段 0 → 1 逐步逐项授权执行；④随后进 Phase 4 运维保障。v0.4.0 上线后 48 小时回访节点尚未到期（11:58 推送），到时回来核对远端 tag 与用户反馈。
