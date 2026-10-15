#!/usr/bin/env bash
# omem V0.1 端到端冒烟（对应实施计划 §6.1 的 S1–S14，另加 S15 supersede）。
# 全程使用隔离的 OMEM_HOME 与合成 fixture，不触碰真实 ~/.omem。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OMEM=(node "$ROOT/bin/omem.js")
export OMEM_HOME="$ROOT/.omem-test/home"
export OMEM_CLAUDE_PROJECTS="$ROOT/tests/fixtures/claude-projects"
rm -rf "$ROOT/.omem-test"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
run() { "${OMEM[@]}" "$@" 2>&1; }

echo "== S1 omem init --no-scan =="
OUT=$(run init --no-scan); CODE=$?
[ $CODE -eq 0 ] && ok "退出码 0" || bad "退出码 $CODE: $OUT"
[ -f "$OMEM_HOME/config.toml" ] && ok "config.toml 生成" || bad "config.toml 缺失"
[ -d "$OMEM_HOME/knowledge" ] && ok "knowledge/ 生成" || bad "knowledge/ 缺失"
[ -d "$OMEM_HOME/.git" ] && ok "git 数据仓初始化" || bad "git 数据仓缺失"
[ -f "$OMEM_HOME/MEMORY-INDEX.md" ] && ok "MEMORY-INDEX.md 生成" || bad "MEMORY-INDEX.md 缺失"

echo "== S2 omem add + search（≥3 字符 trigram） =="
OUT=$(run add "本项目使用 Postgres 而非 MySQL 作为主数据库"); CODE=$?
[ $CODE -eq 0 ] && ok "add 退出码 0" || bad "add 退出码 $CODE: $OUT"
OUT=$(run search "Postgres 而非"); CODE=$?
[ $CODE -eq 0 ] && ok "search 退出码 0" || bad "search 退出码 $CODE"
echo "$OUT" | grep -q "Postgres" && ok "多词 trigram 命中" || bad "多词 trigram 未命中: $OUT"
echo "$OUT" | grep -q "确认" && ok "输出含时效标注" || bad "输出缺时效标注"

echo "== S3 短查询 LIKE 兜底（trigram 对 <3 字符无效） =="
OUT=$(run search "库")
echo "$OUT" | grep -q "Postgres" && ok "单字查询 LIKE 兜底命中" || bad "单字查询未命中: $OUT"

echo "== S4 外部编辑 → catch-up（规格 §2.3 下次访问检出） =="
F=$(find "$OMEM_HOME/knowledge" -name '*.md' | head -1)
echo "" >> "$F"; echo "外部编辑标记 handedit-marker-123 由 Obsidian 追加" >> "$F"
OUT=$(run search "handedit-marker-123")
echo "$OUT" | grep -q "handedit-marker-123" && ok "外部编辑被 catch-up 吸收" || bad "外部编辑未吸收: $OUT"

echo "== S5 删索引 → rebuild 全量恢复 =="
rm -f "$OMEM_HOME/index/omem.db"
OUT=$(run rebuild); CODE=$?
[ $CODE -eq 0 ] && ok "rebuild 退出码 0" || bad "rebuild 退出码 $CODE: $OUT"
echo "$OUT" | grep -q "索引已全量重建" && ok "rebuild 报告输出" || bad "rebuild 报告缺失"
OUT=$(run search "Postgres 而非")
echo "$OUT" | grep -q "Postgres" && ok "rebuild 后检索恢复" || bad "rebuild 后检索未恢复"

