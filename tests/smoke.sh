#!/usr/bin/env bash
# omem v0.2 端到端冒烟：14 条命令面 + topic 即身份 + 置信度五档。
# 全程使用隔离的 OMEM_HOME 与合成 fixture，不触碰真实 ~/.omem。
#
# 2026-11-01 重写：v0.2 的命令面与语义都变了（rebuild→verify、gc→review --gc、
# snapshot→backup、context 已删、add 必带 --topic、supersede 已删）。
# 旧脚本还在测「删掉的命令」，它绿了也说明不了任何事。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OMEM=(node "$ROOT/bin/omem.js")
# 每次运行用独立的 home：Windows 上残留文件会让下一轮的 knowledge/ 撞上 content-hash
# 去重，报成「save_memory first save ✗」这种与改动毫不相关的假失败。
RUN_ID="$(date +%s)-$$"
rm -rf "$ROOT/.omem-test" 2>/dev/null
export OMEM_HOME="$ROOT/.omem-test/home-$RUN_ID"
mkdir -p "$OMEM_HOME"
EMPTY="$ROOT/.omem-test/empty-$RUN_ID"
mkdir -p "$EMPTY"

# ── 采集器隔离 ────────────────────────────────────────────────────────────
# 隔离清单从采集器注册表派生（src/collect/registry.ts），不手写：手写清单每加一个
# 采集器就会漏一处，而漏一处的后果不是测试失败，是端到端冒烟把开发者本机的真实会话
# 扫进测试产物（2026-10-26 实测：catpaw 漏配，冒烟读到了真实 ~/.catpaw）。
export OMEM_CLAUDE_PROJECTS="$ROOT/tests/fixtures/claude-projects"
COLLECTOR_ENV_KEYS=$(node "$ROOT/tests/print-collector-envs.mjs")
[ -n "$COLLECTOR_ENV_KEYS" ] || { echo "FATAL: cannot derive collector env keys from the registry"; exit 1; }
for KEY in $COLLECTOR_ENV_KEYS; do
  export "$KEY=$EMPTY"
done
# Claude Code 用合成 fixture（其余采集器没有 fixture，一律指向空目录）。
export OMEM_CLAUDE_PROJECTS="$ROOT/tests/fixtures/claude-projects"

