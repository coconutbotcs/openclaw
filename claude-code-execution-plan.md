# Claude Code Execution Plan: Stacked PRs for OpenClaw

## How to Use This Document

This is your step-by-step playbook for Claude Code. Each section is one PR on a stacked branch. Copy-paste the **Claude Code prompt** blocks directly into your terminal. The prompts reference the implementation plan (`rate-limit-compaction-plan.md`) — keep it in your repo root so Claude Code can read it.

---

## Setup

```bash
# Clone and prep
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install

# Create your feature branch base
git checkout -b feat/rate-limit-compaction-base main

# Copy your plan into the repo so Claude Code can reference it
cp ~/rate-limit-compaction-plan.md ./IMPLEMENTATION_PLAN.md
```

Create a `CLAUDE.md` in the repo root so Claude Code understands the project:

```markdown
# Project Context

This is the OpenClaw repo — a TypeScript AI assistant platform.
Key conventions:

- TypeScript strict mode, Vitest for tests
- Source in src/, docs in docs/
- Config schema: src/config/zod-schema.ts, types: src/config/types.ts
- Agent runtime: src/agents/pi-embedded-runner/
- Command handling: src/auto-reply/reply/commands-\*.ts
- Command registry: src/auto-reply/commands-registry.data.ts
- Test files live next to source with .test.ts suffix
- Follow existing code style exactly — match imports, naming, spacing
- Run `npm test -- --run <testfile>` to validate individual test files
- Run `npm run lint` before committing

See IMPLEMENTATION_PLAN.md for the full feature specification.
```

---

## Branch Stack Overview

```
main
 └── feat/context-usage-helper           PR #1 — Pure utility, no behavior change
      └── feat/rate-limit-compaction-config  PR #2 — Config schema only
           └── feat/rate-limit-compaction     PR #3 — Core logic + tests
                └── feat/heartbeat-suppression PR #4 — Small targeted fix
                     └── feat/stateless-query-config  PR #5 — Config schema only
                          └── feat/stateless-query     PR #6 — Core logic + tests
                               └── feat/docs-update    PR #7 — Docs only
```

Each PR is independently reviewable. PRs 1-2 are pure plumbing with no behavior change. PR 3 is the meaty one. PRs 5-6 are the second feature. PR 7 is docs.

---

## PR #1: Context Usage Helper

**Branch:** `feat/context-usage-helper`
**Files:** `src/agents/context-window-guard.ts`, `src/agents/context-window-guard.test.ts`
**Risk:** None — pure addition, no existing code modified
**Reviewability:** Tiny, self-contained

```bash
git checkout -b feat/context-usage-helper feat/rate-limit-compaction-base
```

### Claude Code Prompt

```
Read IMPLEMENTATION_PLAN.md, specifically Phase 2 (section 3, "Context Usage Helper").

Add a new exported function `getContextUsagePercent` to src/agents/context-window-guard.ts.

The function should:
- Accept sessionEntry (with optional totalTokens and contextTokens), modelContextWindow (number), and optional configContextTokens
- Return a number 0-100 representing context usage percentage
- Use configContextTokens if provided, otherwise modelContextWindow
- Return 0 if the effective window is <= 0
- Round the result to the nearest integer

Then create a test file src/agents/context-window-guard.test.ts (or add to the existing one if it exists) with Vitest tests covering:
1. Normal usage calculation (e.g. 80k used / 200k window = 40%)
2. configContextTokens overrides modelContextWindow
3. Zero window returns 0
4. Missing totalTokens returns 0
5. Edge case: exactly 100%

Follow the existing code style in context-window-guard.ts exactly. Look at other .test.ts files in src/agents/ for the test pattern.

Run the tests to make sure they pass.
```

```bash
git add -A && git commit -m "feat: add getContextUsagePercent helper to context-window-guard

Adds a reusable utility function that calculates context window usage
as a percentage. Will be used by rate-limit-aware compaction (next PR)
but is independently useful for monitoring and diagnostics.

No behavior changes to existing code."
```

---

## PR #2: Rate Limit Compaction — Config Schema

**Branch:** `feat/rate-limit-compaction-config`
**Files:** `src/config/zod-schema.ts`, `src/config/types.ts`, `src/config/defaults.ts`
**Risk:** None — additive schema change, backwards compatible
**Reviewability:** Small, focused on config

```bash
git checkout -b feat/rate-limit-compaction-config feat/context-usage-helper
```

### Claude Code Prompt

