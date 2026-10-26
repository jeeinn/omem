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
- **Automatically processed output is always `verified: false`.** Only an explicit `omem add` / `review --confirm` marks an entry confirmed (and raises confidence to 0.9). `save_memory` `confirm_ids` caps confidence at 0.8 and does not set verified. Imperative tone ("必须 / 一律 / 永远") halves confidence and adds the `low-weight` tag.
- **Redact before writing.** All ingest paths must pass through `redactSecrets`. `exclude_paths` still skips paths. `exclude_keywords` is no longer applied. Rule extraction (`--tier rules`) is removed.
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
| `src/core/` | Entries, paths, config, storage, index, search, lifecycle, profiles, redaction, snapshots |
| `src/collect/` | Read-only session collection (`claude-code`, `workbuddy`, `cursor`, `qwenwork`). Transcripts land in `sessions/`. New platforms: see "Skills" |
| `src/process/` | Ingest then tier: `agent` (default, writes `PROCESS.md`) / `api` (off by default). `rules` is removed |
| `src/mcp/` | stdio MCP server and tool implementations |
| `src/install/` | Client registry, config writing, TOML subset |
| `src/sync/` | `SyncBackend`. V0.1 implements only `GitBackend`; `webdav` / `dir` throw "not yet delivered" |
| `src/context/export.ts` | Context export for non-MCP clients |
| `tests/unit/` | Vitest. `tests/smoke.sh` and `tests/mcp-probe.mjs` are end-to-end |

frontmatter is a flat YAML subset (string / number / boolean / string array); field order is defined by `FM_ORDER` in `src/core/entry.ts`. Config is a TOML subset of `config.toml`, losslessly round-trippable only for files omem itself writes.

Memory paths: `knowledge/<domain>/<YYYY>/<id>.md`, ids like `2026-10-15-a1b2c3`. Types are only `preference | fact | decision | experience`.

## Commands

```bash
npm install
npm run build          # tsc → dist/; published artifacts run from dist, build after changing src
npm test               # vitest, forks + --experimental-sqlite
npm run smoke          # bash tests/smoke.sh, ships with an isolated OMEM_HOME
```

Node uses the built-in `node:sqlite`; do not introduce `better-sqlite3` or other native modules. The only runtime dependency is `@modelcontextprotocol/sdk`.

## Code conventions

- ESM, `NodeNext`: imports within the repo use `.js` suffixes. `strict: true`.
- Each file starts with a one-line Chinese comment stating its responsibility, referencing spec sections (`规格 §x.y`) when needed. **All user-visible copy is English** (single-language CLI; `docs/` and the README remain in Chinese). Chinese strings inside regexes that match Chinese session content (e.g. `src/process/rules.ts`) are detection logic, not UI — do not translate them.
- Persisted writes go through `atomicWrite` (temp file + `rename`). CLI and MCP paths use synchronous IO.
- New commands: implement in `src/commands/`, register `desc` / `usage` / `run` in `COMMANDS` in `src/cli.ts`, add unit tests.
- New sync backends or collectors: implement the interface and add one line to the registry; undelivered ids return an actionable error, never a stub implementation. Read `.agents/skills/add-session-collector/SKILL.md` before adding a new session collector.
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
- Do not commit `dist/`, `node_modules/`, `.omem-test/`.