# 守卫：所有采集根必须落在仓库内。漏配 env 时采集器会退回 ~/.xxx 的真实目录，
# 这里当场失败，而不是等到产物里混进真实会话才被发现。
for VAR in OMEM_HOME $COLLECTOR_ENV_KEYS; do
  VAL="${!VAR:-}"
  case "$VAL" in
    "$ROOT"/*) ;;
    *) echo "FATAL: $VAR=$VAL is outside the repository ($ROOT). Smoke tests must never read real session directories."; exit 1 ;;
  esac
done
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
run() { "${OMEM[@]}" "$@" 2>&1; }

echo "== S1 omem init =="
OUT=$(run init); CODE=$?
[ $CODE -eq 0 ] && ok "exit code 0" || bad "exit code $CODE: $OUT"
[ -f "$OMEM_HOME/config.toml" ] && ok "config.toml generated" || bad "config.toml missing"
[ -d "$OMEM_HOME/knowledge" ] && ok "knowledge/ generated" || bad "knowledge/ missing"
[ -d "$OMEM_HOME/sessions" ] && ok "sessions/ generated" || bad "sessions/ missing"
[ -d "$OMEM_HOME/.git" ] && ok "git data repo initialized" || bad "git data repo missing"
[ -f "$OMEM_HOME/MEMORY-INDEX.md" ] && ok "MEMORY-INDEX.md generated" || bad "MEMORY-INDEX.md missing"

echo "== S2 omem add --topic + search =="
OUT=$(run add "本项目使用 Postgres 而非 MySQL 作为主数据库" --topic postgres-db); CODE=$?
[ $CODE -eq 0 ] && ok "add exit code 0" || bad "add exit code $CODE: $OUT"
echo "$OUT" | grep -q "Saved topic: postgres-db" && ok "add reports the topic (identity = filename)" || bad "add did not report the topic: $OUT"
[ -f "$OMEM_HOME/knowledge/coding/postgres-db.md" ] && ok "living document written at knowledge/<domain>/<topic>.md" || bad "living document path wrong"
OUT=$(run search "而非 mysql"); CODE=$?
[ $CODE -eq 0 ] && ok "search exit code 0" || bad "search exit code $CODE"
# 注意：断言要用「正文里才有、查询里没有」的词。零结果文案会回显查询词，
# 拿查询词本身去 grep，命中与否都说明不了任何事。
echo "$OUT" | grep -q "主数据库" && ok "multi-word hit" || bad "multi-word miss: $OUT"
echo "$OUT" | grep -q 'topic `postgres-db`' && ok "the hit line carries the topic" || bad "hit line has no topic: $OUT"
echo "$OUT" | grep -q "not reviewed" && ok "output carries the freshness label" || bad "output missing freshness label: $OUT"

echo "== S2b add 缺 --topic 必须被拒（topic 是身份，不是可选元数据）=="
OUT=$(run add "没有主题的随手记"); CODE=$?
[ $CODE -eq 1 ] && ok "missing --topic rejected with exit 1" || bad "missing --topic exit $CODE (expected 1): $OUT"

echo "== S2c auto commit (一次写入一个 commit) =="
COMMITS=$(git -C "$OMEM_HOME" rev-list --count HEAD 2>/dev/null || echo 0)
[ "$COMMITS" -ge 2 ] && ok "omem add produced a commit (init + add = $COMMITS)" || bad "no commit after add (count $COMMITS)"
DIRTY=$(git -C "$OMEM_HOME" status --porcelain | wc -l | tr -d ' ')
[ "$DIRTY" -eq 0 ] && ok "working tree clean after add (auto commit flushed it)" || bad "$DIRTY file(s) left uncommitted after add"

echo "== S3 short query fallback (<3 chars) =="
OUT=$(run search "库")
echo "$OUT" | grep -q "Postgres" && ok "single-char query hit" || bad "single-char query miss: $OUT"

echo "== S4 external edit → catch-up (改 md 后下次调用可见) =="
F=$(find "$OMEM_HOME/knowledge" -name '*.md' | head -1)
echo "" >> "$F"; echo "外部编辑标记 handedit-marker-123 由 Obsidian 追加" >> "$F"
OUT=$(run search "handedit-marker-123")
echo "$OUT" | grep -q "Obsidian 追加" && ok "external edit absorbed" || bad "external edit not absorbed: $OUT"

echo "== S5 omem verify (从 md 重建内存视图 + 重渲染 MEMORY-INDEX) =="
rm -f "$OMEM_HOME/MEMORY-INDEX.md"
OUT=$(run verify); CODE=$?
[ $CODE -eq 0 ] && ok "verify exit code 0" || bad "verify exit code $CODE: $OUT"
echo "$OUT" | grep -q "Index fully rebuilt" && ok "verify reports the rebuild" || bad "verify report missing: $OUT"
[ -f "$OMEM_HOME/MEMORY-INDEX.md" ] && ok "MEMORY-INDEX.md regenerated" || bad "MEMORY-INDEX.md not regenerated"
OUT=$(run search "而非 mysql")
echo "$OUT" | grep -q "主数据库" && ok "search recovered after verify" || bad "search not recovered after verify"

echo "== S6 omem sync (采集会话原文，不抽结论) =="
OUT=$(run sync); CODE=$?
[ $CODE -eq 0 ] && ok "sync exit code 0" || bad "sync exit code $CODE: $OUT"
echo "$OUT" | grep -q "Summary" && ok "sync prints a summary" || bad "summary missing: $OUT"
find "$OMEM_HOME/sessions" -name '*.md' | grep -q . && ok "session file written" || bad "no session file"
if grep -rq "source: rules" "$OMEM_HOME/knowledge" 2>/dev/null; then bad "rule fragments written"; else ok "no rule fragments"; fi
if grep -rq "sk-ant-abc123" "$OMEM_HOME/sessions" 2>/dev/null; then bad "secrets not redacted"; else ok "secrets redacted"; fi
grep -rq "REDACTED" "$OMEM_HOME/sessions" 2>/dev/null && ok "redaction marker written" || bad "redaction marker missing"
if grep -rq "sidechain-marker-xyz" "$OMEM_HOME/sessions" 2>/dev/null; then bad "sidechain not filtered"; else ok "sidechain sub-agent entries filtered"; fi
if grep -rq "会话摘要" "$OMEM_HOME/sessions" 2>/dev/null; then bad "summary not filtered"; else ok "summary entries filtered"; fi

echo "== S6c PROCESS.md: 预算 / 行数 / 会话行不带绝对路径 =="
GUIDE="$OMEM_HOME/PROCESS.md"
[ -f "$GUIDE" ] && ok "PROCESS.md generated" || bad "PROCESS.md missing"
GBYTES=$(wc -c < "$GUIDE" | tr -d ' ')
# 宿主 Read 的判据是 字符数÷4 > 20000（≈80,000 字符）才拒；45,000 是本项目的预算上限。
[ "$GBYTES" -le 45000 ] && ok "PROCESS.md within the 45000 B budget ($GBYTES)" || bad "PROCESS.md over budget: $GBYTES"
# 注意：这里必须用 grep -F。本机 Git-Bash 的 BRE 会把 '\\' 解释掉，`grep -c 'C:\Users'`
# 对含 551 条盘符路径的文件也返回 0 —— 那是假阴性（QA 2026-10-29 实测）。
SESS_LINES=$(grep -cF '  - `' "$GUIDE" || true)
SESS_WITH_DRIVE=$(grep -F '  - `' "$GUIDE" | grep -cF ':\' || true)
[ "${SESS_WITH_DRIVE:-0}" -eq 0 ] && ok "no drive letters in session lines (grep -F, $SESS_LINES line(s))" || bad "$SESS_WITH_DRIVE session line(s) carry a drive letter"
[ "${SESS_LINES:-0}" -ge 1 ] && ok "the pending fixture session is listed" || bad "no session line rendered"
grep -qF 'hidden by the size budget' "$GUIDE" && bad "budget tripped on the smoke fixture (should fit)" || ok "no degradation on the smoke fixture"

OUT=$(run sync --tier rules); CODE=$?
[ $CODE -eq 1 ] && ok "tier rules rejected (exit 1)" || bad "tier rules exit $CODE (expected 1): $OUT"

echo "== S6p omem process (API drain help + dry-run, no collectors) =="
OUT=$(run process --help); CODE=$?
[ $CODE -eq 0 ] && ok "process --help exit 0" || bad "process --help exit $CODE: $OUT"
echo "$OUT" | grep -q "omem process" && ok "process help names the command" || bad "process help missing: $OUT"
OUT=$(run process --dry-run); CODE=$?
[ $CODE -eq 0 ] && ok "process --dry-run exit 0" || bad "process --dry-run exit $CODE: $OUT"
echo "$OUT" | grep -qE '\[api\] batch:|dry-run:' && ok "process dry-run prints batch/dry-run info" || bad "process dry-run output unexpected: $OUT"

echo "== S6b isolation self-check (no real session directories were read) =="
# 采集产物只能来自 claude-code fixture——其余采集器都指向空目录。
# 出现别的 agent 子目录 = 某个采集器漏了隔离 env，读到了本机真实会话，当场失败。
STRAY=$(find "$OMEM_HOME/sessions" -mindepth 1 -maxdepth 1 -type d ! -name claude-code 2>/dev/null | tr '\n' ' ')
if [ -z "$STRAY" ]; then ok "no stray agent directories in sessions/"; else bad "stray session dirs (isolation broken): $STRAY"; fi
# 双保险：每个 agent 子目录里的文件必须都是 fixture 带来的那一个 session。
NFILES=$(find "$OMEM_HOME/sessions" -name '*.md' | wc -l | tr -d ' ')
[ "$NFILES" = "1" ] && ok "exactly 1 session ingested (fixture only)" || bad "expected 1 session file, got $NFILES"

echo "== S7 omem review --confirm（人工过目 → confidence 0.90）=="
OUT=$(run review --confirm postgres-db); CODE=$?
[ $CODE -eq 0 ] && ok "confirm exit code 0" || bad "confirm exit code $CODE: $OUT"
echo "$OUT" | grep -q "Reviewed" && ok "confirm takes effect" || bad "confirm not effective: $OUT"
F="$OMEM_HOME/knowledge/coding/postgres-db.md"
grep -q "^confidence: 0.9$" "$F" && ok "confidence raised to 0.9" || bad "confidence not raised: $(grep '^confidence' "$F")"
grep -q "^confirmations: 1$" "$F" && ok "confirmations incremented" || bad "confirmations not incremented"
grep -q "^verified" "$F" && bad "the verified field is still on disk (D2: it must be gone)" || ok "no verified field on disk (D2)"

echo "== S8 omem review --gc（只标 stale，不删）=="
sed -i 's/^last_confirmed:.*/last_confirmed: 2020-01-01T00:00:00.000Z/' "$F"
OUT=$(run review --gc --days 1); CODE=$?
[ $CODE -eq 0 ] && ok "gc exit code 0" || bad "gc exit code $CODE: $OUT"
echo "$OUT" | grep -qE "marked [1-9] stale" && ok "gc marks stale" || bad "gc did not mark: $OUT"
grep -q "^status: stale$" "$F" && ok "stale written" || bad "stale not written"
[ -f "$F" ] && ok "the file is still there (nothing deleted)" || bad "the file was deleted (gc must never delete)"
run review --confirm postgres-db >/dev/null