```
Read IMPLEMENTATION_PLAN.md, specifically Phase 1 (section 3, "Configuration Schema").

Add a new optional field `rateLimitCompactionThreshold` to the compaction config:

1. In src/config/zod-schema.ts: Add `rateLimitCompactionThreshold: z.number().min(0).max(100).optional()` to the compaction schema object. Add a .describe() with: "Context usage % above which a rate limit triggers compaction before cooldown. 0 disables. Default: 60."

2. In src/config/types.ts: Add `rateLimitCompactionThreshold?: number` to the CompactionConfig interface (or whatever the compaction type is called — check the file).

3. In src/config/defaults.ts: In the function that applies compaction defaults (likely applyCompactionDefaults), set the default: `rateLimitCompactionThreshold: compaction.rateLimitCompactionThreshold ?? 60`

Important: Look at how existing compaction fields (like maxHistoryShare, reserveTokensFloor) are defined in each of these three files and follow the exact same pattern.

Run lint and any config-related tests to verify nothing breaks.
```

```bash
git add -A && git commit -m "feat(config): add rateLimitCompactionThreshold to compaction schema

New optional config field under agents.defaults.compaction that controls
when rate limit errors trigger pre-emptive compaction. Default: 60 (%).
Set to 0 to disable.

Backwards compatible — existing configs work unchanged."
```

---

## PR #3: Rate Limit Compaction — Core Logic + Tests

**Branch:** `feat/rate-limit-compaction`
**Files:** `src/agents/pi-embedded-runner/run.ts`, `src/agents/pi-embedded-runner/run.rate-limit-compaction.test.ts`
**Risk:** Medium — modifies the main error handler loop
**Reviewability:** This is the core PR. Reviewers should focus on the error handler changes in run.ts

```bash
git checkout -b feat/rate-limit-compaction feat/rate-limit-compaction-config
```

### Claude Code Prompt

```
Read IMPLEMENTATION_PLAN.md thoroughly — sections 1 through 6 (the entire "Feature 1" spec).

This is the core change. Modify src/agents/pi-embedded-runner/run.ts to add rate-limit-aware compaction.

First, study the existing error handling in runEmbeddedPiAgent(). There is already:
- A context overflow detection branch that calls compactEmbeddedPiSessionDirect() and retries
- An overloaded/503 detection branch (PR #5464) that does the same
- A boolean guard `overflowCompactionAttempted` that prevents repeated compaction

You need to add a NEW branch that:
1. Fires when isRateLimitErrorMessage(errorText) is true
2. Uses a SEPARATE guard: `let rateLimitCompactionAttempted = false` (do NOT reuse overflowCompactionAttempted)
3. Reads the threshold from config: `config.agents?.defaults?.compaction?.rateLimitCompactionThreshold ?? 60`
4. If threshold > 0, calculates context usage % using getContextUsagePercent (import from context-window-guard.ts)
5. If contextPercent >= threshold, attempts compactEmbeddedPiSessionDirect() with the same params the overflow branch uses
6. On success: sets rateLimitCompactionAttempted = true, logs clearly, and continues the loop (retry)
7. On failure: logs warning and falls through to normal failover (throw FailoverError)
8. If contextPercent < threshold: falls through to normal failover (context is small, compaction won't help)

Important details:
- Place this branch AFTER the existing overflow and overloaded branches but BEFORE the FailoverError throw
- Import getContextUsagePercent from the context-window-guard module
- You'll need to get the session entry and context window info — look at how the existing overflow branch accesses these
- Use structured logging matching the existing log patterns (log.info with object + message string)
- The log should include: event name, contextPercent, threshold, provider, modelId, sessionKey, tokensBefore

Then create src/agents/pi-embedded-runner/run.rate-limit-compaction.test.ts with Vitest tests.
Look at run.overflow-compaction.test.ts for the exact test patterns and mocking approach — your tests should mirror that structure.

Test cases:
1. Rate limit + high context (75%) → compaction called, retry succeeds
2. Rate limit + low context (15%) → compaction NOT called, FailoverError thrown
3. Rate limit + high context + compaction fails → FailoverError thrown
4. Guard fires only once: two rate limits → compaction called once, second goes to failover
5. Threshold = 0 → compaction NOT called regardless of context
6. Verify overflowCompactionAttempted and rateLimitCompactionAttempted are independent

Run ALL existing tests in src/agents/pi-embedded-runner/ to make sure nothing is broken, plus your new tests.
```

```bash
git add -A && git commit -m "feat: compact session on rate limit when context is high

When a 429 rate limit error occurs and session context usage exceeds
the configured threshold (default 60%), trigger auto-compaction before
entering provider cooldown. This reduces the payload for the retry
attempt, breaking the overflow → rate limit → cooldown cascade.

The compaction uses a separate guard from the existing overflow
compaction path, so both can fire independently within the same run.

If compaction succeeds, the request is retried with the smaller context.
If it fails, normal failover behavior continues unchanged.

Configurable via agents.defaults.compaction.rateLimitCompactionThreshold
(0 to disable, default 60).

Refs: #8226, #5159, #8596"
```

