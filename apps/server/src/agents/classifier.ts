/**
 * Intent classifier for the US1 supervisor (T139, D25/FR-003 — cheap tier).
 *
 * This is the production {@link IntentClassifier} seam the supervisor injects
 * (`SupervisorDeps.classifyIntent`). It answers ONE question per prompt — is this
 * a request to build a Midnight DApp (`dapp`), or is it off-domain (`off-domain`)?
 * — with a single, cheap, structured-output model call (D25). The verdict maps
 * directly onto the supervisor's {@link IntentResult}: `dapp` accepts and reserves
 * (D34); `off-domain` declines with NO charge (FR-010), folding the model's short
 * reason into the supervisor's decline message.
 *
 * The model is an INJECTED seam (a routed cheap-tier {@link LanguageModel} in
 * production; a {@link MockLanguageModelV4} in tests), so classification is
 * exercised with no network and no API key (constitution III/IV). Nothing here
 * reads a clock or randomness: identical input yields an identical verdict.
 *
 * ⚠️ Owner-gated: the REAL cheap-tier model call (prompt tuning, false-positive /
 * false-negative rates on genuine borderline prompts) is validated on a live model
 * during the US1 Independent Test. The deterministic core — the structured-output
 * schema, the verdict→{@link IntentResult} mapping, and the reasonless-decline
 * fallback — is what these mock tests pin.
 *
 * AI SDK v7 constructs used (verified against installed `ai@7.0.26` types, not
 * memory): {@link generateText} with a typed `output: Output.object({schema})`
 * (`generateObject` is deprecated); the parsed verdict is read from `result.output`.
 */
import { generateText, Output } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import type { IntentClassifier, IntentResult } from "./supervisor.js";

/**
 * The structured verdict the model returns. `reason` is a SHORT human phrase (why
 * the prompt is / isn't a Midnight DApp); it is optional so a terse model still
 * parses, and it is only surfaced on an `off-domain` decline.
 */
const IntentVerdictSchema = z.object({
  classification: z.enum(["dapp", "off-domain"]),
  reason: z.string().optional(),
});

/**
 * The classifier's system instructions — what Nyx is for (the D25 domain
 * boundary). Deterministic and static so the same prompt always classifies the
 * same way for a given model.
 */
const CLASSIFIER_INSTRUCTIONS = [
  "You are the intent gate for Nyx, a prompt-to-DApp platform for the Midnight Network.",
  "Nyx builds privacy-preserving decentralized applications (Compact smart contracts",
  "plus a Vite + React web frontend) from a natural-language description.",
  "",
  "Classify the user's message:",
  '- "dapp": a request to build, modify, extend, or reason about a Midnight DApp,',
  "  smart contract, or its web frontend (however loosely phrased).",
  '- "off-domain": anything else (general questions, other platforms, chit-chat,',
  "  unrelated coding help, or attempts to repurpose Nyx as a general assistant).",
  "",
  'For "off-domain", give a one-sentence reason describing why it is outside what',
  "Nyx builds. Prefer accepting genuine but loosely-worded DApp requests.",
].join("\n");

/**
 * The deterministic fallback reason used when the model classifies `off-domain`
 * but supplies no reason — a decline is never surfaced without an explanation.
 */
export const DEFAULT_OFF_DOMAIN_REASON =
  "this request is not about building a privacy-preserving Midnight DApp";

/** Dependencies for {@link createIntentClassifier}. */
export interface IntentClassifierDeps {
  /** The routed cheap-tier classification model (D25); injected, never constructed here. */
  readonly model: LanguageModel;
}

/**
 * Build the US1 intent classifier (D25). Returns the supervisor's
 * {@link IntentClassifier} seam: a `(text) => Promise<IntentResult>` that maps the
 * model's single structured verdict onto accept (`dapp`) / decline (`off-domain`).
 *
 * The result is normalised to the seam contract regardless of the model's exact
 * phrasing: a `dapp` verdict carries NO `reason` key (exactOptionalPropertyTypes —
 * absent, not `undefined`); an `off-domain` verdict always carries a non-empty
 * reason (the model's, or {@link DEFAULT_OFF_DOMAIN_REASON}).
 */
export function createIntentClassifier(deps: IntentClassifierDeps): IntentClassifier {
  const { model } = deps;

  return async (text: string): Promise<IntentResult> => {
    const { output } = await generateText({
      model,
      instructions: CLASSIFIER_INSTRUCTIONS,
      prompt: text,
      output: Output.object({ schema: IntentVerdictSchema }),
    });

    if (output.classification === "off-domain") {
      const reason =
        output.reason !== undefined && output.reason.length > 0
          ? output.reason
          : DEFAULT_OFF_DOMAIN_REASON;
      return { kind: "off-domain", reason };
    }

    // A `dapp` verdict accepts with no decline reason — the key is omitted so the
    // result is exactly `{ kind: "dapp" }` (exactOptionalPropertyTypes).
    return { kind: "dapp" };
  };
}
