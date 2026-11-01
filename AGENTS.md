# AGENTS.md

For agents modifying code in this repository. User-visible behavior is governed by the source code and `docs/omem-V0.1技术规格草案.md`; the README is the outward-facing doc and must be updated alongside behavior changes.

## Project

omem is a git-native personal AI memory layer (V0.1, TypeScript, Node ≥ 22.5). One memory = one Markdown file. `knowledge/` and `archive/` are the source of truth; there is **no index database**: the in-memory view is rebuilt from Markdown on every start (`omem verify` re-renders `MEMORY-INDEX.md`). MCP lets multiple clients share the same memory store.

Runtime data lives in `OMEM_HOME` (default `~/.omem`). Development, tests, and smoke runs must always use isolated directories; never read or write the user's real `~/.omem`.

## Non-negotiables

- **Never auto-delete.** `omem review --gc` only marks entries `stale` (search down-weight ×0.5). Hard delete exists only via `omem redact`, and must delete both the Markdown and the index row. Archiving moves the file to `archive/` and sets `status=archived`; the file stays under version control.
- **Conflicts are reported only.** Sync never auto-merges. The remote version is saved as `.conflict.md`; the local version is kept. Skip `*.conflict.md` when walking memory files.
- **Markdown is the source of truth.** `store` never caches; it reads from disk every time. External edits (e.g. Obsidian) are absorbed by connect-time catch-up: `(size, mtime)` fast path, file content hash slow path.
- **Do not mix the two hashes.** The file content hash detects external edits; the normalized-body `contentHash` (`body_hash`) provides idempotent dedup across the three write paths.
- **There is no `verified` flag (D2).** Confidence is the only trust number and it always describes *this* text: the evidence ladder in `src/process/score.ts` (`grounded 0.55` → `ungrounded 0.35`, plus a corroboration bonus) decides it at write time. No write path may add `verified` back — a boolean that survives edits degrades into "this topic was looked at once". "A human looked at it" is expressed by `confirmations > 0` + `last_confirmed`, and the human tier is `confidence = 0.9` (`REVIEW_CAP` in `core/lifecycle.ts`, `SCORE_CONFIRMED` in `process/score.ts` — same value, two homes, because `core ↔ process` must not import each other). `tests/unit/score-ladder.test.ts` pins all five rungs.
- **Redact before writing.** All ingest paths must pass through `redactSecrets`. `exclude_paths` still skips paths. `exclude_keywords` is no longer applied. Rule extraction (`--tier rules`) is removed.
- **A living-document update inherits the trail, not the score.** `created`, `source_sessions`, `evidence` and the human-review counters (`confirmations` / `last_confirmed`) carry over; `confidence` is always recomputed from this write. Inheritance happens in `collectSourceSessions` / `mergeEvidence` inside `core/commit.ts`; do not re-read the old file elsewhere.
- **There is no topic-level policy file (D5).** `review.toml` and `core/review-policy.ts` are gone: a second policy channel decided "whether to look" from a config file, which is exactly the silent path v0.2 removes. The only human actions are 过目 / 归档 / 冷却, all reached through `omem review`. Do not reintroduce a policy file, and do not add a second one to `config.toml`.
- **Corroboration must never count the entry's own source as independent.** When a `session_id` is cited, that session is excluded from the corroborating set; when no `session_id` is given, the first index hit may be the source itself, so it awards no bonus (`corroborationFromIndex`). The invariant to preserve is scoped to **evidence on the table**: given the same quote, naming the session must not score lower than omitting it. `tests/unit/score-ladder.test.ts` pins that. The separate inversion "cites a session but no evidence (0.35 `ungrounded`) < cites nothing (0.55 `pending-session`)" is real and deliberately left open — it is a `scoreEvidence` branch-shape question, not a corroboration-accounting one, and it is queued as decision material for scoring plan C. Do not silently widen the invariant to cover it.
- **Corroboration counts independent sources, not session files.** The unit of counting is the *evidence-domain user text* (`evidenceUserKey` in `collect/session-store.ts`): two session files whose `## user` section normalizes to the same text are **one** source. The cited session's own key is claimed first (`buildSourceSkip` in `process/score.ts`), so a copy of the source conversation never counts as corroboration either. Reason: the same conversation synced twice, or collected by two agents, is one utterance — counting files would let copy-paste inflate confidence (0.55 → 0.80 from five copies). Two *different* utterances that happen to contain the same quote still count separately.
- **No full-text index exists.** Search is a linear scan over in-memory rows (`core/search.ts`): cheap at this corpus size, and it keeps ranking a plain function instead of an opaque `bm25` score.
- **MCP `initialize.instructions` and `save_memory`'s description are one contract.** `save_memory` tells the agent to open `PROCESS.md` and follow the work loop; the path and the loop are spelled out only by `src/context/instructions.ts`, which `server.ts` passes on `initialize`. Changing either without the other recreates the original defect, where the description pointed at something the client could not obtain.
- **Commit copy is caller-aware.** `CommitInput.caller` decides whether a rejection tells the caller to pass `--topic` (CLI) or `topic: "<name>"` (MCP). MCP clients cannot execute CLI flags, so no `--` form may leak into a tool response; the same applies to warnings that reference `omem topics` / `omem search --all`, and to `omem sync` (an MCP response says "ask the user to run it"). Dedup metadata drift is computed once in `core/commit.ts` (`metadataDrift`) and only rendered per caller — CLI and MCP must not each hand-write the comparison.
- **Topic warnings are decided in `commitEntry` only.** Near-duplicate detection (`isNearDupTopic`) and cross-topic merge reporting both live there and are returned as `CommitResult.warnings` — never as rejections, because rejecting would stall an agent mid-write. `process/pipeline.ts` only renders those warnings; it must not re-implement the check.
- **The work profile blocks sync and export by default** (`ProfileBlockedError`, exit code 2). Only `OMEM_ALLOW_WORK_EXPORT=1` allows it. `OMEM_PROFILE_LOCKED=1` locks the profile.
- **MCP stdout carries protocol only.** Logs go to stderr or `logs/omem.log`. Default tools are only `search_memory` / `save_memory`; `memory_feedback` is enabled via `OMEM_MCP_TOOLS=feedback`. Do not expand the default tool surface.
- **install's six write disciplines:** merge only `mcpServers.omem` (or that client's single corresponding key), back up first, write atomically, update idempotently, print a manual snippet instead of overwriting when parsing fails, and close with a restart-client reminder.
- **git config is written to the data repo only.** Never modify the user's global git config. When git is not detected, return an actionable hint (`BackendUnavailableError`); do not throw a bare stack.