---

## PR #4: Heartbeat Rate Limit Suppression

**Branch:** `feat/heartbeat-suppression`
**Files:** `src/auto-reply/reply/agent-runner.ts`, test file
**Risk:** Low — small targeted change in heartbeat path
**Reviewability:** Very small, easy to review

```bash
git checkout -b feat/heartbeat-suppression feat/rate-limit-compaction
```

### Claude Code Prompt

```
Read IMPLEMENTATION_PLAN.md, specifically Phase 4 (section 3, "Heartbeat-Specific Handling").

In src/auto-reply/reply/agent-runner.ts, find the heartbeat error handling path in runReplyAgent().

Look for where isHeartbeat is checked in the error/result handling. Add logic so that:

When a heartbeat run results in a rate limit error (check meta.error.kind === "rate_limit" or however the error is classified — study the existing code), instead of retrying or propagating the error:
1. Log: "Heartbeat suppressed due to rate limit; will retry next interval"
2. Return a static response: { text: "HEARTBEAT_OK", isStatic: true } (or whatever pattern the existing heartbeat code uses for "nothing to report")

The goal: heartbeats should NOT burn rate limit budget on retries. If the provider is rate-limited, the heartbeat should silently succeed and try again at the next scheduled interval.

Look at the existing heartbeat handling code to understand the exact return types and patterns. Match them precisely.

Add a test case in the existing heartbeat test file (look for agent-runner.heartbeat-typing.*.test.ts) that verifies:
- Heartbeat + rate limit error → returns static HEARTBEAT_OK, no retry
- Non-heartbeat + rate limit error → normal behavior (unchanged)

Run the heartbeat tests to verify.
```

```bash
git add -A && git commit -m "fix: suppress heartbeat retries on rate limit

When a heartbeat run hits a rate limit, return HEARTBEAT_OK silently
instead of retrying. This prevents background heartbeats from consuming
rate limit budget and extending provider cooldown periods.

The heartbeat will naturally retry at its next scheduled interval."
```

---

## PR #5: Stateless Query — Config + Command Registration

**Branch:** `feat/stateless-query-config`
**Files:** `src/config/zod-schema.ts`, `src/config/types.ts`, `src/config/defaults.ts`, `src/auto-reply/commands-registry.data.ts`
**Risk:** None — additive config + command registration
**Reviewability:** Small, no behavior change

```bash
git checkout -b feat/stateless-query-config feat/heartbeat-suppression
```

### Claude Code Prompt

```
Read IMPLEMENTATION_PLAN.md, specifically sections 10 Phase 1 and Phase 2 (Stateless Query config and command registration).

Two things to do:

PART A — Config schema:

1. In src/config/zod-schema.ts: Add a `statelessQuery` optional object to the commands schema with these fields:
   - enabled: z.boolean().optional() — "Enable /ask command. Default: true."
   - includeSystemPrompt: z.boolean().optional() — "Include system prompt. Default: true (minimal mode)."
   - includeTools: z.boolean().optional() — "Include tool definitions. Default: false."
   - appendToHistory: z.boolean().optional() — "Append Q&A to session history. Default: false."
   - model: z.string().optional() — "Override model for stateless queries."
   - responsePrefix: z.string().optional() — "Prefix for stateless responses. Default: empty."

2. In src/config/types.ts: Add the corresponding StatelessQueryConfig interface and reference it from the commands config type.

3. In src/config/defaults.ts: Set defaults — enabled: true, includeTools: false, appendToHistory: false, includeSystemPrompt: true, responsePrefix: "".

PART B — Command registration:

In src/auto-reply/commands-registry.data.ts, add a new command entry for "ask" with:
- name: "ask"
- aliases: ["q", "quick"]
- description: "Send a message without session context (stateless query)"
- category: "session"
- args: "<message>"
- requiresArg: true

Study how other commands are registered in this file and follow the exact same structure. Pay attention to the handler field — look at how other commands reference their handlers.

Run lint and any config tests.
```

```bash
git add -A && git commit -m "feat(config): add statelessQuery config + register /ask command

Adds configuration schema for the new /ask (aliases: /q, /quick)
command that will send messages without session context.

Config options: enabled, includeTools, appendToHistory, model override,
response prefix. All with sensible defaults.

Command is registered but the handler is not yet implemented (next PR)."
```

---

## PR #6: Stateless Query — Handler Implementation + Tests

