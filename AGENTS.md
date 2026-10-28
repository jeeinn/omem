# AGENTS.md

For agents modifying code in this repository. User-visible behavior is governed by the source code and `docs/omem-V0.1技术规格草案.md`; the README is the outward-facing doc and must be updated alongside behavior changes.

## Project

omem is a git-native personal AI memory layer (V0.1, TypeScript, Node ≥ 22.5). One memory = one Markdown file. `knowledge/` and `archive/` are the source of truth; `index/omem.db` (SQLite + FTS5 trigram) is a derived index that can be deleted and rebuilt with `omem rebuild`. MCP lets multiple clients share the same memory store.

Runtime data lives in `OMEM_HOME` (default `~/.omem`). Development, tests, and smoke runs must always use isolated directories; never read or write the user's real `~/.omem`.

## Non-negotiables

- **Never auto-delete.** `gc` only marks entries `stale` (search down-weight ×0.5). Hard delete exists only via `omem redact`, and must delete both the Markdown and the index row. Archiving moves the file to `archive/` and sets `status=archived`; the file stays under version control.
- **Conflicts are reported only.** Sync never auto-merges. The remote version is saved as `.conflict.md`; the local version is kept. Skip `*.conflict.md` when walking memory files.
- **Markdown is the source of truth.** `store` never caches; it reads from disk every time. External edits (e.g. Obsidian) are absorbed by connect-time catch-up: `(size, mtime)` fast path, file content hash slow path.
- **Do not mix the two hashes.** The file content hash detects external edits; the normalized-body `contentHash` (`body_hash`) provides idempotent dedup across the three write paths.
- **Automatically processed output is always `verified: false`.** Only an explicit `omem add` / `review --confirm` marks an entry confirmed (and raises confidence to 0.9). `save_memory` `confirm_ids` caps confidence at 0.8 and does not set verified. Tone is not scored: the old imperative-tone penalty (`INSTRUCTION_TONE` → `low-weight`) was removed in `ad6305f`; what remains is the evidence ladder in `src/process/score.ts` (`grounded 0.55` → `ungrounded 0.35`, plus corroboration bonus).
- **Redact before writing.** All ingest paths must pass through `redactSecrets`. `exclude_paths` still skips paths. `exclude_keywords` is no longer applied. Rule extraction (`--tier rules`) is removed.
- **A living-document update inherits the trail, not the trust.** `source_sessions` and `evidence` are carried over from the superseded documents (evidence capped at 8 entries / 2000 chars, sessions at 200 ids); `verified` and `confirmations` reset. Inheritance happens in `collectSourceSessions` / `mergeEvidence`; do not re-read the old files elsewhere.
- **`review.toml` is separate from `config.toml` on purpose.** Topic policies grow dynamically at write frequency; putting them in config.toml would break its text-level section merge. Writes go through `core/review-policy.ts` only.
- **Corroboration must never count the entry's own source as independent.** When a `session_id` is cited, that session is excluded from the corroborating set; when no `session_id` is given, the first index hit may be the source itself, so it awards no bonus (`corroborationFromIndex`). The invariant to preserve is scoped to **evidence on the table**: given the same quote, naming the session must not score lower than omitting it. `tests/unit/score-ladder.test.ts` pins that. The separate inversion "cites a session but no evidence (0.35 `ungrounded`) < cites nothing (0.55 `pending-session`)" is real and deliberately left open — it is a `scoreEvidence` branch-shape question, not a corroboration-accounting one, and it is queued as decision material for scoring plan C. Do not silently widen the invariant to cover it.
- **`topic` is never searched through FTS.** `entries_fts` has no topic column and `CREATE VIRTUAL TABLE IF NOT EXISTS` would not migrate existing databases — adding the column would force every user through `omem rebuild`. Filter `entries.topic` directly (`core/search.ts`).
- **MCP `initialize.instructions` and `save_memory`'s description are one contract.** `save_memory` tells the agent to open `PROCESS.md` and follow the work loop; the path and the loop are spelled out only by `src/context/instructions.ts`, which `server.ts` passes on `initialize`. Changing either without the other recreates the original defect, where the description pointed at something the client could not obtain.
- **Commit copy is caller-aware.** `CommitInput.caller` decides whether a rejection tells the caller to pass `--supersedes` (CLI) or `supersedes: ["<id>"]` (MCP). MCP clients cannot execute CLI flags, so no `--` form may leak into a tool response; the same applies to warnings that reference `omem topic list` / `omem search --all`, and to `omem sync` (an MCP response says "ask the user to run it"). Dedup metadata drift is computed once in `core/commit.ts` (`metadataDrift`) and only rendered per caller — CLI and MCP must not each hand-write the comparison.
- **Topic warnings are decided in `commitEntry` only.** Near-duplicate detection (`isNearDupTopic`) and cross-topic merge reporting both live there and are returned as `CommitResult.warnings` — never as rejections, because rejecting would stall an agent mid-write. `process/pipeline.ts` only renders those warnings; it must not re-implement the check.
- **The work profile blocks sync and export by default** (`ProfileBlockedError`, exit code 2). Only `OMEM_ALLOW_WORK_EXPORT=1` allows it. `OMEM_PROFILE_LOCKED=1` locks the profile.
- **MCP stdout carries protocol only.** Logs go to stderr or `logs/omem.log`. Default tools are only `search_memory` / `save_memory`; `memory_feedback` is enabled via `OMEM_MCP_TOOLS=feedback`. Do not expand the default tool surface.
- **install's six write disciplines:** merge only `mcpServers.omem` (or that client's single corresponding key), back up first, write atomically, update idempotently, print a manual snippet instead of overwriting when parsing fails, and close with a restart-client reminder.
- **git config is written to the data repo only.** Never modify the user's global git config. When git is not detected, return an actionable hint (`BackendUnavailableError`); do not throw a bare stack.

