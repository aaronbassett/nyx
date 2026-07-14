/**
 * Chat message list (US1, T143, D20).
 *
 * A pure view over the accumulated {@link DisplayMessage} rows: user prompts,
 * streamed assistant/supervisor narration (whose `content` grows as `turn:message`
 * deltas arrive), and off-domain declines (D25) rendered as a distinct,
 * non-failure row. Each row carries a `chat-message-<kind>` test id.
 */
import { Bot, Info, User } from "lucide-react";

import { cn } from "@/lib/utils";

import type { DisplayMessage, DisplayMessageKind } from "./types";

export interface MessageListProps {
  readonly messages: readonly DisplayMessage[];
}

/** Human-facing author label per row kind. */
const ROLE_LABEL: Record<DisplayMessageKind, string> = {
  user: "You",
  assistant: "Nyx",
  supervisor: "Supervisor",
  decline: "Nyx",
};

/** Author icon per row kind. */
function RowIcon({ kind }: { readonly kind: DisplayMessageKind }) {
  if (kind === "user") {
    return <User className="size-4 shrink-0" aria-hidden="true" />;
  }
  if (kind === "decline") {
    return <Info className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />;
  }
  return <Bot className="text-primary size-4 shrink-0" aria-hidden="true" />;
}

export function MessageList({ messages }: MessageListProps) {
  return (
    <ol data-testid="chat-messages" className="flex flex-col gap-3">
      {messages.map((message) => (
        <li
          key={message.id}
          data-testid={`chat-message-${message.kind}`}
          data-streaming={message.streaming}
          className={cn(
            "flex gap-2 rounded-lg border px-3 py-2 text-sm",
            message.kind === "user" && "bg-muted/40",
            message.kind === "decline" && "border-dashed",
          )}
        >
          <RowIcon kind={message.kind} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-muted-foreground text-xs font-medium">
              {ROLE_LABEL[message.kind]}
            </span>
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
