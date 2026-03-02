# OpenClaw: Rate-Limit-Aware Auto-Compaction + Stateless `/` Queries

## Implementation Plan

### Two features:

1. **Rate-Limit Compaction** — When OpenClaw encounters a rate limit (429) error, check the session's context usage before entering cooldown. If context is above a configurable threshold (e.g. 60%), compact the session immediately. This reduces the payload size for the next attempt, lowering the chance of hitting the rate limit again and preventing the overflow → retry → cooldown cascade.

2. **Stateless `/` Prefix** — Messages starting with `/` followed by a non-command word (e.g. `/ask what is the capital of France`) are sent to the model **without session context** — no conversation history, no tool results, just the system prompt + the user's message. This saves tokens, avoids context overflow on simple queries, and gives users an escape hatch when their session is bloated or broken.

---

## 1. Problem Summary

The current error handling has two independent paths that don't communicate:

1. **Context overflow path** (`isContextOverflowError` → compact → retry) — only fires when the model explicitly says "prompt too large"
2. **Rate limit / failover path** (`classifyFailoverReason` → cooldown → try next profile/model) — fires on 429 errors but never considers whether compaction could help

This creates a vicious cycle:

```
Large context → slow requests → hit TPM/RPM limits → 429 → cooldown
→ retry with same large context → 429 again → extended cooldown
→ heartbeat fires with same bloated session → another 429 → all profiles in cooldown
→ bot goes dark
```

The fix: **intercept the rate limit path and opportunistically compact** before entering cooldown, so the next attempt uses a smaller context and is less likely to hit the limit again.

---

## 2. Codebase Map — Key Files and Their Roles

All paths are relative to `src/` in the OpenClaw repo (TypeScript, at commit ~4199f9).

### 2.1 Error Classification

**`src/agents/pi-embedded-helpers/errors.ts`**

- `isContextOverflowError(error)` — pattern-matches error strings for context overflow
- `isRateLimitErrorMessage(raw)` — matches 429 / rate_limit patterns
- `isOverloadedErrorMessage(raw)` — matches overloaded_error / 503
- `classifyFailoverReason(raw)` → returns `"rate_limit"` | `"billing"` | `"auth"` | `"timeout"` | `"format"` | `"model_not_found"` | `null`

This is where we add a new exported helper: `isRateLimitWithHighContext()`.

### 2.2 Agent Run Loop (where errors are caught)

**`src/agents/pi-embedded-runner/run.ts`** (~500 lines)

