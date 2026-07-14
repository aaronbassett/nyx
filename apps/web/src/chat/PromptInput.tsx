/**
 * Prompt input (US1, T143, D24).
 *
 * A controlled textarea + submit button. The input is DISABLED while a turn is
 * active (the D24 input lock — `disabled` is driven by `TurnState.inputDisabled`);
 * a disabled or empty/whitespace submit is a no-op. Submitting trims the text,
 * hands it to `onSubmit`, and clears the field. Sending `prompt:submit` is the
 * container's job — this view only reports the intent.
 */
import { useState } from "react";
import { Send } from "lucide-react";

import { Button } from "@/components/ui/button";

export interface PromptInputProps {
  readonly disabled: boolean;
  readonly onSubmit: (text: string) => void;
}

export function PromptInput({ disabled, onSubmit }: PromptInputProps) {
  const [text, setText] = useState("");
  const canSubmit = !disabled && text.trim().length > 0;

  function handleSubmit(event: React.SyntheticEvent): void {
    event.preventDefault();
    const trimmed = text.trim();
    if (disabled || trimmed.length === 0) {
      return;
    }
    onSubmit(trimmed);
    setText("");
  }

  return (
    <form data-testid="chat-form" onSubmit={handleSubmit} className="flex flex-col gap-2">
      <label htmlFor="chat-input" className="sr-only">
        Message Nyx
      </label>
      <textarea
        id="chat-input"
        data-testid="chat-input"
        value={text}
        disabled={disabled}
        onChange={(event) => {
          setText(event.target.value);
        }}
        rows={3}
        placeholder={disabled ? "Nyx is working…" : "Describe the DApp you want to build"}
        className="border-input bg-background focus-visible:ring-ring/50 min-h-20 resize-y rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2 disabled:opacity-50"
      />
      <Button type="submit" disabled={!canSubmit} data-testid="chat-submit" className="self-end">
        <Send className="size-4" aria-hidden="true" />
        Send
      </Button>
    </form>
  );
}