echo "== S9 omem topics list（主题词表）=="
OUT=$(run topics list); CODE=$?
[ $CODE -eq 0 ] && ok "topics exit code 0" || bad "topics exit code $CODE: $OUT"
echo "$OUT" | grep -q "postgres-db" && ok "the topic shows up in the vocabulary" || bad "topic missing from the list: $OUT"

echo "== S10 omem backup (no remote → local commit) =="
OUT=$(run backup status); CODE=$?
[ $CODE -eq 0 ] && ok "backup status exit code 0" || bad "exit code $CODE: $OUT"
echo "$OUT" | grep -q "Backend: git" && ok "git backend status" || bad "backend status abnormal: $OUT"
OUT=$(run backup); CODE=$?
[ $CODE -eq 0 ] && ok "backup exit code 0" || bad "exit code $CODE: $OUT"
echo "$OUT" | grep -q "No remote configured" && ok "local commit and note when no remote" || bad "no-remote note missing: $OUT"
OUT=$(run backup status)
echo "$OUT" | grep -q "Ahead: 0" && ok "nothing to push after commit" || bad "still ahead: $OUT"

echo "== S11 work profile rejects backup (exit code 2) =="
run profile use work >/dev/null
OUT=$(run backup); CODE=$?
[ $CODE -eq 2 ] && ok "work profile rejects backup" || bad "exit code $CODE (expected 2)"
echo "$OUT" | grep -q "work profile" && ok "actionable hint given" || bad "hint missing: $OUT"
run profile use home >/dev/null