- `runEmbeddedPiAgent()` — the main run function
- Contains the error handling loop that currently:
  - Detects context overflow → calls `compactEmbeddedPiSessionDirect()` → retries
  - Detects overloaded (503) → calls compaction → retries (PR #5464)
  - Detects rate limit → throws `FailoverError` → caught upstream
- Has an `overflowCompactionAttempted` boolean guard to prevent repeated compaction
- This is the primary file we modify

### 2.3 Compaction Engine

**`src/agents/pi-embedded-runner/compact.ts`** (~490 lines)

- `compactEmbeddedPiSessionDirect(params)` — the function that actually runs compaction
  - Acquires session write lock
  - Builds system prompt with `promptMode: "minimal"`
  - Creates agent session with model, tools, session manager
  - Calls `session.compact(customInstructions)`
  - Estimates tokens after compaction
- Already battle-tested; we reuse this as-is

### 2.4 Run Attempt (where context size is known)

**`src/agents/pi-embedded-runner/run/attempt.ts`** (~860+ lines)

- `runEmbeddedAttempt()` — a single model call attempt
- Has access to the session's token counts and context window size
- Performs history limiting, validation, tool filtering
- Returns result with `meta.error.kind` field used by the run loop

### 2.5 Session Subscription (compaction coordination)

**`src/agents/pi-embedded-subscribe.ts`** (~224 lines)

- `subscribeEmbeddedPiSession()` — manages compaction state
- Maintains compaction guards to prevent race conditions
- Tracks `didCompact` state across concurrent turns

### 2.6 Agent Runner (upstream caller)

**`src/auto-reply/reply/agent-runner.ts`** (~500 lines)

- `runReplyAgent()` — orchestrates the full reply cycle
- Catches `FailoverError` from the embedded runner
- Handles the `meta.error.kind === "context_overflow"` case with session reset
- This is where we add a **pre-failover compaction check**

**`src/auto-reply/reply/agent-runner-execution.ts`**

- Calculates `contextPercent` from session entry (per Issue #2597)
- Passes it through to the run params
- We use this existing context percentage for our threshold check

### 2.7 Context Window Guard

**`src/agents/context-window-guard.ts`** (~53 lines)

- Validates requests stay within context limits before sending
- Resolves context window from model catalog + config overrides
- We can add a `getContextUsagePercent(session, model)` helper here

### 2.8 Pi Settings

**`src/agents/pi-settings.ts`** (~50 lines)

- `DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR` = 20000
- Compaction reserve configuration
- We add our new threshold config defaults here

### 2.9 Config Schema

**`src/config/zod-schema.ts`** and **`src/config/types.ts`**

- Zod validation for `openclaw.json`
- We add the new `compaction.rateLimitThreshold` field here

---

## 3. Implementation Plan — Step by Step

### Phase 1: Configuration Schema

**File: `src/config/zod-schema.ts`**

Add a new optional field to the compaction config schema:

```typescript
// Inside the compaction schema object
rateLimitCompactionThreshold: z.number().min(0).max(100).optional()
  .describe("Context usage % above which a rate limit triggers compaction before cooldown. 0 disables. Default: 60."),
```

**File: `src/config/types.ts`**

Add the corresponding type:

```typescript
interface CompactionConfig {
  mode?: "safeguard" | "aggressive" | "default";
  maxHistoryShare?: number;
  reserveTokensFloor?: number;
  rateLimitCompactionThreshold?: number; // NEW
}
```

**File: `src/config/defaults.ts`**

Set the default value in `applyCompactionDefaults()`:

```typescript
compaction: {
  ...compaction,
  mode: "safeguard",
  rateLimitCompactionThreshold: compaction.rateLimitCompactionThreshold ?? 60,
},
```

**User-facing config example:**

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "mode": "safeguard",
        "rateLimitCompactionThreshold": 60
      }
    }
  }
}
```

---

### Phase 2: Context Usage Helper

**File: `src/agents/context-window-guard.ts`**

Add a function to compute context usage percentage:

```typescript
export function getContextUsagePercent(
  sessionEntry: { totalTokens?: number; contextTokens?: number },
  modelContextWindow: number,
  configContextTokens?: number,
): number {
  const effectiveWindow = configContextTokens ?? modelContextWindow;
  const used = sessionEntry.totalTokens ?? 0;
  if (effectiveWindow <= 0) return 0;
  return Math.round((used / effectiveWindow) * 100);
}
```

This is intentionally simple — it mirrors the `contextPercent` calculation already done in `agent-runner-execution.ts` but makes it reusable.

---

### Phase 3: Rate-Limit-Aware Compaction in the Run Loop

This is the core change. We modify `runEmbeddedPiAgent()` in `src/agents/pi-embedded-runner/run.ts`.

**Current flow (simplified):**

```
try {
  result = await runEmbeddedAttempt(...)
} catch (error) {
  if (isContextOverflowError(error) && !overflowCompactionAttempted) {
    await compactEmbeddedPiSessionDirect(...)
    overflowCompactionAttempted = true
    // retry
  }
  if (isOverloadedErrorMessage(error) && !overflowCompactionAttempted) {
    await compactEmbeddedPiSessionDirect(...)
    overflowCompactionAttempted = true
    // retry
  }
  // rate limit → throw FailoverError (goes to cooldown)
}
```

**Proposed flow:**

```
try {
  result = await runEmbeddedAttempt(...)
} catch (error) {
  // EXISTING: context overflow → compact → retry
  if (isContextOverflowError(error) && !overflowCompactionAttempted) {
    await compactEmbeddedPiSessionDirect(...)
    overflowCompactionAttempted = true
    // retry
  }

  // EXISTING: overloaded → compact → retry
  if (isOverloadedErrorMessage(error) && !overflowCompactionAttempted) {
    await compactEmbeddedPiSessionDirect(...)
    overflowCompactionAttempted = true
    // retry
  }

  // NEW: rate limit + high context → compact before cooldown
  if (isRateLimitErrorMessage(errorText) && !rateLimitCompactionAttempted) {
    const threshold = config.agents?.defaults?.compaction?.rateLimitCompactionThreshold ?? 60;
    if (threshold > 0) {
      const contextPercent = getContextUsagePercent(sessionEntry, modelContextWindow, configContextTokens);
      if (contextPercent >= threshold) {
        log.info(
          `Rate limit hit with context at ${contextPercent}% (threshold: ${threshold}%). ` +
          `Compacting before cooldown for ${provider}/${modelId}`
        );
        try {
          await compactEmbeddedPiSessionDirect(compactionParams);
          rateLimitCompactionAttempted = true;
          log.info(`Compaction succeeded after rate limit; retrying`);
          continue; // retry the run loop
        } catch (compactErr) {
          log.warn(`Compaction after rate limit failed: ${compactErr}`);
          // fall through to normal failover
        }
      }
    }
  }

  // EXISTING: rate limit → throw FailoverError
  throw new FailoverError(...)
}
```

**Key details:**

- Add a new boolean guard: `let rateLimitCompactionAttempted = false;` (separate from `overflowCompactionAttempted` so both paths can fire independently)
- Only compact if `contextPercent >= threshold` — if context is small, the rate limit is just a genuine throughput issue and compaction won't help
- If compaction succeeds, retry once; if it fails, fall through to normal failover
- The retry uses the now-compacted (smaller) context, reducing TPM usage on the next attempt

---

### Phase 4: Heartbeat-Specific Handling

**File: `src/auto-reply/reply/agent-runner.ts`**

The heartbeat path goes through `runReplyAgent()`. When a heartbeat triggers rate limit compaction, we want to be especially aggressive because heartbeats are background tasks that shouldn't consume the user's rate limit budget.

In the heartbeat error handling section (around the `isHeartbeat` branch):

```typescript
// When heartbeat hits rate limit after compaction attempt,
// skip the retry entirely — don't burn more rate limit on background work.
if (isHeartbeat && meta?.error?.kind === "rate_limit") {
  log.info("Heartbeat suppressed due to rate limit; will retry next interval");
  return { text: "HEARTBEAT_OK", isStatic: true };
}
```

This prevents the heartbeat → rate limit → retry → rate limit → extended cooldown spiral.

---

### Phase 5: Logging and Observability

**File: `src/agents/pi-embedded-runner/run.ts`**

Add structured log entries so users can see the feature working:

```typescript
log.info(
  {
    event: "rate_limit_compaction",
    contextPercent,
    threshold,
    provider,
    model: modelId,
    sessionKey: params.sessionKey,
    tokensBeforeCompact: sessionEntry.totalTokens,
  },
  "Attempting compaction on rate limit",
);

