/**
 * Named boot-config error for the Nyx orchestrator (T015, DS-003).
 *
 * `loadConfig` is a PURE validator: it throws this on invalid input and never
 * touches the process. The bootstrap (index.ts) is the only place that decides
 * to print and `process.exit(1)`, so tests can call `loadConfig(env)` and assert
 * on the thrown error without the process ever exiting.
 */

/** A single missing or invalid configuration variable and why it failed. */
export interface ConfigIssue {
  /** The offending environment variable, or a dotted path into a JSON value. */
  readonly variable: string;
  /** Human-readable reason the value was rejected. */
  readonly reason: string;
}

/**
 * Thrown when the environment fails validation. Carries EVERY offender (not just
 * the first) so a single boot failure lists all problems at once (DS-003).
 */
export class ConfigValidationError extends Error {
  /** All configuration problems found in this validation pass. */
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    const count = issues.length;
    const noun = count === 1 ? "problem" : "problems";
    const lines = issues.map((issue) => `  - ${issue.variable}: ${issue.reason}`).join("\n");
    super(`Invalid Nyx server configuration (${String(count)} ${noun}):\n${lines}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}
