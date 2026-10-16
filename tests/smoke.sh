#!/usr/bin/env bash
# omem V0.1 端到端冒烟（对应实施计划 §6.1 的 S1–S14，另加 S15 supersede）。
# 全程使用隔离的 OMEM_HOME 与合成 fixture，不触碰真实 ~/.omem。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OMEM=(node "$ROOT/bin/omem.js")
export OMEM_HOME="$ROOT/.omem-test/home"
export OMEM_CLAUDE_PROJECTS="$ROOT/tests/fixtures/claude-projects"
rm -rf "$ROOT/.omem-test"
mkdir -p "$ROOT/.omem-test/empty-projects"
export OMEM_WORKBUDDY_PROJECTS="$ROOT/.omem-test/empty-projects"
export OMEM_CURSOR_PROJECTS="$ROOT/.omem-test/empty-projects"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
run() { "${OMEM[@]}" "$@" 2>&1; }

echo "== S1 omem init --no-scan =="
OUT=$(run init --no-scan); CODE=$?
[ $CODE -eq 0 ] && ok "exit code 0" || bad "exit code $CODE: $OUT"
[ -f "$OMEM_HOME/config.toml" ] && ok "config.toml generated" || bad "config.toml missing"
[ -d "$OMEM_HOME/knowledge" ] && ok "knowledge/ generated" || bad "knowledge/ missing"
[ -d "$OMEM_HOME/sessions" ] && ok "sessions/ generated" || bad "sessions/ missing"
[ -d "$OMEM_HOME/.git" ] && ok "git data repo initialized" || bad "git data repo missing"
[ -f "$OMEM_HOME/MEMORY-INDEX.md" ] && ok "MEMORY-INDEX.md generated" || bad "MEMORY-INDEX.md missing"

echo "== S2 omem add + search (≥3-char trigram) =="
OUT=$(run add "本项目使用 Postgres 而非 MySQL 作为主数据库"); CODE=$?
[ $CODE -eq 0 ] && ok "add exit code 0" || bad "add exit code $CODE: $OUT"
OUT=$(run search "Postgres 而非"); CODE=$?
[ $CODE -eq 0 ] && ok "search exit code 0" || bad "search exit code $CODE"
echo "$OUT" | grep -q "Postgres" && ok "multi-word trigram hit" || bad "multi-word trigram miss: $OUT"
echo "$OUT" | grep -q "confirmed" && ok "output carries freshness label" || bad "output missing freshness label"

echo "== S3 short query LIKE fallback (trigram invalid for <3 chars) =="
OUT=$(run search "库")
echo "$OUT" | grep -q "Postgres" && ok "single-char query LIKE fallback hit" || bad "single-char query miss: $OUT"

echo "== S4 external edit → catch-up (spec §2.3, detected on next access) =="
F=$(find "$OMEM_HOME/knowledge" -name '*.md' | head -1)
echo "" >> "$F"; echo "外部编辑标记 handedit-marker-123 由 Obsidian 追加" >> "$F"
OUT=$(run search "handedit-marker-123")
echo "$OUT" | grep -q "handedit-marker-123" && ok "external edit absorbed by catch-up" || bad "external edit not absorbed: $OUT"

echo "== S5 delete index → rebuild full recovery =="
rm -f "$OMEM_HOME/index/omem.db"
OUT=$(run rebuild); CODE=$?
[ $CODE -eq 0 ] && ok "rebuild exit code 0" || bad "rebuild exit code $CODE: $OUT"
echo "$OUT" | grep -q "Index fully rebuilt" && ok "rebuild reports output" || bad "rebuild report missing"
OUT=$(run search "Postgres 而非")
echo "$OUT" | grep -q "Postgres" && ok "search recovered after rebuild" || bad "search not recovered after rebuild"

