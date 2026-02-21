# AGENTS.md — @tokentop/agent-gemini-cli

## What is TokenTop?

[TokenTop](https://github.com/tokentopapp/tokentop) is a terminal-based dashboard for monitoring
AI token usage and costs across providers and coding agents. It uses a plugin architecture
(`@tokentop/plugin-sdk`) with four plugin types: **provider** (API cost fetching), **agent**
(session parsing), **theme** (TUI colors), and **notification** (alerts).

This package is an **agent plugin**. Agent plugins parse local session files written by coding
agents (Claude Code, Cursor, etc.) to extract per-turn token usage, then feed normalized
`SessionUsageData` rows back to the TokenTop core for display. This plugin specifically tracks
Gemini CLI session usage.

## Build & Run

```bash
bun install                  # Install dependencies
bun run build                # Full build (types + JS bundle)
bun run build:types          # tsc --emitDeclarationOnly
bun run build:js             # bun build → dist/
bun run typecheck            # tsc --noEmit (strict)
bun test                     # Run all tests (bun test runner)
bun test src/parser.test.ts  # Run a single test file
bun test --watch             # Watch mode
```

CI runs `bun run build` then `bun run typecheck`. Both must pass.

## Project Structure

| File | Responsibility |
|------|----------------|
| `src/index.ts` | Plugin entry point — wires `createAgentPlugin()` with `isInstalled`, `parseSessions`, `startActivityWatch`, `stopActivityWatch`; re-exports cache constants and path values |
| `src/parser.ts` | Session parsing — reads Gemini CLI JSON conversation files, validates messages via `isTokenBearingGeminiMessage()` type guard, produces deduplicated `SessionUsageData` rows with three-tier caching (TTL, aggregate, metadata index) |
| `src/watcher.ts` | File watching — two watcher subsystems: session watcher (dirty path tracking for incremental parsing) and activity watcher (real-time delta emission via `primeSeenMessages`/`processSessionDelta` dedup) |
| `src/cache.ts` | Cache state — TTL-based session cache (2 s), per-session aggregate cache with LRU eviction (10K max), file metadata index for stat-skip optimization |
| `src/paths.ts` | Path resolution — `~/.gemini` and `~/.gemini/tmp` constants, multi-hash-dir `chats/` directory discovery |
| `src/types.ts` | Type definitions — `GeminiCliConversationRecord`, `GeminiCliTokensSummary`, message union (`GeminiCliGeminiMessage` \| `GeminiCliOtherMessage`), `GeminiCliTokenBearingMessage` narrowed type |
| `src/utils.ts` | Utilities — safe JSON file reading (`readJsonFile`), project path extraction from `directories` array |

## Architecture Notes

- **Session storage**: Gemini CLI stores conversations under `~/.gemini/tmp/<projectHash>/chats/session-<id>.json`. Each project hash directory groups sessions for one working directory. `getChatsDirs()` discovers all hash subdirectories and returns their `chats/` paths.

- **Conversation format**: Each session file is a single JSON object (`GeminiCliConversationRecord`) with fields: `sessionId`, `projectHash`, `startTime`, `lastUpdated`, `messages[]`, optional `summary`, optional `directories[]`. Messages are a discriminated union on `type` — `'gemini'` for model responses (may carry token data), `'user'`/`'info'`/`'error'`/`'warning'` for non-model entries.

- **Token data**: Gemini CLI provides actual token counts (not estimates) in `GeminiCliTokensSummary`: `input` (promptTokenCount), `output` (candidatesTokenCount), `cached` (cachedContentTokenCount), optional `thoughts` (thoughtsTokenCount), optional `tool` (toolUsePromptTokenCount), `total` (totalTokenCount). The type guard `isTokenBearingGeminiMessage()` narrows the message union to `GeminiCliTokenBearingMessage` by validating `type === 'gemini'`, non-empty string `id`, and `tokens.input > 0`.

- **Three-tier caching**:
  1. `sessionCache` — TTL-based (2 s), caches the full `SessionUsageData[]` result. Keyed on limit + since params. Short-circuits `parseSessions` entirely when fresh.
  2. `sessionAggregateCache` — Per-session parsed rows keyed by `sessionId`, LRU-evicted at 10K entries. Invalidated when file `mtimeMs` changes.
  3. `sessionMetadataIndex` — Maps file paths to `{ mtimeMs, sessionId }`. Allows skipping `stat()` + parse for unchanged, non-dirty files. Pruned on each parse to remove entries for deleted files.

- **Dirty tracking + reconciliation**: `sessionWatcher` uses `fs.watch()` on each `chats/` directory. File changes add paths to a `dirtyPaths` set consumed on next `parseSessions` call. A root watcher on `~/.gemini/tmp` detects new hash directories at runtime. Every 10 minutes (`RECONCILIATION_INTERVAL_MS`), `forceFullReconciliation` triggers a full stat sweep to catch changes the filesystem watcher may have missed.

- **Real-time activity watching**: `startActivityWatch()` primes a `seenMessageIds` map (file path → `Set<messageId>`) by reading all existing session files on startup. When a file changes, `processSessionDelta()` re-reads it and emits an `ActivityUpdate` only for messages whose `id` is not in the seen set. This is a full-file-re-read approach (not offset-based delta reads) suited to Gemini CLI's single-JSON file format. Thought tokens (`tokens.thoughts`) are emitted as `reasoning` in the activity update.

- **Deduplication**: `msg.id` is the dedup key throughout. `parseSessionFileRows()` uses a `Map<id, SessionUsageData>` for per-parse dedup. `processSessionDelta()` uses a per-file `Set<id>` (`seenMessageIds`) for cross-invocation dedup.

- **Multi-hash-dir discovery**: `getChatsDirs()` reads all subdirectories of `~/.gemini/tmp`, checks for a `chats/` child, and returns valid paths. Both session and activity watchers monitor the root tmp directory for new hash dirs appearing at runtime via `tryWatchNewHashDir()`.

## TypeScript Configuration

- **Strict mode**: `strict: true` — all strict checks enabled
- **No unused code**: `noUnusedLocals`, `noUnusedParameters` both `true`
- **No fallthrough**: `noFallthroughCasesInSwitch: true`
- **Target**: ESNext, Module: ESNext, ModuleResolution: bundler
- **Types**: `bun-types` (not `@types/node`)
- **Declaration**: Emits `.d.ts` + declaration maps + source maps

## Code Style

### Imports

- **Use `.ts` extensions** in all relative imports: `import { foo } from './bar.ts'`
- **Type-only imports** use the `type` keyword:
  ```typescript
  import type { SessionUsageData } from '@tokentop/plugin-sdk';
  import { createAgentPlugin, type AgentFetchContext } from '@tokentop/plugin-sdk';
  ```
- **Node.js modules** via namespace imports: `import * as fs from 'fs'`, `import * as path from 'path'`
- **Order**: External packages → relative imports (no blank line separator used)

### Module Format

- ESM only (`"type": "module"` in package.json)
- Named exports for everything except the main plugin (default export)
- Re-export public API items explicitly from `index.ts`

### Naming Conventions

- **Constants**: `UPPER_SNAKE_CASE` — `CACHE_TTL_MS`, `RECONCILIATION_INTERVAL_MS`
- **Functions**: `camelCase` — `parseSessionsFromProjects`, `readJsonlFile`
- **Interfaces**: `PascalCase` — `GeminiCliSessionEntry`, `SessionWatcherState`
- **Type predicates**: `is` prefix — `isTokenBearingEntry(entry): entry is ...`
- **Unused required params**: Underscore prefix — `_ctx: PluginContext`
- **File names**: `kebab-case.ts`

### Types

- **Interfaces** for object shapes, not type aliases
- **Explicit return types** on all exported functions
- **Type predicates** for runtime validation guards (narrowing `unknown` → typed)
- **`Partial<T>`** for candidate validation instead of `as any`
- Never use `as any`, `@ts-ignore`, or `@ts-expect-error`
- Validate unknown data at boundaries with type guard functions

### Functions

- **Functional style** — no classes. State held in module-level objects/Maps
- **Pure functions** where possible; side effects isolated to watcher/cache modules
- **Early returns** for guard clauses
- **Async/await** throughout, no raw Promise chains

### Error Handling

- **Empty catch blocks are intentional** for graceful degradation (filesystem ops that may fail)
- Pattern: `try { await fs.access(path); } catch { return []; }`
- Never throw from filesystem operations — return empty/default values
- Use `Number.isFinite()` for numeric validation, not `isNaN()`
- Validate at data boundaries, trust within module

### Formatting

- No explicit formatter config (Prettier/ESLint not configured)
- 2-space indentation (observed convention)
- Single quotes for strings
- Trailing commas in multiline structures
- Semicolons always
- Opening brace on same line

## Plugin SDK Contract

The plugin SDK (`@tokentop/plugin-sdk`) defines the interface contract between plugins and
the TokenTop core (`~/development/tokentop/ttop`). The SDK repo lives at
`~/development/tokentop/plugin-sdk`. This plugin is a peer dependency consumer — it declares
`@tokentop/plugin-sdk` as a `peerDependency`, not a bundled dep.

This plugin implements the `AgentPlugin` interface via the `createAgentPlugin()` factory:

```typescript
const plugin = createAgentPlugin({
  id: 'gemini-cli',
  type: 'agent',
  agent: { name: 'Gemini CLI', command: 'gemini', configPath, sessionPath },
  capabilities: { sessionParsing: true, realTimeTracking: true, ... },
  isInstalled(ctx) { ... },
  parseSessions(options, ctx) { ... },
  startActivityWatch(ctx, callback) { ... },
  stopActivityWatch(ctx) { ... },
});
export default plugin;
```

### AgentPlugin interface (required methods)

| Method | Signature | Purpose |
|--------|-----------|---------|
| `isInstalled` | `(ctx: PluginContext) → Promise<boolean>` | Check if this agent exists on the user's machine |
| `parseSessions` | `(options: SessionParseOptions, ctx: AgentFetchContext) → Promise<SessionUsageData[]>` | Parse session files into normalized usage rows |
| `startActivityWatch` | `(ctx: PluginContext, callback: ActivityCallback) → void` | Begin real-time file watching, emit deltas |
| `stopActivityWatch` | `(ctx: PluginContext) → void` | Tear down watchers |

### Key SDK types

| Type | Shape | Used for |
|------|-------|----------|
| `SessionUsageData` | `{ sessionId, providerId, modelId, tokens: { input, output, cacheRead?, cacheWrite? }, timestamp, sessionUpdatedAt?, projectPath?, sessionName? }` | Normalized per-turn usage row returned from `parseSessions` |
| `ActivityUpdate` | `{ sessionId, messageId, tokens: { input, output, cacheRead?, cacheWrite? }, timestamp }` | Real-time delta emitted via `ActivityCallback` |
| `SessionParseOptions` | `{ sessionId?, limit?, since?, timePeriod? }` | Filters passed by core to `parseSessions` |
| `AgentFetchContext` | `{ http, logger, config, signal }` | Context bag — `ctx.logger` for debug logging |
| `PluginContext` | `{ logger, storage, config, signal }` | Context for lifecycle methods |

### SDK subpath imports

| Import path | Use |
|-------------|-----|
| `@tokentop/plugin-sdk` | Everything (types + helpers) |
| `@tokentop/plugin-sdk/types` | Type definitions only |
| `@tokentop/plugin-sdk/testing` | `createTestContext()` for tests |

## Commit Conventions

Conventional Commits enforced by CI on both PR titles and commit messages:

```
feat(parser): add support for cache_creation breakdown
fix(watcher): handle race condition in delta reads
chore(deps): update dependencies
refactor: simplify session metadata indexing
```

Valid prefixes: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
Optional scope in parentheses. Breaking changes use `!` suffix before colon.

## Release Process

- semantic-release via GitHub Actions (currently manual `workflow_dispatch`)
- Publishes to npm as `@tokentop/agent-gemini-cli` with public access + provenance
- Runs `bun run clean && bun run build` before publish (`prepublishOnly`)
- Branches: `main` only

## Testing

- Test runner: `bun test` (Bun's built-in test runner)
- Test files: `*.test.ts` (excluded from tsconfig compilation, picked up by bun test)
- Place test files adjacent to source: `src/parser.test.ts`
- Use `createTestContext()` from `@tokentop/plugin-sdk/testing` for mock contexts