Exit codes: `0` success (including handled conflicts), `1` usage error (`UsageError`), `2` backend unavailable or policy rejection.

## Modules

| Path | Responsibility |
| --- | --- |
| `bin/omem.js` | Startup wrapper: dynamic import on Windows must use a `file://` URL |
| `src/cli.ts` `src/cli-args.ts` | Command dispatch. Must not call `process.exit` when imported (`OMEM_CLI_ENTRY`) |
| `src/commands/` | One file per command, returns an exit code |
| `src/core/` | Entries, paths, config, storage, index, search, lifecycle, profiles, redaction, snapshots. `version.ts` is the single source of the version string (CLI + MCP serverInfo); `search-format.ts` owns the zero-result copy shared by CLI and MCP |
| `src/collect/` | Read-only collection (`claude-code`, `workbuddy`, `cursor`, `qwenwork`, `doubao`, `deepseek`, `qoder`, `catpaw`, `codebuddy`). Transcripts land in `sessions/`. New platforms: see "Skills" |
| `src/collect/registry.ts` | Collector registry: the single source of truth for collector ids, their `config.collect.*` keys, and their `OMEM_*_PROJECTS` isolation env vars |
| `src/process/` | Ingest then tier: `agent` (default, writes `PROCESS.md`) / `api` (off by default). `rules` is removed |
| `src/mcp/` | stdio MCP server and tool implementations. `server.ts` passes `instructions` on initialize, injects the real version, and reloads `config.toml` by mtime on each call |
| `src/install/` | Client registry, config writing, TOML subset |
| `src/sync/` | `SyncBackend`. V0.1 implements only `GitBackend`; `webdav` / `dir` throw "not yet delivered" |
| `src/web/` | `omem review --ui` 的本地页面与 HTTP 服务（127.0.0.1 + 一次性 token）。页面模板内联为 TS 字符串——`tsc` 不复制非 TS 文件，独立 `.html` 在发布包里会丢 |
| `src/context/export.ts` | Context export for non-MCP clients |
| `src/context/instructions.ts` | The agent-facing instruction text: MCP `initialize.instructions` plus the shared rule sentences also used by the export marker block |
| `tests/unit/` | Vitest. `tests/smoke.sh` and `tests/mcp-probe.mjs` are end-to-end |