echo "== S6 omem run（合成 fixture，档 0 规则抽取 + 脱敏） =="
OUT=$(run run); CODE=$?
[ $CODE -eq 0 ] && ok "run 退出码 0" || bad "run 退出码 $CODE: $OUT"
echo "$OUT" | grep -qE "候选 [0-9]{1,2}" && ok "抽取到候选" || bad "无候选: $OUT"
echo "$OUT" | grep -qE "写入 (1?[0-9]|[2-9][0-9])" && ok "候选落盘" || bad "未落盘: $OUT"
grep -rl "source: rules" "$OMEM_HOME/knowledge" >/dev/null 2>&1 && ok "规则候选落盘" || bad "无规则候选落盘"
if grep -rq "sk-ant-abc123" "$OMEM_HOME/knowledge" 2>/dev/null; then bad "密钥未脱敏"; else ok "密钥已脱敏"; fi
grep -rq "sk-ant-\*\*\*REDACTED\*\*\*" "$OMEM_HOME/knowledge" 2>/dev/null && ok "脱敏标记写入" || bad "脱敏标记缺失"
if grep -rq "sidechain-marker-xyz" "$OMEM_HOME/knowledge" 2>/dev/null; then bad "sidechain 未过滤"; else ok "sidechain 子 agent 条目已过滤"; fi
if grep -rq "会话摘要" "$OMEM_HOME/knowledge" 2>/dev/null; then bad "summary 未过滤"; else ok "summary 条目已过滤"; fi
grep -rl "low-weight" "$OMEM_HOME/knowledge" >/dev/null 2>&1 && ok "指令式语气打低权标签" || bad "指令式语气未标记"

echo "== S7 omem review --confirm =="
RID=$(grep -rl "source: rules" "$OMEM_HOME/knowledge" | head -1 | xargs basename | sed 's/\.md$//')
OUT=$(run review --confirm "$RID"); CODE=$?
[ $CODE -eq 0 ] && ok "confirm 退出码 0" || bad "confirm 退出码 $CODE: $OUT"
echo "$OUT" | grep -q "已确认" && ok "confirm 生效" || bad "confirm 未生效"
F=$(find "$OMEM_HOME/knowledge" -name "$RID.md")
grep -q "verified: true" "$F" && ok "verified 晋升落盘" || bad "verified 未晋升"

echo "== S8 omem gc（只标记 stale） =="
F=$(grep -rl "source: rules" "$OMEM_HOME/knowledge" | head -1)
sed -i 's/^last_confirmed:.*/last_confirmed: 2026-01-01T00:00:00.000Z/' "$F"
OUT=$(run gc); CODE=$?
[ $CODE -eq 0 ] && ok "gc 退出码 0" || bad "gc 退出码 $CODE: $OUT"
echo "$OUT" | grep -qE "标记 stale [1-9]" && ok "gc 标记 stale" || bad "gc 未标记: $OUT"
grep -q "status: stale" "$F" && ok "stale 落盘" || bad "stale 未落盘"

echo "== S9 omem context --for =="
OUT=$(run context --for claude-code); CODE=$?
[ $CODE -eq 0 ] && ok "claude-code 导出退出码 0" || bad "退出码 $CODE: $OUT"
echo "$OUT" | grep -q "MEMORY-INDEX" && ok "claude-code 导出 INDEX" || bad "claude-code 导出异常"
OUT=$(run context --for cursor)
echo "$OUT" | grep -q "alwaysApply: true" && ok "cursor .mdc 导出" || bad "cursor 导出异常"
OUT=$(run context --for codex)
echo "$OUT" | grep -q "OMEM:START" && ok "codex AGENTS.md 段导出" || bad "codex 导出异常"

echo "== S10 omem sync（无远端 → 本地提交） =="
OUT=$(run sync status); CODE=$?
[ $CODE -eq 0 ] && ok "sync status 退出码 0" || bad "退出码 $CODE: $OUT"
echo "$OUT" | grep -q "后端: git" && ok "git 后端状态" || bad "后端状态异常: $OUT"
OUT=$(run sync); CODE=$?
[ $CODE -eq 0 ] && ok "sync 退出码 0" || bad "sync 退出码 $CODE: $OUT"
echo "$OUT" | grep -q "未配置远端" && ok "无远端时本地提交并提示" || bad "无远端提示缺失: $OUT"
OUT=$(run sync status)
echo "$OUT" | grep -q "待推送: 0" && ok "提交后无待推送" || bad "仍有待推送: $OUT"