echo "== S12 omem redact --topic（唯一硬删）=="
run add "待硬删的条目 redact-target-marker" --topic redact-target >/dev/null
F2=$(find "$OMEM_HOME/knowledge" -name 'redact-target.md')
[ -n "$F2" ] && ok "the document was written" || bad "document not written"
OUT=$(run redact --topic redact-target); CODE=$?
[ $CODE -eq 0 ] && ok "redact exit code 0" || bad "redact exit code $CODE: $OUT"
echo "$OUT" | grep -q "Dry run" && ok "--topic previews by default" || bad "no dry-run output: $OUT"
echo "$OUT" | grep -q -- "--yes" && ok "re-run command shown" || bad "no re-run hint"
echo "$OUT" | grep -q "Not removed" && ok "deletion scope stated" || bad "scope missing: $OUT"
[ -f "$F2" ] && ok "nothing deleted without --yes" || bad "deleted without --yes"
OUT=$(run redact --topic redact-target --yes)
echo "$OUT" | grep -q "Hard deleted" && ok "--yes performs the delete" || bad "--yes did not delete: $OUT"
[ ! -f "$F2" ] && ok "file deleted" || bad "file not deleted"
OUT=$(run search "待硬删")
if echo "$OUT" | grep -q "redact-target-marker"; then bad "index entry not removed"; else ok "index entry removed"; fi

