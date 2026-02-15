import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { CommandHandler } from "./commands-types.js";
import { parseModelRef } from "../../agents/model-selection.js";
import { sanitizeUserFacingText } from "../../agents/pi-embedded-helpers.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { logVerbose } from "../../globals.js";

/**
 * Handler for `/ask` (and aliases `/q`, `/quick`).
 *
 * Sends the query to the model **without** session context — no history,
 * no workspace files, no memory injection.  The response is returned
 * directly and is **not** appended to the session transcript.
 */
export const handleStatelessQueryCommand: CommandHandler = async (params) => {
  const body = params.command.commandBodyNormalized;
  const match = body.match(/^\/(ask|q|quick)(?:\s+|$)/);
  if (!match) {
    return null;
  }

  const queryText = body.slice(match[0].length).trim();
  if (!queryText) {
    return {
      shouldContinue: false,
      reply: { text: "Usage: /ask <message>" },
    };
  }

  const statelessCfg = params.cfg.commands?.statelessQuery;
  if (statelessCfg?.enabled === false) {
    return {
      shouldContinue: false,
      reply: { text: "The /ask command is disabled." },
    };
  }

  // Resolve model — use override from config, or the current model.
  let provider = params.provider;
  let model = params.model;
  if (statelessCfg?.model) {
    const parsed = parseModelRef(statelessCfg.model, provider);
    if (parsed) {
      provider = parsed.provider;
      model = parsed.model;
    }
  }

  const runId = crypto.randomUUID();
  const tempSessionId = `stateless-${runId}`;
  // Use a temp file path that won't collide with real sessions.
  const sessionFile = path.join(os.tmpdir(), `openclaw-stateless-${runId}.jsonl`);

  logVerbose(`Stateless query [${provider}/${model}]: ${queryText.slice(0, 80)}`);

  try {
    const result = await runEmbeddedPiAgent({
      sessionId: tempSessionId,
      sessionKey: undefined,
      agentId: params.agentId ?? "main",
      sessionFile,
      config: params.cfg,
      prompt: queryText,
      provider,
      model,
      workspaceDir: params.workspaceDir,
      disableTools: true,
      extraSystemPrompt:
        "This is a stateless query. Answer concisely. Do not reference conversation history.",
      timeoutMs: 30_000,
      runId,
    });

    const text = result.payloads
      ?.map((p) => p.text?.trim())
      .filter(Boolean)
      .join("\n\n");

    if (!text) {
      return {
        shouldContinue: false,
        reply: { text: "(No response)" },
      };
    }

    return {
      shouldContinue: false,
      reply: { text: sanitizeUserFacingText(text, { errorContext: false }) },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logVerbose(`Stateless query failed: ${message}`);
    return {
      shouldContinue: false,
      reply: { text: `⚠️ Stateless query failed: ${message}` },
    };
  }
};