echo "== S6 omem run (ingest transcripts; rules tier removed) =="
OUT=$(run run); CODE=$?
[ $CODE -eq 0 ] && ok "run exit code 0" || bad "run exit code $CODE: $OUT"
echo "$OUT" | grep -q "tier agent" && ok "default tier is agent" || bad "not agent: $OUT"
find "$OMEM_HOME/sessions" -name '*.md' | grep -q . && ok "session file written" || bad "no session file"
if grep -rq "source: rules" "$OMEM_HOME/knowledge" 2>/dev/null; then bad "rule fragments written"; else ok "no rule fragments"; fi
if grep -rq "sk-ant-abc123" "$OMEM_HOME/sessions" 2>/dev/null; then bad "secrets not redacted"; else ok "secrets redacted"; fi
grep -rq "REDACTED" "$OMEM_HOME/sessions" 2>/dev/null && ok "redaction marker written" || bad "redaction marker missing"
if grep -rq "sidechain-marker-xyz" "$OMEM_HOME/sessions" 2>/dev/null; then bad "sidechain not filtered"; else ok "sidechain sub-agent entries filtered"; fi
if grep -rq "会话摘要" "$OMEM_HOME/sessions" 2>/dev/null; then bad "summary not filtered"; else ok "summary entries filtered"; fi
BAD=$(run run --tier rules); CODE=$?
[ $CODE -eq 1 ] && ok "tier rules rejected" || bad "tier rules exit $CODE: $BAD"

echo "== S7 omem review --confirm =="
RID=$(grep -rl "Postgres" "$OMEM_HOME/knowledge" | head -1 | xargs basename | sed 's/\.md$//')
OUT=$(run review --confirm "$RID"); CODE=$?
[ $CODE -eq 0 ] && ok "confirm exit code 0" || bad "confirm exit code $CODE: $OUT"
echo "$OUT" | grep -q "Confirmed" && ok "confirm takes effect" || bad "confirm not effective"
F=$(find "$OMEM_HOME/knowledge" -name "$RID.md")
grep -q "verified: true" "$F" && ok "verified promotion written" || bad "verified not promoted"

echo "== S8 omem gc (mark stale only) =="
F=$(grep -rl "Postgres" "$OMEM_HOME/knowledge" | head -1)
sed -i 's/^last_confirmed:.*/last_confirmed: 2026-01-01T00:00:00.000Z/' "$F"
OUT=$(run gc); CODE=$?
[ $CODE -eq 0 ] && ok "gc exit code 0" || bad "gc exit code $CODE: $OUT"
echo "$OUT" | grep -qE "marked [1-9] stale" && ok "gc marks stale" || bad "gc did not mark: $OUT"
grep -q "status: stale" "$F" && ok "stale written" || bad "stale not written"

echo "== S9 omem context --for =="
OUT=$(run context --for claude-code); CODE=$?
[ $CODE -eq 0 ] && ok "claude-code export exit code 0" || bad "exit code $CODE: $OUT"
echo "$OUT" | grep -q "MEMORY-INDEX" && ok "claude-code exports INDEX" || bad "claude-code export abnormal"
OUT=$(run context --for cursor)
echo "$OUT" | grep -q "alwaysApply: true" && ok "cursor .mdc export" || bad "cursor export abnormal"
echo "$OUT" | grep -q "OMEM:INSTRUCTIONS:START" && ok "cursor export carries instructions" || bad "instructions section missing"
OUT=$(run context --for codex)
echo "$OUT" | grep -q "OMEM:START" && ok "codex AGENTS.md section export" || bad "codex export abnormal"

echo "== S10 omem sync (no remote → local commit) =="
OUT=$(run sync status); CODE=$?
[ $CODE -eq 0 ] && ok "sync status exit code 0" || bad "exit code $CODE: $OUT"
echo "$OUT" | grep -q "Backend: git" && ok "git backend status" || bad "backend status abnormal: $OUT"
OUT=$(run sync); CODE=$?
[ $CODE -eq 0 ] && ok "sync exit code 0" || bad "sync exit code $CODE: $OUT"
echo "$OUT" | grep -q "No remote configured" && ok "local commit and note when no remote" || bad "no-remote note missing: $OUT"
OUT=$(run sync status)
echo "$OUT" | grep -q "Ahead: 0" && ok "nothing to push after commit" || bad "still ahead: $OUT"

echo "== S11 work profile rejects sync (exit code 2) =="
run profile use work >/dev/null
OUT=$(run sync); CODE=$?
[ $CODE -eq 2 ] && ok "work profile rejects sync" || bad "exit code $CODE (expected 2)"
echo "$OUT" | grep -q "work profile" && ok "actionable hint given" || bad "hint missing"
run profile use home >/dev/null