frontmatter is a flat YAML subset (string / number / boolean / string array); field order is defined by `FM_ORDER` in `src/core/entry.ts`. Config is a TOML subset of `config.toml`, losslessly round-trippable only for files omem itself writes.

Memory paths: `knowledge/<domain>/<YYYY>/<id>.md`, ids like `2026-10-15-a1b2c3`. Types are only `preference | fact | decision | experience`.

`topic` **is** the identity and the file name (`knowledge/<domain>/<topic>.md`, D1-B′); it is never written into frontmatter — `parseEntry` injects it from the path. `coding` / `general` are domains, not topics. One living document per topic: writing the same topic again overwrites that file, and git is the version chain. Any command that lists entries must print the topic, otherwise the naming space is invisible to the caller (that gap is what produced near-duplicate topics in practice).

## Commands

```bash
npm install
npm run build          # tsc → dist/; published artifacts run from dist, build after changing src
npm test               # vitest
npm run smoke          # bash tests/smoke.sh, ships with an isolated OMEM_HOME
```

No database: the index is derived from Markdown in memory (B stage). Do not reintroduce `node:sqlite` or any other native module.

Runtime dependencies are `@modelcontextprotocol/sdk` and `@toondepauw/node-zstd`. The zstd package is the one exception to the "no native modules" rule: DeepSeek Harness stores its sessions as zstd-compressed JSONL, and the collector must decompress them. It ships prebuilt binaries (win32/darwin/linux, x64 and arm64) so no source compilation is required. Do not add further native dependencies without weighing the install cost against the alternative.

## Code conventions

- ESM, `NodeNext`: imports within the repo use `.js` suffixes. `strict: true`.
- Each file starts with a one-line Chinese comment stating its responsibility, referencing spec sections (`规格 §x.y`) when needed. **All user-visible copy is English** (single-language CLI; `docs/` and the README remain in Chinese). Chinese strings inside regexes that match Chinese session content (e.g. `src/process/rules.ts`) are detection logic, not UI — do not translate them.
- Persisted writes go through `atomicWrite` (temp file + `rename`). CLI and MCP paths use synchronous IO.
- New commands: implement in `src/commands/`, register `desc` / `usage` / `run` in `COMMANDS` in `src/cli.ts`, add unit tests.
- New sync backends or collectors: implement the interface and add one line to the registry; undelivered ids return an actionable error, never a stub implementation. Read `.agents/skills/add-session-collector/SKILL.md` before adding a new session collector.
- **The collector registry (`src/collect/registry.ts`) is the single source of truth** for collector ids, their `config.collect.*` keys, and their `OMEM_*_PROJECTS` isolation env vars. Do not hand-write a second copy of that mapping — `src/process/pipeline.ts` derives its missing-directory hints from it, and `tests/smoke.sh` derives its isolation list from it.
- Do not invent product behavior. V0.1 ships no time decay, no WebDAV/local-directory sync, no MCP sampling.

## Skills

The repo-root `.agents/skills/<name>/SKILL.md` directory is the cross-client skill catalog ([Agent Skills](https://agentskills.io/specification)). Cursor, Claude Code, Codex, etc. discover skills from here. Do not put project skills in `.cursor/skills/`.

| Skill | When to read |
| --- | --- |
| `.agents/skills/add-session-collector/SKILL.md` | Adding a read-only session collector for Qoder, Kimi, or other Agents |

## Testing

- Use `makeHome()` / `cleanupHome()` from `tests/unit/helpers.ts` to create temporary stores; delete them after tests.
- Unit tests import `src/`, never `dist/`. When covering `src/cli.ts`, call the exported `main()` directly; do not treat the module as a process entry.
- Tests are hermetic: every case gets a temp `OMEM_HOME` (`tests/unit/helpers.ts`). There is no index database to seed or tear down.
- When touching MCP, install writes, or sync, run `npm run smoke` in addition to unit tests. The MCP probe must assert that stdout carries no logs.
- **Isolation is a hard requirement, not a convention.** Any test or script that scans sessions must run against isolated directories only — the developer's real `~/.claude`, `~/.catpaw`, `~/.qoder`, and friends must never be read. `tests/smoke.sh` derives its isolation list from `src/collect/registry.ts` and refuses to run if any collector root falls outside the repository; `tests/unit/collector-isolation.test.ts` fails if the registry, the config keys, the env vars, and the smoke script drift apart. Adding a collector means adding one row to the registry — the guards then cover it automatically.
- Do not commit `dist/`, `node_modules/`, `.omem-test/`.