echo "== S13 同 topic 再写一次 = 覆盖（一份活文档，git 留历史）=="
run add "第一版内容 overwrite-demo-v1" --topic overwrite-demo >/dev/null
OUT=$(run add "第二版内容 overwrite-demo-v2" --topic overwrite-demo); CODE=$?
[ $CODE -eq 0 ] && ok "second write exit code 0" || bad "second write exit code $CODE: $OUT"
echo "$OUT" | grep -q "Updated topic: overwrite-demo" && ok "the second write updates the same document" || bad "not reported as an update: $OUT"
NFILES=$(find "$OMEM_HOME/knowledge" -name 'overwrite-demo.md' | wc -l | tr -d ' ')
[ "$NFILES" = "1" ] && ok "exactly 1 living document for the topic" || bad "$NFILES files for one topic"
OUT=$(run search "第二版内容")
echo "$OUT" | grep -q "overwrite-demo-v2" && ok "the new body is searchable" || bad "new body not searchable: $OUT"

echo "== S14 MCP probe (handshake + tool calls) =="
run add "这个项目以后都用手写 SQL" --topic sql-policy >/dev/null
OUT=$(node "$ROOT/tests/mcp-probe.mjs" "$ROOT/bin/omem.js"); CODE=$?
[ $CODE -eq 0 ] && ok "MCP handshake and tool calls all pass" || { bad "MCP probe failed"; echo "$OUT" | sed 's/^/    /'; }

echo "== S15 redact --source 先预览，--yes 才删 =="
run add "S15 批量删除确认 s15-batch-marker" --topic batch-delete >/dev/null
OUT=$(run redact --source manual)
echo "$OUT" | grep -q "Dry run" && ok "previews by default" || bad "no dry-run output: $OUT"
grep -rq "s15-batch-marker" "$OMEM_HOME/knowledge" 2>/dev/null && ok "nothing deleted without --yes" || bad "deleted without --yes"
echo "$OUT" | grep -q -- "--yes" && ok "re-run command shown" || bad "no re-run hint"
OUT=$(run redact --source manual --yes)
echo "$OUT" | grep -q "Hard deleted" && ok "--yes performs the delete" || bad "--yes did not delete: $OUT"
OUT=$(run redact --source llm)
echo "$OUT" | grep -q "No entries match" && ok "zero matches is a no-op" || bad "unexpected zero-match output: $OUT"

echo "== S16 backup 在任何 git 动作前警告非空 [api].key =="
sed -i 's/^key = ""$/key = "sk-smoke-guard"/' "$OMEM_HOME/config.toml"
OUT=$(run backup); CODE=$?
[ $CODE -eq 0 ] && ok "backup with key in config exits 0" || bad "exit code $CODE: $OUT"
echo "$OUT" | grep -q "non-empty \[api\].key" && ok "key warning printed" || bad "no key warning: $OUT"
echo "$OUT" | grep -q "OMEM_API_KEY" && ok "warning suggests env var alternative" || bad "no alternative suggested: $OUT"
grep -q 'key = "sk-smoke-guard"' "$OMEM_HOME/config.toml" && ok "config not rewritten by backup" || bad "backup modified config"
sed -i 's/^key = "sk-smoke-guard"/key = ""/' "$OMEM_HOME/config.toml"
OUT=$(run backup)
echo "$OUT" | grep -q "non-empty \[api\].key" && bad "warning fires with empty key" || ok "no warning when key empty"

echo "== S17 双进程 CLI 写入 + expected-revision（best-effort）=="
run add "S17 第一版内容 concurrent-marker" --topic concurrent-target >/dev/null
REV=$(run search "S17 第一版内容" --detail | grep 'revision:' | head -n 1 | awk '{print $2}')
[ -n "$REV" ] && ok "CLI exposes revision" || bad "no revision line: $REV"
run add "S17 另一个客户端先写" --topic concurrent-target >/dev/null
OUT=$(run add "S17 带着旧 revision 写" --topic concurrent-target --expected-revision "$REV")
echo "$OUT" | grep -q "Not written" && ok "stale revision refused by CLI" || bad "not refused: $OUT"
F17=$(find "$OMEM_HOME/knowledge" -name 'concurrent-target.md')
grep -q "S17 另一个客户端先写" "$F17" && ok "newer body preserved" || bad "newer body lost"

echo ""
echo "═══════════════════════════════════════"
echo "Result: $PASS passed / $FAIL failed"
[ $FAIL -eq 0 ] && echo "✅ smoke all green" || echo "❌ failures present"
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