Exit codes: `0` success (including handled conflicts), `1` usage error (`UsageError`), `2` backend unavailable or policy rejection.

## Modules

| Path | Responsibility |
| --- | --- |
| `bin/omem.js` | Startup wrapper: re-execs when `--experimental-sqlite` is missing; dynamic import on Windows must use a `file://` URL |
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

`topic` is a frontmatter field only — it never appears in the path, and `coding` / `general` are domains, not topics. One `active` document per topic; updating one requires `supersedes` pointing at it. Any command that lists entries must print the topic, otherwise the naming space is invisible to the caller (that gap is what produced near-duplicate topics in practice).

## Commands

```bash
npm install
npm run build          # tsc → dist/; published artifacts run from dist, build after changing src
npm test               # vitest, forks + --experimental-sqlite
npm run smoke          # bash tests/smoke.sh, ships with an isolated OMEM_HOME
```

Node uses the built-in `node:sqlite`; do not introduce `better-sqlite3` or other native modules.

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
- Index-related tests depend on FTS5; when changing `vitest.config.ts`, keep `pool: 'forks'` and `--experimental-sqlite`.
- When touching MCP, install writes, or sync, run `npm run smoke` in addition to unit tests. The MCP probe must assert that stdout carries no logs.
- **Isolation is a hard requirement, not a convention.** Any test or script that scans sessions must run against isolated directories only — the developer's real `~/.claude`, `~/.catpaw`, `~/.qoder`, and friends must never be read. `tests/smoke.sh` derives its isolation list from `src/collect/registry.ts` and refuses to run if any collector root falls outside the repository; `tests/unit/collector-isolation.test.ts` fails if the registry, the config keys, the env vars, and the smoke script drift apart. Adding a collector means adding one row to the registry — the guards then cover it automatically.
- Do not commit `dist/`, `node_modules/`, `.omem-test/`.
