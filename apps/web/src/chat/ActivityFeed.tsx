/**
 * Collapsible per-sub-agent activity feed (US1, T143, D20).
 *
 * Renders `turn:activity` grouped by sub-agent (scaffolding/planning/
 * implementation/review) with each entry's phase/detail, plus the turn's verify-
 * cycle count (D20/D21). The feed is collapsible; collapse is local UI state.
 * Renders nothing when there is no activity yet.
 */
import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

import type { AgentActivityGroup } from "./types";

export interface ActivityFeedProps {
  readonly groups: readonly AgentActivityGroup[];
  readonly cyclesCompleted: number;
}

export function ActivityFeed({ groups, cyclesCompleted }: ActivityFeedProps) {
  const [expanded, setExpanded] = useState(true);

  if (groups.length === 0) {
    return null;
  }

  const cycleLabel = `${cyclesCompleted.toString()} verify ${cyclesCompleted === 1 ? "cycle" : "cycles"}`;

  return (
    <section data-testid="chat-activity" className="rounded-lg border text-sm">
      <button
        type="button"
        data-testid="chat-activity-toggle"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((value) => !value);
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left font-medium"
      >
        <ChevronDown
          className={cn("size-4 shrink-0 transition-transform", expanded ? "" : "-rotate-90")}
          aria-hidden="true"
        />
        <span>Agent activity</span>
        <span data-testid="chat-activity-cycles" className="text-muted-foreground ml-auto text-xs">
          {cycleLabel}
        </span>
      </button>

      {expanded ? (
        <div data-testid="chat-activity-content" className="flex flex-col gap-3 px-3 pb-3">
          {groups.map((group) => (
            <div key={group.agent} data-testid={`chat-activity-group-${group.agent}`}>
              <h4 className="text-xs font-semibold capitalize">{group.agent}</h4>
              <ul className="mt-1 flex flex-col gap-0.5">
                {group.entries.map((entry, index) => (
                  <li
                    key={`${group.agent}:${index.toString()}:${entry.ts.toString()}`}
                    className="text-muted-foreground flex gap-2 text-xs"
                  >
                    <span className="font-mono">{entry.phase}</span>
                    {entry.detail.length > 0 ? (
                      <span className="min-w-0 break-words">{entry.detail}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