echo "== S11 work profile 拒绝 sync（退出码 2） =="
run profile use work >/dev/null
OUT=$(run sync); CODE=$?
[ $CODE -eq 2 ] && ok "work profile 拒绝 sync" || bad "退出码 $CODE（期望 2）"
echo "$OUT" | grep -q "work profile" && ok "给出可操作提示" || bad "提示缺失"
run profile use home >/dev/null

echo "== S12 omem redact（唯一硬删除） =="
F2=$(grep -rl "Postgres" "$OMEM_HOME/knowledge" | head -1)
ID2=$(basename "$F2" .md)
OUT=$(run redact --id "$ID2"); CODE=$?
[ $CODE -eq 0 ] && ok "redact 退出码 0" || bad "redact 退出码 $CODE: $OUT"
[ ! -f "$F2" ] && ok "文件已删除" || bad "文件未删除"
OUT=$(run search "Postgres 而非")
if echo "$OUT" | grep -q "主数据库"; then bad "索引条目未移除"; else ok "索引条目已移除"; fi

echo "== S13 omem snapshot（滚动保留） =="
OUT=$(run snapshot); CODE=$?
[ $CODE -eq 0 ] && ok "snapshot 退出码 0" || bad "退出码 $CODE: $OUT"
ls "$OMEM_HOME/snapshots" 2>/dev/null | grep -q "$(date +%Y-%m-%d)" && ok "当日快照生成" || bad "快照缺失"

echo "== S14 MCP 探针（握手 + 工具调用） =="
OUT=$(node "$ROOT/tests/mcp-probe.mjs" "$ROOT/bin/omem.js"); CODE=$?
[ $CODE -eq 0 ] && ok "MCP 握手与工具调用全部通过" || { bad "MCP 探针失败"; echo "$OUT" | sed 's/^/    /'; }

echo "== S15 supersede 显式入口 =="
OUT=$(run add "S15旧约定使用本地磁盘保存日志 s15-old-marker")
OLD=$(printf '%s\n' "$OUT" | sed -n 's/^已保存 id: //p' | head -1)
[ -n "$OLD" ] && ok "旧条目 id=$OLD" || bad "未解析旧 id: $OUT"
OUT=$(run add "S15新约定日志改走标准输出 s15-new-marker" --supersedes "$OLD")
echo "$OUT" | grep -q "已取代" && ok "add --supersedes 声明取代" || bad "未声明取代: $OUT"
OUT=$(run search "s15-old-marker")
echo "$OUT" | grep -q "未找到" && ok "默认检索排除 superseded" || bad "默认检索仍返回旧条目: $OUT"
OUT=$(run search "s15-old-marker" --all)
echo "$OUT" | grep -q "s15-old-marker" && ok "--all 带回 superseded" || bad "--all 未带回: $OUT"
OUT=$(run search "s15-new-marker")
echo "$OUT" | grep -q "s15-new-marker" && ok "新条目仍可检索" || bad "新条目未命中: $OUT"
REV=$(run review)
CAND=$(printf '%s\n' "$REV" | sed -n 's/^- `\([^`]*\)`.*/\1/p' | head -1)
if [ -n "$CAND" ]; then
  OUT=$(run review --confirm "$CAND" --supersedes "$OLD")
  echo "$OUT" | grep -q "已确认" && ok "review --confirm --supersedes 确认" || bad "review 未确认: $OUT"
  echo "$OUT" | grep -q "已取代" && ok "review 声明取代" || bad "review 未取代: $OUT"
else
  bad "review 队列为空，无法验证 --supersedes"
fi

echo ""
echo "═══════════════════════════════════════"
echo "结果: $PASS 通过 / $FAIL 失败"
[ $FAIL -eq 0 ] && echo "✅ 冒烟全绿" || echo "❌ 存在失败项"
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
