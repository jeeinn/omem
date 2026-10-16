---
name: add-session-collector
description: >-
  Add a read-only session collector to omem, converting a new Agent's sessions into the Unified Session Schema and registering it into scanSessions.
  Use when integrating sessions from Qoder, Kimi, WorkBuddy, Cursor, Claude Code, or other platforms, adding a collector, or changing the omem run scan scope.
  Not for MCP install wiring.
---

# Add a session collector

The processing layer only recognizes `SessionDigest`. A new platform needs just one read-only adapter plus a single line in the registry. Do not bend extraction rules to accommodate a particular JSON shape.

Registered: `claude-code`, `workbuddy`, `cursor`. Compare against the similarly shaped one in `src/collect/`; do not invent a directory layout from scratch.

## First, separate two things

- **Session collection** (this skill): `omem run` reads session files and produces memories. Entry point: `src/collect/collector.ts`.
- **MCP wiring**: `omem install` writes client config. Entry point: `src/install/clients.ts`. Do not touch it unless the user asks for wiring.

## Hard constraints

- Read-only. Parsers use `readFileSync` / `readdirSync` / `statSync`. Never write, truncate, or delete the other party's sessions, SQLite, `mcp.json`, or instruction files.
- When probing real local sessions, print only field names, types, and counts. Never write bodies or secrets into the repo, test output, or replies.
- Unit tests and smoke runs must never scan the user's real directories. Config uses absolute paths; only paths starting with `~` pick up environment variables.
- When a collector's directory does not exist, record a single note; do not make `scanSessions` return early and drop other collectors.
- Skip corrupted lines. When there are no valid messages, `parse` returns `null`.
- Sub-agents, reasoning, tool calls, tool results, snapshots, and summary lines never enter `messages`. Keep only plain user / assistant text.

## Workflow

Copy this checklist before starting:

```
- [ ] 1. Read-only: confirm where sessions live and which keys a JSONL line has
- [ ] 2. Write list + parse, mapping to SessionDigest
- [ ] 3. Register in collector, config, and the pipeline's env-var hints
- [ ] 4. Synthetic fixture unit tests; point the new directory at a nonexistent path in pipeline tests
- [ ] 5. Smoke-test with an empty directory to block the real home directory
- [ ] 6. npm test passes. For local verification, copy to a temp directory and check source file hashes
```

### 1. Confirm the format

Find session files in the other party's data directory (usually `*.jsonl`). Use a script to count: line types, top-level keys, whether `content` is a string or array, and the `type` of text blocks. Do not print `text`.

Compare against the existing three and pick the closest style:

| Collector | Listing | How to recognize a message in a line |
| --- | --- | --- |
| `claude-code` | `<root>/<project>/*.jsonl`, non-recursive | `type` is `user` / `assistant`; body in `message.content`. Skip `summary`, `isSidechain`, `tool_use` |
| `workbuddy` | Same, one level | `type === "message"`, `role` at top level; body blocks are `input_text` / `output_text`. Skip `reasoning`, `function_call`, snapshots |
| `cursor` | `<root>/<project>/agent-transcripts/<id>/<id>.jsonl` | No `type`. `role` + `type === "text"` inside `message.content[]`. Do not list `subagents/` |

### 2. Adapter file

Create `src/collect/<id>.ts`. Start the file with a one-line Chinese comment stating the session path and filtering rules.

```ts
export function listXxxSessions(root: string, opts?: { since?: Date }): SessionFile[]
export function parseXxxFile(path: string): SessionDigest | null
```

`SessionFile` uses the type in `src/collect/claude-code.ts`. `SessionDigest` / `UnifiedMessage` use `src/collect/types.ts`.

Field conventions:

- `agent` uses a stable short id matching the registry, e.g. `qoder`.
- `session_id` defaults to the filename (minus `.jsonl`). If lines carry their own id, keep the message's `session_id` consistent with the digest.
- `msg_uuid` prefers the other party's message id, otherwise `` `${sessionId}#${lineNumber}` ``.
- `content` concatenates text blocks only, then goes through `stripHarness` (`src/collect/dialogue.ts`): keep `<user_query>` text when present, otherwise drop `<system-reminder>` blocks. Do not leave tool arguments inside the string.
- `omem run` writes the dialogue to `sessions/<agent>/<session_id>.md`. Do not write transcripts into `knowledge/`. A keyword in `exclude_keywords` skips that session file.
- Call `resolveProjectFp(cwd)` only when `cwd` exists (it only reads `git config`). Without cwd, `project_fp` is `unknown`; never write to git just for a fingerprint.
- When timestamps are missing, use a stable placeholder ISO value, not `new Date()`, so the same file yields the same digest on every parse.

### 3. Registration

Apply changes in this order; missing any one means `omem run` will not scan it, or tests will scan into the user's home directory.

1. `src/collect/collector.ts`: append the id to `COLLECTOR_IDS`; add a branch in `getCollector`. For paths starting with `~`, use `rootFrom(configured, 'OMEM_<ID>_PROJECTS')`. Do not misapply another collector's filter as the listing function.
2. `src/core/config.ts`: add `xxx_projects` to `OmemConfig.collect`, `defaultConfig`, `fromParsed`, and `serializeConfig`, defaulting to `'~/.xxx/projects'` (per the real directory you verified). Old configs missing this key fall back to the default.
3. Add the id → `OMEM_<ID>_PROJECTS` mapping to `ROOT_ENV` in `src/process/pipeline.ts`. The missing-directory note comes from this table.
4. In `src/cli.ts`'s `run` description, the `README.md` command table, section 2 of `docs/手动测试指南.md`, and the `AGENTS.md` module table, add the collector name. One sentence each; do not rewrite the docs.

Do not add the new collector to `omem install`'s client table unless the user also asks for MCP wiring.

### 4. Tests

`tests/unit/<id>-collector.test.ts`: write synthetic JSONL in a temp directory; never commit real sessions.

- The kept user sentences are still there; tools, reasoning, and sub-agent markers are not.
- `size` and `mtimeMs` are unchanged before and after parsing.
- If the format differs from Claude Code, `parseSessionFile` returns `null` for that file.
- Use `extractFromDigest` to confirm user sentences reach rule extraction. Synthetic sentences follow the existing fixture style, e.g. 「以后都用手写 SQL」.

`tests/unit/collector.test.ts`: add the new id to the `COLLECTOR_IDS` assertion; have `scanSessions` scan it via a temp absolute path. Also assert "when a directory does not exist, other collectors' digests are still present".

`isolateOthers` in `tests/unit/pipeline.test.ts`: point the new `*_projects` at a nonexistent directory. Otherwise `defaultConfig()` will scan real sessions on the developer's machine.

### 5. Smoke and local verification

`tests/smoke.sh` exports `OMEM_<ID>_PROJECTS` after isolating `OMEM_HOME`, pointing at an empty directory (can live under `.omem-test/` and be deleted after the run). Smoke must never read `~/.qoder`, `~/.kimi`, or other real session directories.

Local verification only when the user explicitly asks, following `tests/live/verify-local.mjs`:

- Copy to a temp directory before parsing.
- Point all `omem run` environment variables at the copy or empty directories.
- At the end, compare source file SHA-256, plus the other party's config file size and mtime.
- Delete the temp directory in `finally`.

## Completion criteria

- `getCollector('<id>')` returns the adapter; unknown ids still throw "Unknown collector".
- `npx vitest run tests/unit/collector.test.ts tests/unit/<id>-collector.test.ts tests/unit/pipeline.test.ts` passes.
- Session source files have no writes whatsoever.