// After compaction:
log.info(
  {
    event: "rate_limit_compaction_complete",
    tokensAfter: compactionResult.tokensAfter,
    tokensSaved: (sessionEntry.totalTokens ?? 0) - (compactionResult.tokensAfter ?? 0),
  },
  "Compaction complete, retrying request",
);
```

These show up in `openclaw logs --follow` so the user can verify the feature is firing.

---

### Phase 6: Tests

**New file: `src/agents/pi-embedded-runner/run.rate-limit-compaction.test.ts`**

Test cases (Vitest, matching existing test patterns):

1. **Rate limit + high context → compacts and retries**
   - Mock: `runEmbeddedAttempt` returns 429, `sessionEntry.totalTokens` = 150k, `contextTokens` = 200k (75%)
   - Assert: `compactEmbeddedPiSessionDirect` called once, attempt retried, second attempt succeeds

2. **Rate limit + low context → normal failover (no compaction)**
   - Mock: 429 error, `totalTokens` = 30k, `contextTokens` = 200k (15%)
   - Assert: compaction NOT called, FailoverError thrown

3. **Rate limit + high context + compaction fails → falls through to failover**
   - Mock: 429, high context, compaction throws
   - Assert: FailoverError still thrown

4. **Rate limit compaction only fires once per run**
   - Mock: 429 twice, high context
   - Assert: compaction called once (guard prevents second), second 429 goes to failover

5. **Threshold = 0 disables feature**
   - Config: `rateLimitCompactionThreshold: 0`
   - Mock: 429, high context
   - Assert: compaction NOT called

6. **Heartbeat suppressed after rate limit**
   - Mock: heartbeat run, 429 error
   - Assert: returns static HEARTBEAT_OK, no retry

**Existing test file to update: `src/agents/pi-embedded-runner/run.overflow-compaction.test.ts`**

- Ensure existing overflow compaction tests still pass
- Verify that `overflowCompactionAttempted` and `rateLimitCompactionAttempted` are independent guards

---

## 4. File Change Summary

| File                                                              | Change Type       | Description                                             |
| ----------------------------------------------------------------- | ----------------- | ------------------------------------------------------- |
| `src/config/zod-schema.ts`                                        | Modify            | Add `rateLimitCompactionThreshold` to compaction schema |
| `src/config/types.ts`                                             | Modify            | Add field to CompactionConfig type                      |
| `src/config/defaults.ts`                                          | Modify            | Set default value (60) in applyCompactionDefaults       |
| `src/agents/context-window-guard.ts`                              | Modify            | Add `getContextUsagePercent()` helper                   |
| `src/agents/pi-embedded-runner/run.ts`                            | **Modify (core)** | Add rate-limit compaction branch in error handler       |
| `src/auto-reply/reply/agent-runner.ts`                            | Modify            | Add heartbeat suppression on rate limit                 |
| `src/agents/pi-embedded-runner/run.rate-limit-compaction.test.ts` | **New**           | Test suite for the new feature                          |
| `src/agents/pi-embedded-runner/run.overflow-compaction.test.ts`   | Modify            | Verify guard independence                               |
| `docs/concepts/compaction.md`                                     | Modify            | Document the new config option                          |
| `docs/concepts/model-failover.md`                                 | Modify            | Note that rate limits can trigger compaction            |

---

## 5. Interaction with Existing Features

### 5.1 Existing Overflow Compaction

The new rate limit compaction uses a **separate guard** (`rateLimitCompactionAttempted`) from the existing overflow guard (`overflowCompactionAttempted`). This means:

- If overflow fires first and compacts, a subsequent rate limit won't compact again (context is already small)
- If rate limit fires first and compacts, a subsequent overflow won't be blocked (different guard)
- In practice, only one will ever fire per run — rate limit fires before overflow because the request never reaches the model

### 5.2 Failover Chain

Compaction happens **before** failover. If compaction + retry succeeds, the agent stays on the primary model. If it fails, the normal failover chain (Sonnet → Haiku) kicks in as usual. The user gets the best of both worlds: smaller context on the preferred model, with fallbacks as safety net.

### 5.3 Profile Rotation

Profile rotation (switching between multiple API keys for the same provider) still takes priority for auth-level failures. The compaction check only fires for genuine rate-limit 429s, not auth failures.

### 5.4 The FailoverError Misclassification Bug (#10368)

Issue #10368 documents that rate limit errors sometimes get misreported as context overflow. Our change actually helps here: if the error is really a rate limit but gets misclassified as overflow, the existing overflow compaction handles it. If it's correctly classified as a rate limit, our new branch handles it. Either way, compaction happens.

---

## 6. Rollout Strategy

1. **Default on, conservative threshold (60%)** — most users benefit without config changes
2. **Set to 0 to disable** — users who don't want this behavior can opt out
3. **Log clearly** — every compaction attempt logs context percentage, threshold, and outcome so users can tune
4. **Ship behind config first** — if there are concerns about stability, start with threshold default of 0 (disabled) and let users opt in, then flip the default in a subsequent release

---

---

# Feature 2: Stateless `/` Prefix Queries

## 8. Problem Summary

Every message sent to OpenClaw includes the full session context: system prompt, tool schemas, workspace files, conversation history, and memory search results. For simple one-off questions ("what's the weather?", "convert 5kg to lbs", "what time is it in Tokyo?"), this is massively wasteful. It burns tokens, increases latency, and — critically — can fail entirely when the session is already near overflow.

Users need an escape hatch: a way to ask a quick question that bypasses the session entirely.

**Proposed syntax:** Messages starting with `/ask` (or a configurable prefix) are routed to the model with zero conversation history.

```
/ask what is the capital of France
→ Sent with: system prompt + "what is the capital of France"
→ No history, no tool results, no workspace files, no memory injection
→ Response is NOT appended to session history
```

This is analogous to how OpenClaw's isolated cron jobs work — they mint a fresh session ID per run with no inherited context. We apply the same pattern to user-initiated messages.

---

## 9. Codebase Map — Stateless Query Path

### 9.1 Command Registry

**`src/auto-reply/commands-registry.data.ts`** (~163 lines)

- Defines all built-in slash commands (`/status`, `/compact`, `/new`, etc.)
- Each command has: `name`, `aliases`, `description`, `handler`, `category`
- We register `/ask` here as a new command

**`src/auto-reply/commands-registry.ts`** (~366 lines)

- `buildChatCommands()` — builds the command registry at startup
- Command parsing: detects `/` prefix, matches against registry
- Handles the `commandBody` vs `body` separation
- Currently, unrecognized `/` commands are passed through as regular messages to the model

### 9.2 Command Handling

**`src/auto-reply/reply/commands-core.ts`** (~75 lines)

- `handleCommands()` — the main command dispatcher
- Returns early for known commands, falls through for unknown ones
- We add the `/ask` handler here

**`src/auto-reply/reply/commands-session.ts`** (~287+ lines)

- Session-related command handlers (`/new`, `/compact`, `/stop`, etc.)
- We add the stateless query handler alongside these

### 9.3 Message Flow

**`src/auto-reply/reply/agent-runner-execution.ts`**

- Where messages are dispatched to the embedded Pi agent
- Passes `sessionKey`, `sessionId`, context, etc.
- For stateless queries, we bypass this and call the model directly with minimal context

### 9.4 Session Management

**`src/agents/pi-embedded-runner/run/attempt.ts`** (~860+ lines)

- `runEmbeddedAttempt()` — assembles the full context payload
- Loads bootstrap files, history, tools
- For stateless queries, we need a stripped-down version of this

### 9.5 System Prompt

**`src/agents/pi-embedded-runner/system-prompt.ts`**

- `buildEmbeddedSystemPrompt()` — constructs the system prompt
- Has a `promptMode: "minimal"` option (used for subagents/compaction)
- We reuse this minimal mode for stateless queries

---

## 10. Implementation Plan — Stateless Queries

### Phase 1: Register the `/ask` Command

**File: `src/auto-reply/commands-registry.data.ts`**

Add a new command entry:

```typescript
{
  name: "ask",
  aliases: ["q", "quick"],
  description: "Send a message without session context (stateless query)",
  category: "session",
  args: "<message>",
  requiresArg: true,
  handler: "statelessQuery",
  // Not a "fast path" command — needs model invocation
  fastPath: false,
}
```

**Aliases:** `/ask`, `/q`, `/quick` — all do the same thing. `/q` is nice for quick mobile typing.

### Phase 2: Configuration

**File: `src/config/zod-schema.ts`**

Add config options:

```typescript
// Inside commands schema
statelessQuery: z.object({
  enabled: z.boolean().optional().describe("Enable /ask command. Default: true."),
  prefix: z.string().optional().describe("Custom prefix instead of /ask. Default: 'ask'."),
  includeSystemPrompt: z.boolean().optional()
    .describe("Include full system prompt in stateless queries. Default: true (minimal mode)."),
  includeTools: z.boolean().optional()
    .describe("Include tool definitions in stateless queries. Default: false."),
  appendToHistory: z.boolean().optional()
    .describe("Append stateless Q&A to session history. Default: false."),
  model: z.string().optional()
    .describe("Override model for stateless queries. Default: use primary model."),
}).optional(),
```

**User-facing config:**

```json
{
  "commands": {
    "statelessQuery": {
      "enabled": true,
      "includeTools": false,
      "appendToHistory": false,
      "model": "anthropic/claude-haiku-4-5"
    }
  }
}
```

Using Haiku for stateless queries is a great default — it's fast, cheap, and perfect for simple questions.

### Phase 3: Stateless Query Handler

**New file: `src/auto-reply/reply/commands-stateless.ts`**

```typescript
import { buildEmbeddedSystemPrompt } from "../../agents/pi-embedded-runner/system-prompt.js";

