import { useEffect, useMemo, useRef, useState } from "react";
import { useLogs, log, type LogEntry, type LogLevel } from "@/lib/logger";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const LEVEL_STYLES: Record<LogLevel, { label: string; className: string }> = {
  info: { label: "INFO", className: "text-sky-500" },
  success: { label: " OK ", className: "text-emerald-500" },
  warn: { label: "WARN", className: "text-amber-500" },
  error: { label: "ERR ", className: "text-red-500" },
  debug: { label: "DBG ", className: "text-zinc-500" },
  call: { label: "CALL", className: "text-violet-500" },
};

function stringify(data: unknown): string {
  try {
    return JSON.stringify(
      data,
      (_k, v) => (typeof v === "bigint" ? `${v.toString()}n` : v),
      2,
    );
  } catch {
    return String(data);
  }
}

function LogRow({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useState(false);
  const style = LEVEL_STYLES[entry.level];
  const hasData = entry.data !== undefined;
  return (
    <div className="border-b border-border/40 py-1">
      <button
        type="button"
        onClick={() => hasData && setOpen((o) => !o)}
        className={cn(
          "flex w-full items-start gap-2 text-left font-mono text-xs",
          hasData && "cursor-pointer hover:bg-accent/40",
        )}
      >
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {entry.iso.slice(11, 23)}
        </span>
        <span className={cn("shrink-0 font-bold", style.className)}>{style.label}</span>
        <span className="shrink-0 text-violet-400">[{entry.scope}]</span>
        <span className="whitespace-pre-wrap break-words text-foreground">{entry.message}</span>
        {hasData && <span className="ml-auto shrink-0 text-muted-foreground">{open ? "▾" : "▸"}</span>}
      </button>
      {hasData && open && (
        <pre className="mt-1 max-h-72 overflow-auto rounded bg-black/40 p-2 font-mono text-[11px] leading-relaxed text-emerald-200">
          {stringify(entry.data)}
        </pre>
      )}
    </div>
  );
}

export function LogPanel() {
  const logs = useLogs();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoscroll, setAutoscroll] = useState(true);
  const [filter, setFilter] = useState<LogLevel | "all">("all");

  const filtered = useMemo(
    () => (filter === "all" ? logs : logs.filter((l) => l.level === filter)),
    [logs, filter],
  );

  useEffect(() => {
    if (autoscroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filtered, autoscroll]);

  return (
    <div className="flex h-full flex-col rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <span className="text-sm font-semibold">Event log</span>
        <span className="text-xs text-muted-foreground">({filtered.length})</span>
        <div className="ml-auto flex items-center gap-1">
          {(["all", "call", "success", "warn", "error"] as const).map((lvl) => (
            <button
              key={lvl}
              type="button"
              onClick={() => setFilter(lvl)}
              className={cn(
                "rounded px-2 py-0.5 text-xs font-medium",
                filter === lvl ? "bg-primary text-primary-foreground" : "hover:bg-accent",
              )}
            >
              {lvl}
            </button>
          ))}
          <label className="ml-2 flex items-center gap-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={autoscroll}
              onChange={(e) => setAutoscroll(e.target.checked)}
            />
            auto
          </label>
          <Button size="sm" variant="ghost" onClick={() => log.clear()}>
            clear
          </Button>
        </div>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-3 py-1">
        {filtered.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">
            No events yet. Run a step above.
          </p>
        ) : (
          filtered.map((entry) => <LogRow key={entry.id} entry={entry} />)
        )}
      </div>
    </div>
  );
}
