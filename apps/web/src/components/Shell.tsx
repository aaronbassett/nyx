import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Placeholder panels standing in for the surfaces later stories fill in
 * (chat, WebContainer preview, editor, wallet, ledger).
 */
const PLACEHOLDER_PANELS = [
  { title: "Chat", description: "Describe the DApp you want. The Nyx swarm builds it." },
  { title: "Preview", description: "Your generated DApp runs live in a WebContainer." },
  { title: "Editor", description: "Inspect and tweak the generated Compact and TypeScript." },
] as const;

/**
 * Minimal app shell rendered once cross-origin isolation is confirmed. Kept
 * intentionally sparse — it exists to prove Tailwind v4 + shadcn wiring works;
 * later stories mount the real chat, preview, editor, wallet, and ledger UIs.
 */
export function Shell() {
  return (
    <div
      data-testid="app-shell"
      className="flex min-h-screen flex-col bg-background text-foreground"
    >
      <header className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <Sparkles className="size-5 text-primary" aria-hidden="true" />
          <span className="text-lg font-semibold tracking-tight">Nyx</span>
        </div>
        <Button size="sm" variant="outline">
          New DApp
        </Button>
      </header>
      <main className="flex-1 p-6">
        <div className="mx-auto grid max-w-5xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PLACEHOLDER_PANELS.map((panel) => (
            <Card key={panel.title}>
              <CardHeader>
                <CardTitle>{panel.title}</CardTitle>
                <CardDescription>{panel.description}</CardDescription>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">Coming soon.</CardContent>
            </Card>
          ))}
        </div>
      </main>
    </div>
  );
}
