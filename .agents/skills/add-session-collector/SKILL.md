---
name: add-session-collector
description: >-
  Add a read-only session collector to omem, converting a new Agent's sessions into the Unified Session Schema and registering it into scanSessions;
  optionally wire up `omem install` MCP configuration for the same client.
  Use when integrating sessions from Qoder, Kimi, WorkBuddy, Cursor, Claude Code, CatPaw, or other platforms, adding a collector, adding an install client, or changing the omem sync scan scope.
---

# Add a session collector (and optional install wiring)

The processing layer only recognizes `SessionDigest`. A new platform needs just one read-only adapter plus a single line in the registry. Do not bend extraction rules to accommodate a particular JSON shape.

Registered: `claude-code`, `workbuddy`, `cursor`, `qwenwork`, `doubao`, `deepseek`, `qoder`, `catpaw`. Compare against the similarly shaped one in `src/collect/`; do not invent a directory layout from scratch.

## Two parts (always read both)

This skill covers two independent parts. The user may ask for either or both:

1. **Session collection** — `omem sync` reads session files and produces memories. Entry point: `src/collect/collector.ts`.
2. **MCP install wiring** — `omem install` writes the client's MCP config so the client can reach omem as an MCP server. Entry point: `src/install/clients.ts`.

When the user asks for both (e.g. "适配 catpaw，增加采集器和 install 的 mcp 配置选项"), do the collector first, then the install wiring. Each part has its own checklist below.

## Hard constraints (apply to both parts)

- **Read-only**: Parsers (`src/collect/*.ts`) use `readFileSync` / `readdirSync` / `statSync`. Never write, truncate, or delete the other party's sessions, SQLite, `mcp.json`, or instruction files.
- **Install wiring is merge-only**: `omem install` must only modify the `mcpServers.<omem-key>` entry in the target config file. Other `mcpServers` entries and other top-level keys are preserved untouched. Always back up the original file before writing (already handled by `install-writer.ts` — do not bypass).
- When probing real local sessions or configs, print only field names, types, and counts. Never write bodies or secrets into the repo, test output, or replies.
- Unit tests and smoke runs must never scan the user's real directories. Config uses absolute paths; only paths starting with `~` pick up environment variables.
- When a collector's directory does not exist, record a single note; do not make `scanSessions` return early and drop other collectors.
- Skip corrupted lines. When there are no valid messages, `parse` returns `null`.
- Sub-agents, reasoning, tool calls, tool results, snapshots, and summary lines never enter `messages`. Keep only plain user / assistant text.

---

## Part A: Session collector

### Checklist

```
- [ ] 1. Confirm path + format (read-only probe)
- [ ] 2. Write list + parse adapter, mapping to SessionDigest
- [ ] 3. Register in collector, config, and pipeline env-var table
- [ ] 4. Synthetic fixture unit tests; isolate new dir in all pipeline-ingesting tests
- [ ] 5. npm test passes
- [ ] 6. Optional: isolated OMEM_HOME live test on the real machine
```

### 1. Confirm the format

Find session files in the other party's data directory. Use a script to count: line types, top-level keys, whether `content` is a string or array, the `type` of text blocks, and the nesting depth of the transcript file. Do not print `text` / bodies.

Watch out for multiple dot-dir variants (e.g. `.catpaw` vs `.catpawai`); check each to find the one that actually holds sessions.

Compare against the existing eight and pick the closest style:

| Collector | Listing | How to recognize a message | Scaffold to drop |
| --- | --- | --- | --- |
| `claude-code` | `<root>/<project>/*.jsonl`, non-recursive | `type` is `user` / `assistant`; body in `message.content`. | `summary`, `isSidechain`, `tool_use` |
| `workbuddy` | Same, one level | `type === "message"`, `role` at top level; blocks are `input_text` / `output_text`. | `reasoning`, `function_call`, snapshots |
| `cursor` | `<root>/<project>/agent-transcripts/<id>/<id>.jsonl` | No `type`. `role` + `type === "text"` inside `message.content[]`. | Do not list `subagents/` |
| `qwenwork` | `<root>/<project>/*.jsonl` | OpenAI-messages style, `role` at top level. | `<system-reminder>`, `<user_query>` wrapper, tool calls |
| `doubao` | Windows `%LOCALAPPDATA%/Doubao/...` per-session JSONL | `role` + `content` array. | Multi-agent: keep only latest trajectory |
| `deepseek` | `~/.dsh/sessions/<project>/<sid>/session{.v4}.jsonl.zstd` | zstd-compressed typed JSONL. | zstd decompression, type markers |
| `qoder` | `~/.qoder/cache/projects/<project>/conversation-history/<cid>/<cid>.jsonl` | OpenAI-messages style text JSONL. | `<user_query>`, `<attached_files>`, `<system-reminder>`, `UltraPlan` |
| `catpaw` | `<root>/<project>/<session>/agent-transcripts/transcript.txt` | Plain text. `user:` + `<user_query>...</user_query>` blocks, `assistant:` replies. | `[Thinking]`, `[Tool call]`, `[Tool result]` blocks |