export async function handleStatelessQuery(params: {
  queryText: string;
  config: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  // ... auth, model resolution params
}): Promise<{ text: string; tokensUsed: number }> {
  const { queryText, config } = params;
  const statelessConfig = config.commands?.statelessQuery ?? {};

  // 1. Resolve model — use override or primary
  const model =
    statelessConfig.model ??
    config.agents?.defaults?.model?.primary ??
    "anthropic/claude-sonnet-4-5";

  // 2. Build minimal system prompt (no workspace files, no memory)
  const systemPrompt =
    statelessConfig.includeSystemPrompt !== false
      ? await buildEmbeddedSystemPrompt({
          ...params,
          promptMode: "minimal",
          skipWorkspaceFiles: true,
          skipMemorySearch: true,
        })
      : "You are a helpful assistant. Answer concisely.";

  // 3. Build message array — just the system prompt + user message
  const messages = [{ role: "user", content: queryText }];

  // 4. Build tool list (empty by default for stateless)
  const tools = statelessConfig.includeTools ? await resolveTools(params) : [];

  // 5. Call model directly via provider SDK
  const response = await callModel({
    model,
    systemPrompt,
    messages,
    tools,
    auth: params.auth,
    // No history, no caching, no session tracking
  });

  // 6. Optionally append to session history
  if (statelessConfig.appendToHistory) {
    await appendToSessionTranscript(params.sessionKey, params.sessionId, [
      { role: "user", content: `[stateless] ${queryText}` },
      { role: "assistant", content: response.text },
    ]);
  }

  return {
    text: response.text,
    tokensUsed: response.usage?.totalTokens ?? 0,
  };
}
```

**Key design decisions:**

- **`promptMode: "minimal"`** — reuses the existing minimal system prompt that compaction and subagents use. This keeps the agent's core identity but strips workspace files and memory.
- **`skipWorkspaceFiles: true`** — no AGENTS.md, SOUL.md, MEMORY.md, TOOLS.md injection. These are the biggest token hogs.
- **`skipMemorySearch: true`** — no vector/BM25 search against memory files.
- **No tools by default** — the model can't execute bash, browse, read files, etc. Just answer the question. (Configurable if users want tools.)
- **No history append by default** — the Q&A doesn't pollute the main session, keeping context lean.

### Phase 4: Wire Into Command Dispatch

**File: `src/auto-reply/reply/commands-core.ts`**

In `handleCommands()`, add the dispatch:

```typescript
// After existing command matching...
if (commandName === "ask" || commandName === "q" || commandName === "quick") {
  if (!commandArg) {
    return { text: "Usage: /ask <your question>", handled: true };
  }

  const statelessConfig = config.commands?.statelessQuery;
  if (statelessConfig?.enabled === false) {
    return { text: "/ask is disabled in config.", handled: true };
  }

  const result = await handleStatelessQuery({
    queryText: commandArg,
    config,
    agentId,
    sessionKey,
    sessionId,
    auth: resolvedAuth,
  });

  return {
    text: result.text,
    handled: true,
    // Mark as stateless so delivery layer knows
    meta: { stateless: true, tokensUsed: result.tokensUsed },
  };
}
```

### Phase 5: Delivery Formatting

When delivering the response, optionally prefix it so the user knows it was a stateless query:

```
💬 [stateless] France's capital is Paris.
```

This is configurable — some users will want the prefix, others won't. Add to config:

```typescript
statelessQuery: {
  responsePrefix: "💬 ", // or "" to disable
}
```

### Phase 6: Tests

**New file: `src/auto-reply/reply/commands-stateless.test.ts`**

Test cases:

1. **`/ask` sends query without history** — mock model call, verify messages array has only the user message (no history)
2. **`/ask` uses minimal system prompt** — verify `promptMode: "minimal"` and no workspace files
3. **`/ask` does not append to session by default** — verify transcript unchanged after query
4. **`/ask` appends when configured** — set `appendToHistory: true`, verify transcript updated
5. **`/ask` uses override model** — set `model: "anthropic/claude-haiku-4-5"`, verify correct model called
6. **`/ask` with no argument returns usage** — verify error message
7. **`/ask` disabled in config** — set `enabled: false`, verify rejection message
8. **`/q` alias works** — verify alias routing
9. **`/ask` works when main session is overflowed** — the whole point: mock an overflowed session, verify `/ask` still succeeds because it doesn't load history

---

## 11. File Change Summary (Feature 2)

| File                                              | Change Type | Description                                          |
| ------------------------------------------------- | ----------- | ---------------------------------------------------- |
| `src/auto-reply/commands-registry.data.ts`        | Modify      | Register `/ask`, `/q`, `/quick` commands             |
| `src/config/zod-schema.ts`                        | Modify      | Add `commands.statelessQuery` config schema          |
| `src/config/types.ts`                             | Modify      | Add StatelessQueryConfig type                        |
| `src/config/defaults.ts`                          | Modify      | Set defaults (enabled: true, appendToHistory: false) |
| `src/auto-reply/reply/commands-core.ts`           | Modify      | Add dispatch for `/ask` command                      |
| `src/auto-reply/reply/commands-stateless.ts`      | **New**     | Stateless query handler                              |
| `src/auto-reply/reply/commands-stateless.test.ts` | **New**     | Test suite                                           |
| `docs/tools/slash-commands.md`                    | Modify      | Document `/ask` command                              |

---

## 12. Interaction Between Features 1 and 2

The two features complement each other beautifully:

- **Feature 1 (rate limit compaction)** is reactive — it fires when things go wrong and tries to recover.
- **Feature 2 (stateless `/ask`)** is preventive — it gives users a way to avoid hitting the problem entirely.

When a session is bloated and the provider is in cooldown, `/ask` still works because it doesn't load the bloated history. It's the "break glass" escape hatch. The user can keep getting answers while the main session recovers.

The features don't conflict in the code — Feature 1 lives in the embedded runner error handler, Feature 2 lives in the command dispatcher. They touch different code paths entirely.

---

## 13. Combined File Change Summary (Both Features)

| File                                                              | Feature | Change Type       | Description                                           |
| ----------------------------------------------------------------- | ------- | ----------------- | ----------------------------------------------------- |
| `src/config/zod-schema.ts`                                        | Both    | Modify            | Add `rateLimitCompactionThreshold` + `statelessQuery` |
| `src/config/types.ts`                                             | Both    | Modify            | Add types for both features                           |
| `src/config/defaults.ts`                                          | Both    | Modify            | Set defaults for both features                        |
| `src/agents/context-window-guard.ts`                              | F1      | Modify            | Add `getContextUsagePercent()` helper                 |
| `src/agents/pi-embedded-runner/run.ts`                            | F1      | **Modify (core)** | Rate-limit compaction branch                          |
| `src/auto-reply/reply/agent-runner.ts`                            | F1      | Modify            | Heartbeat suppression on rate limit                   |
| `src/agents/pi-embedded-runner/run.rate-limit-compaction.test.ts` | F1      | **New**           | Tests for rate limit compaction                       |
| `src/agents/pi-embedded-runner/run.overflow-compaction.test.ts`   | F1      | Modify            | Verify guard independence                             |
| `src/auto-reply/commands-registry.data.ts`                        | F2      | Modify            | Register `/ask` command                               |
| `src/auto-reply/reply/commands-core.ts`                           | F2      | Modify            | Dispatch `/ask`                                       |
| `src/auto-reply/reply/commands-stateless.ts`                      | F2      | **New**           | Stateless query handler                               |
| `src/auto-reply/reply/commands-stateless.test.ts`                 | F2      | **New**           | Tests for stateless queries                           |
| `docs/concepts/compaction.md`                                     | F1      | Modify            | Document rate limit threshold                         |
| `docs/concepts/model-failover.md`                                 | F1      | Modify            | Note compaction on rate limit                         |
| `docs/tools/slash-commands.md`                                    | F2      | Modify            | Document `/ask` command                               |

**Total: 15 files touched (4 new, 11 modified)**

---

## 14. Future Enhancements (Out of Scope for This PR)

- **Per-model cooldown tracking** (Issue #5744) — rate limit one Google model without cooling down all Google models
- **Proactive compaction at 80%** (Issue #10719) — compact before any error occurs
- **Proper exponential backoff** (Issue #5159) — fix the broken retry timing
- **Context percentage in Runtime line** (Issue #2597) — let the AI agent see its own context usage
- **Background compaction daemon** — systemd timer that compacts sessions on a schedule
- **`/ask` with tool access** — a middle ground where stateless queries can still use specific tools (e.g. web search)
- **`/ask` auto-routing** — automatically route simple queries (detected by heuristics) through the stateless path without requiring the prefix
- **Stateless query cost tracking** — separate `/usage` category for stateless queries so users can see the savings
