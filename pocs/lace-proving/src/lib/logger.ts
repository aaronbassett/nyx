// Central observable logger for the PoC.
//
// Every step, SDK call and response is recorded here with a timestamp, mirrored
// to the browser console, and rendered into the on-page log panel. When a step
// fails, the panel shows exactly where and why.

import { useSyncExternalStore } from "react";

export type LogLevel = "info" | "success" | "warn" | "error" | "debug" | "call";

export interface LogEntry {
  id: number;
  ts: number; // epoch ms
  iso: string; // ISO timestamp
  level: LogLevel;
  scope: string; // which step / subsystem
  message: string;
  data?: unknown; // optional structured payload
}

let counter = 0;
let entries: LogEntry[] = [];
const listeners = new Set<() => void>();

function emit() {
  // Notify React subscribers with a fresh array identity.
  entries = entries.slice();
  for (const l of listeners) l();
}

function consoleMirror(entry: LogEntry) {
  const prefix = `%c[${entry.iso.slice(11, 23)}] %c${entry.scope}`;
  const scopeStyle = "color:#7c3aed;font-weight:600";
  const tsStyle = "color:#6b7280";
  const method =
    entry.level === "error"
      ? console.error
      : entry.level === "warn"
        ? console.warn
        : entry.level === "debug"
          ? console.debug
          : console.info;
  if (entry.data !== undefined) {
    method(`${prefix} — ${entry.message}`, tsStyle, scopeStyle, entry.data);
  } else {
    method(`${prefix} — ${entry.message}`, tsStyle, scopeStyle);
  }
}

/**
 * Safely turn an unknown value (often an Error or SDK object) into something
 * we can display and JSON-stringify without throwing on circular refs / bigints.
 */
export function normalizeData(data: unknown): unknown {
  if (data instanceof Error) {
    return {
      name: data.name,
      message: data.message,
      stack: data.stack,
      ...(data.cause ? { cause: normalizeData(data.cause) } : {}),
    };
  }
  return data;
}

function record(level: LogLevel, scope: string, message: string, data?: unknown) {
  const ts = Date.now();
  const entry: LogEntry = {
    id: ++counter,
    ts,
    iso: new Date(ts).toISOString(),
    level,
    scope,
    message,
    data: data === undefined ? undefined : normalizeData(data),
  };
  entries.push(entry);
  emit();
  consoleMirror(entry);
  return entry;
}

export const log = {
  info: (scope: string, message: string, data?: unknown) => record("info", scope, message, data),
  success: (scope: string, message: string, data?: unknown) =>
    record("success", scope, message, data),
  warn: (scope: string, message: string, data?: unknown) => record("warn", scope, message, data),
  error: (scope: string, message: string, data?: unknown) => record("error", scope, message, data),
  debug: (scope: string, message: string, data?: unknown) => record("debug", scope, message, data),
  /** Log an outbound SDK / network call. */
  call: (scope: string, message: string, data?: unknown) => record("call", scope, message, data),
  clear: () => {
    entries = [];
    counter = 0;
    emit();
  },
};

/**
 * Wrap an async SDK call so we log the attempt, the result (or error), and the
 * wall-clock duration. Timing is itself evidence: an in-wallet proof is slow
 * (seconds), a no-op is instant.
 */
export async function traced<T>(
  scope: string,
  message: string,
  fn: () => Promise<T>,
  opts?: { onResult?: (r: T) => unknown },
): Promise<T> {
  const start = performance.now();
  log.call(scope, `${message} — start`);
  try {
    const result = await fn();
    const ms = Math.round(performance.now() - start);
    log.success(scope, `${message} — ok (${ms} ms)`, opts?.onResult ? opts.onResult(result) : undefined);
    return result;
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    log.error(scope, `${message} — FAILED (${ms} ms)`, err);
    throw err;
  }
}

// ---- React binding -------------------------------------------------------

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot() {
  return entries;
}

export function useLogs(): LogEntry[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