echo "== S12 omem redact (the only hard delete) =="
F2=$(grep -rl "Postgres" "$OMEM_HOME/knowledge" | head -1)
ID2=$(basename "$F2" .md)
OUT=$(run redact --id "$ID2"); CODE=$?
[ $CODE -eq 0 ] && ok "redact exit code 0" || bad "redact exit code $CODE: $OUT"
[ ! -f "$F2" ] && ok "file deleted" || bad "file not deleted"
OUT=$(run search "Postgres 而非")
if echo "$OUT" | grep -q "主数据库"; then bad "index entry not removed"; else ok "index entry removed"; fi

echo "== S13 omem snapshot (rolling retention) =="
OUT=$(run snapshot); CODE=$?
[ $CODE -eq 0 ] && ok "snapshot exit code 0" || bad "exit code $CODE: $OUT"
ls "$OMEM_HOME/snapshots" 2>/dev/null | grep -q "$(date +%Y-%m-%d)" && ok "today's snapshot created" || bad "snapshot missing"

echo "== S14 MCP probe (handshake + tool calls) =="
run add "这个项目以后都用手写 SQL" --type preference >/dev/null
OUT=$(node "$ROOT/tests/mcp-probe.mjs" "$ROOT/bin/omem.js"); CODE=$?
[ $CODE -eq 0 ] && ok "MCP handshake and tool calls all pass" || { bad "MCP probe failed"; echo "$OUT" | sed 's/^/    /'; }

echo "== S15 supersede explicit entry =="
OUT=$(run add "S15旧约定使用本地磁盘保存日志 s15-old-marker")
OLD=$(printf '%s\n' "$OUT" | sed -n 's/^Saved id: //p' | head -1)
[ -n "$OLD" ] && ok "old entry id=$OLD" || bad "failed to parse old id: $OUT"
OUT=$(run add "S15新约定日志改走标准输出 s15-new-marker" --supersedes "$OLD")
echo "$OUT" | grep -q "Supersedes" && ok "add --supersedes declares supersession" || bad "supersession not declared: $OUT"
OUT=$(run search "s15-old-marker")
echo "$OUT" | grep -q "No memories found" && ok "default search excludes superseded" || bad "default search still returns old entry: $OUT"
OUT=$(run search "s15-old-marker" --all)
echo "$OUT" | grep -q "s15-old-marker" && ok "--all brings back superseded" || bad "--all did not bring back: $OUT"
OUT=$(run search "s15-new-marker")
echo "$OUT" | grep -q "s15-new-marker" && ok "new entry still searchable" || bad "new entry not hit: $OUT"
REV=$(run review)
CAND=$(printf '%s\n' "$REV" | sed -n 's/^- `\([^`]*\)`.*/\1/p' | head -1)
if [ -n "$CAND" ]; then
  OUT=$(run review --confirm "$CAND" --supersedes "$OLD")
  echo "$OUT" | grep -q "Confirmed" && ok "review --confirm --supersedes confirms" || bad "review not confirmed: $OUT"
  echo "$OUT" | grep -q "Superseded" && ok "review declares supersession" || bad "review did not supersede: $OUT"
else
  bad "review queue empty, cannot verify --supersedes"
fi

echo "== S16 redact --source previews first, --yes deletes =="
run add "S16 批量删除确认 s16-batch-marker" >/dev/null
OUT=$(run redact --source manual)
echo "$OUT" | grep -q "Dry run" && ok "previews by default" || bad "no dry-run output: $OUT"
grep -rq "s16-batch-marker" "$OMEM_HOME/knowledge" 2>/dev/null && ok "nothing deleted without --yes" || bad "deleted without --yes"
echo "$OUT" | grep -q -- "--yes" && ok "re-run command shown" || bad "no re-run hint"
OUT=$(run redact --source manual --yes)
echo "$OUT" | grep -q "Hard deleted" && ok "--yes performs the delete" || bad "--yes did not delete: $OUT"
OUT=$(run redact --source llm)
echo "$OUT" | grep -q "No entries match" && ok "zero matches is a no-op" || bad "unexpected zero-match output: $OUT"

echo ""
echo "═══════════════════════════════════════"
echo "Result: $PASS passed / $FAIL failed"
[ $FAIL -eq 0 ] && echo "✅ smoke all green" || echo "❌ failures present"
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