### 2. Adapter file

Create `src/collect/<id>.ts`. Start the file with a one-line Chinese comment stating the session path and filtering rules.

```ts
export function listXxxSessions(root: string, opts?: { since?: Date }): SessionFile[]
export function parseXxxFile(path: string): SessionDigest | null
```

`SessionFile` uses the type in `src/collect/claude-code.ts`. `SessionDigest` / `UnifiedMessage` use `src/collect/types.ts`.

Field conventions:

- `agent` uses a stable short id matching the registry, e.g. `catpaw`.
- `session_id` defaults to the filename (minus `.jsonl`) or `<project>/<sessionId>` for nested dirs. Keep it stable across runs.
- `msg_uuid` prefers the other party's message id, otherwise `` `${sessionId}#${seq}` ``.
- `content` concatenates text blocks only, then goes through `stripHarness` (`src/collect/dialogue.ts`): keep `<user_query>` text when present, otherwise drop `<system-reminder>` blocks. Do not leave tool arguments inside the string.
- `omem sync` writes the dialogue to `sessions/<agent>/<session_id>.md`. Do not write transcripts into `knowledge/`. `--tier rules` is removed; do not add a regex extractor that slices on 别/不要/禁止.
- Call `resolveProjectFp(cwd)` only when `cwd` exists (it only reads `git config`). Without cwd, `project_fp` is `local:<hash(projectDir)>` or `unknown`; never write to git just for a fingerprint.
- When timestamps are missing, use a stable placeholder ISO value (e.g. `new Date(0).toISOString()`), not `new Date()`, so the same file yields the same digest on every parse. File-level `started_ts` / `ended_ts` fall back to message timestamps or placeholder.
- For plain-text formats (like CatPaw), skip scaffold blocks by detecting `[Thinking]` / `[Tool call]` / `[Tool result]` line markers and consuming until the next block or role marker.

### 3. Registration

Apply changes in this order; missing any one means `omem sync` will not scan it, or tests will scan into the user's home directory.

1. `src/collect/collector.ts`: append the id to `COLLECTOR_IDS` (the `as const` tuple); add a branch in `getCollector`. For paths starting with `~`, use `rootFrom(config.collect.xxx_projects, 'OMEM_<ID>_PROJECTS', env)`. Do not misapply another collector's filter as the listing function.
2. `src/core/config.ts`: add `xxx_projects: string` to `OmemConfig.collect` interface, `defaultConfig()`, `fromParsed()`, and `serializeConfig()`, defaulting to `'~/.xxx/projects'` (per the real directory you verified). Old configs missing this key fall back to the default.
3. Add the id → `OMEM_<ID>_PROJECTS` mapping to `ROOT_ENV` in `src/process/pipeline.ts`. The missing-directory note comes from this table.
4. Docs — add the collector name, one sentence each:
   - `README.md` collector support table (append a row)
   - `docs/手动测试指南.md` §2 bullet (collector count + env var name + one-line format description)
   - `AGENTS.md` module table `src/collect/` cell

### 4. Tests

`tests/unit/<id>-collector.test.ts`: write synthetic transcripts in a temp directory; never commit real sessions.

- The kept user sentences are still there; tools, reasoning, and sub-agent markers are not.
- `size` and `mtimeMs` are unchanged before and after parsing.
- Multi-turn conversations produce N messages with monotonic `msg_uuid` seq.
- Empty / scaffold-only content returns `null`.
- Nonexistent file returns `null`.
- `--since` filtering works (future date → empty).
- `defaultXxxRoot`: env override wins; default matches expected pattern (account for Windows backslashes).

`tests/unit/collector.test.ts`: add the new id to the `COLLECTOR_IDS` assertion; have `scanSessions` scan it via a temp absolute path. Add the new `*_projects = ABSENT` in the first config() block and a nonexistent-path assertion in the roots block. Assert final scan (all real dirs) includes the new agent in digests.

`isolateOthers` in `tests/unit/pipeline.test.ts`: add `config.collect.xxx_projects = ABSENT;`. Otherwise `defaultConfig()` will scan real sessions on the developer's machine — this is the single most common regression when adding a collector.

`fixtureConfig()` in `tests/unit/session-ingest.test.ts`: same — add `config.collect.xxx_projects = ABSENT;`.

`cfgFor()` in `tests/unit/api-pipeline.test.ts`: same — add `config.collect.xxx_projects = ABSENT;`.

### 5. Smoke and local verification

`tests/smoke.sh` exports `OMEM_<ID>_PROJECTS` after isolating `OMEM_HOME`, pointing at an empty directory (can live under `.omem-test/` and be deleted after the run). Smoke must never read `~/.qoder`, `~/.kimi`, `~/.catpaw`, or other real session directories.

Local verification only when the user explicitly asks:

- Use an isolated `OMEM_HOME` (e.g. `C:\Users\<user>\omem-t1` on Windows, delete after).
- `omem init --no-scan` then `omem sync --collectors <id>`.
- Confirm session count and message count look reasonable for the real data.
- Confirm `omem search "<query>" --sessions` hits the parsed sessions.
- Delete the isolated `OMEM_HOME` when done.

---

## Part B: Install client wiring

This part adds the platform as an `omem install` target so the client can load omem as an MCP server.

### When to skip

Skip Part B if the user only said "add a collector" or "integrate sessions". Only do this part when the user explicitly mentions "install" / "MCP config" / "install 的 mcp 配置".

### Checklist

```
- [ ] 1. Confirm the client's MCP config path (non-destructive probe)
- [ ] 2. Add a ClientSpec entry in src/install/clients.ts
- [ ] 3. Verify the install-writer path with an isolated OMEM_HOME live test
```

### 1. Confirm the config path

Find the client's MCP settings file on the real machine. Common patterns:

| Client | Config location | Format |
| --- | --- | --- |
| Claude Desktop | `~/.claude/claude_desktop_config.json` | json-mcp |
| Cursor | `~/.cursor/mcp.json` | json-mcp |
| VS Code / CatPaw / Cline | Extension global storage `settings/mcopilot_mcp_settings.json` or similar | json-mcp |

Note that a single product family may have multiple dot-dir variants (e.g. `.catpaw` vs `.catpawai`). Check each to find the one that actually holds the config.

The config almost always has the shape:
```json
{ "mcpServers": { "omem": { "command": "...", "args": [...] } } }
```

Probe read-only — print path existence, top-level keys, and `mcpServers` entry count. Never print secrets.

### 2. Add the ClientSpec

In `src/install/clients.ts`, add one entry to the `CLIENTS` array. Use an existing entry (e.g. `catpaw` or `cline`) as a template.

```ts
{
  id: 'catpaw',
  name: 'CatPaw',
  kind: 'json-mcp',
  configPath: () =>
    win({
      win: join(APPDATA, 'CatPawAI', 'User', 'globalStorage', 'mt-idekit.mt-idekit-code', 'settings', 'mcopilot_mcp_settings.json'),
      mac: join(homedir(), 'Library', 'Application Support', 'CatPawAI', 'User', 'globalStorage', 'mt-idekit.mt-idekit-code', 'settings', 'mcopilot_mcp_settings.json'),
      linux: join(homedir(), '.config', 'CatPawAI', 'User', 'globalStorage', 'mt-idekit.mt-idekit-code', 'settings', 'mcopilot_mcp_settings.json'),
    }),
  detect: () =>
    existsSync(win({
      win: join(APPDATA, 'CatPawAI', 'User', 'globalStorage', 'mt-idekit.mt-idekit-code', 'settings'),
      mac: join(homedir(), 'Library', 'Application Support', 'CatPawAI', 'User', 'globalStorage', 'mt-idekit.mt-idekit-code', 'settings'),
      linux: join(homedir(), '.config', 'CatPawAI', 'User', 'globalStorage', 'mt-idekit.mt-idekit-code', 'settings'),
    })),
  verified: true, // only if you confirmed the file exists with the expected format on this machine
},
```

Notes:

- `id` must be unique across CLIENTS; do not reuse another client's id.
- `kind` is almost always `'json-mcp'`. Only change this if the client explicitly uses a different MCP boot protocol.
- `configPath` uses the `win()` helper for platform branching — always provide `win` / `mac` / `linux`.
- `detect` checks the parent directory's existence (not the file itself), since the file may not exist until `omem install` runs.
- Set `verified: true` only when you have confirmed the path + format on the real machine. Otherwise `false` with a note.

### 3. Live test the install path

Use an isolated `OMEM_HOME`:

```powershell
$env:OMEM_HOME="C:\Users\<user>\omem-t1"
node bin/omem.js init --no-scan
node bin/omem.js install --client catpaw --target catpaw
node bin/omem.js install --print-config catpaw
```

Verify:
- Config file is written / updated; backup (`*.omem-backup-*`) is created.
- `install --print-config` shows the `omem` entry under `mcpServers`.
- Other `mcpServers` entries and top-level keys are preserved (merge-only, no clobber).
- Clean up: `Remove-Item -Recurse -Force $env:OMEM_HOME`.

No unit tests are required for a new install client — the existing `install-writer.test.ts` already covers the merge/backup discipline generically.

---

## Completion criteria

Collector:
- `getCollector('<id>')` returns the adapter; unknown ids still throw "Unknown collector".
- `npx vitest run tests/unit/collector.test.ts tests/unit/<id>-collector.test.ts tests/unit/pipeline.test.ts tests/unit/session-ingest.test.ts tests/unit/api-pipeline.test.ts` passes.
- Session source files have no writes whatsoever.

Install wiring (when requested):
- `omem install --list` and top-level detection show the new client.
- `omem install --client <id> --target <id>` writes/merges the config, preserves other entries.
- `omem install --print-config <id>` shows the entry correctly.

Both:
- All existing tests (`npm test`) still pass.