**Branch:** `feat/stateless-query`
**Files:** `src/auto-reply/reply/commands-stateless.ts` (new), `src/auto-reply/reply/commands-core.ts`, `src/auto-reply/reply/commands-stateless.test.ts` (new)
**Risk:** Medium — new command handler + wiring into dispatch
**Reviewability:** Self-contained new feature, easy to review in isolation

```bash
git checkout -b feat/stateless-query feat/stateless-query-config
```

### Claude Code Prompt

```
Read IMPLEMENTATION_PLAN.md, specifically sections 10 Phase 3, 4, 5, and 6 (Stateless Query implementation).

This PR implements the /ask command that sends messages to the model WITHOUT session context.

PART A — Create the handler:

Create a new file: src/auto-reply/reply/commands-stateless.ts

Study how existing command handlers work in commands-session.ts and commands-core.ts.
Study how buildEmbeddedSystemPrompt() works in src/agents/pi-embedded-runner/system-prompt.ts — look for a "minimal" promptMode or equivalent.
Study how the model is called — look at how runEmbeddedAttempt or similar functions make API calls.

The handler function handleStatelessQuery should:
1. Accept the query text, config, auth/model resolution params
2. Resolve the model — use config.commands.statelessQuery.model if set, otherwise primary model
3. Build a MINIMAL system prompt — reuse the existing minimal/subagent prompt mode if available, or construct a simple one. The key: NO workspace files (AGENTS.md, SOUL.md, MEMORY.md, etc), NO memory search injection
4. Build message array with ONLY the user's query (no conversation history)
5. Include tools only if config.includeTools is true (default false)
6. Call the model through whatever API abstraction the codebase uses (study existing patterns)
7. Optionally append Q&A to session transcript if config.appendToHistory is true
8. Return the response text

This MUST work even when the main session is overflowed — that's the whole point. It should not load or reference the session transcript at all.

PART B — Wire into command dispatch:

In src/auto-reply/reply/commands-core.ts, add handling for the "ask" / "q" / "quick" command names.
- If no argument provided, return usage message: "Usage: /ask <your question>"
- If statelessQuery.enabled is false, return disabled message
- Otherwise call handleStatelessQuery and return the result
- Set meta.stateless = true on the response

Study how other commands are dispatched in this file. Follow the exact same pattern.

PART C — Tests:

Create src/auto-reply/reply/commands-stateless.test.ts with Vitest tests:
1. /ask sends query without history — verify messages array is just the user message
2. /ask uses minimal system prompt — verify no workspace files loaded
3. /ask does NOT append to session by default
4. /ask appends when appendToHistory: true
5. /ask uses override model when configured
6. /ask with no argument returns usage message
7. /ask when disabled returns disabled message
8. /q alias routes to same handler
9. /ask works when main session is overflowed (mock overflow state, verify /ask still succeeds)

Look at existing command test files for the mocking patterns.

Run all tests in src/auto-reply/ to verify nothing breaks.
```

```bash
git add -A && git commit -m "feat: implement /ask command for stateless queries

New /ask (aliases: /q, /quick) command sends messages to the model
without session context — no conversation history, no workspace files,
no memory search, no tool definitions (by default).

This provides an escape hatch when the main session is overflowed or
the provider is in cooldown. Simple queries work regardless of session
state because they don't load the bloated context.

Configurable: model override, tool inclusion, history append, response
prefix. See docs/tools/slash-commands.md for usage.

Example:
  /ask what is the capital of France
  /q convert 5kg to lbs"
```

---

## PR #7: Documentation

**Branch:** `feat/docs-update`
**Files:** `docs/concepts/compaction.md`, `docs/concepts/model-failover.md`, `docs/tools/slash-commands.md`
**Risk:** None — docs only
**Reviewability:** Trivial

```bash
git checkout -b feat/docs-update feat/stateless-query
```

### Claude Code Prompt

```
Read IMPLEMENTATION_PLAN.md for the full context of both features.

Update the documentation for the two new features:

1. docs/concepts/compaction.md — Add a section explaining rate-limit-aware compaction:
   - What it does: when a 429 occurs and context is above threshold, compact before cooldown
   - Config: agents.defaults.compaction.rateLimitCompactionThreshold (default 60, 0 to disable)
   - How it interacts with existing overflow compaction (separate guards, independent)
   - Example config snippet

2. docs/concepts/model-failover.md — Add a note in the appropriate section:
   - Rate limits can now trigger compaction when context is high
   - This happens BEFORE failover, so the primary model gets a second chance with smaller context
   - If compaction + retry fails, normal failover proceeds as before

3. docs/tools/slash-commands.md — Add the /ask command:
   - Syntax: /ask <message> (aliases: /q, /quick)
   - Description: sends a message without session context
   - What's included: minimal system prompt only
   - What's excluded: conversation history, workspace files, memory, tools (by default)
   - Config options with examples
   - Use case: quick questions, emergency queries when session is overflowed

Match the existing documentation style, formatting, and heading conventions in each file.
```

```bash
git add -A && git commit -m "docs: document rate-limit compaction and /ask command

- compaction.md: rate-limit-aware compaction config and behavior
- model-failover.md: note on compaction before failover
- slash-commands.md: /ask (/q, /quick) command reference"
```

---

## Pushing the Stack

```bash
# Push all branches
git push origin \
  feat/context-usage-helper \
  feat/rate-limit-compaction-config \
  feat/rate-limit-compaction \
  feat/heartbeat-suppression \
  feat/stateless-query-config \
  feat/stateless-query \
  feat/docs-update
```

### Create PRs (stacked)

Create each PR targeting the previous branch:

| PR  | Branch                              | Target                              | Title                                                      |
| --- | ----------------------------------- | ----------------------------------- | ---------------------------------------------------------- |
| #1  | `feat/context-usage-helper`         | `main`                              | `feat: add getContextUsagePercent helper`                  |
| #2  | `feat/rate-limit-compaction-config` | `feat/context-usage-helper`         | `feat(config): add rateLimitCompactionThreshold`           |
| #3  | `feat/rate-limit-compaction`        | `feat/rate-limit-compaction-config` | `feat: compact session on rate limit when context is high` |
| #4  | `feat/heartbeat-suppression`        | `feat/rate-limit-compaction`        | `fix: suppress heartbeat retries on rate limit`            |
| #5  | `feat/stateless-query-config`       | `feat/heartbeat-suppression`        | `feat(config): add statelessQuery config + register /ask`  |
| #6  | `feat/stateless-query`              | `feat/stateless-query-config`       | `feat: implement /ask command for stateless queries`       |
| #7  | `feat/docs-update`                  | `feat/stateless-query`              | `docs: document rate-limit compaction and /ask command`    |

Each PR description should link to the next one: "Part X of 7. Next: #NNN"

---

## Rebasing Tips

When reviewers request changes on an early PR:

```bash
# Fix on the target branch
git checkout feat/context-usage-helper
# ... make fixes, amend commit ...

# Rebase the stack forward
git checkout feat/rate-limit-compaction-config && git rebase feat/context-usage-helper
git checkout feat/rate-limit-compaction && git rebase feat/rate-limit-compaction-config
git checkout feat/heartbeat-suppression && git rebase feat/rate-limit-compaction
git checkout feat/stateless-query-config && git rebase feat/heartbeat-suppression
git checkout feat/stateless-query && git rebase feat/stateless-query-config
git checkout feat/docs-update && git rebase feat/stateless-query

# Force-push the updated stack
git push --force-with-lease origin \
  feat/context-usage-helper \
  feat/rate-limit-compaction-config \
  feat/rate-limit-compaction \
  feat/heartbeat-suppression \
  feat/stateless-query-config \
  feat/stateless-query \
  feat/docs-update
```

Or use a stacked PR tool:

```bash
# If you have graphite, spr, or ghstack:
npx graphite submit  # handles the whole stack
```

---

## Testing the Full Stack Locally

Before pushing, verify the entire stack works:

```bash
# On the final branch (has all changes)
git checkout feat/docs-update

# Run the full test suite
npm test

# Run just the new/modified tests
npm test -- --run src/agents/context-window-guard.test.ts
npm test -- --run src/agents/pi-embedded-runner/run.rate-limit-compaction.test.ts
npm test -- --run src/auto-reply/reply/commands-stateless.test.ts

# Lint
npm run lint

# Build
npm run build
```

---

## Claude Code Session Tips

1. **Start each PR in a fresh Claude Code session** — avoids context bleed between branches
2. **Use plan mode first on PR #3 and #6** — these are the complex ones:
   ```
   /plan Read IMPLEMENTATION_PLAN.md and study the existing error handling in
   src/agents/pi-embedded-runner/run.ts. Map out exactly where the new rate
   limit compaction branch should go and what variables/imports are needed.
   ```
   Then send the full prompt with `&` to execute on the web if you want parallel work.
3. **Run tests after each PR** — don't stack broken code
4. **Use `/compact` in Claude Code if sessions get long** — practice what you preach
5. **Keep IMPLEMENTATION_PLAN.md in the repo** — Claude Code reads it for context, but remove it before opening PRs (or .gitignore it)
