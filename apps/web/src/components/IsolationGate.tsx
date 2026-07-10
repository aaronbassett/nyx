import { ShieldAlert } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Browsers that ship the COOP/COEP + `SharedArrayBuffer` support Nyx needs.
 * Listed so a blocked user knows what to switch to.
 */
const SUPPORTED_BROWSERS = ["Chrome or Edge 92+", "Firefox 95+", "Safari 15.2+"] as const;

/**
 * Hard gate shown when the document is not cross-origin isolated (FR-025 / D39).
 *
 * There is deliberately no degraded mode: the in-browser WebContainer cannot run
 * without `SharedArrayBuffer`, so the shell is not rendered behind this screen.
 */
export function IsolationGate() {
  return (
    <div
      data-testid="isolation-gate"
      role="alert"
      className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground"
    >
      <Card className="max-w-lg">
        <CardHeader>
          <div className="flex items-center gap-3">
            <ShieldAlert className="size-6 shrink-0 text-destructive" aria-hidden="true" />
            <CardTitle>Cross-origin isolation required</CardTitle>
          </div>
          <CardDescription>
            Nyx runs your DApp inside an in-browser WebContainer, which needs{" "}
            <code className="font-mono">SharedArrayBuffer</code>. That is only available when the
            page is cross-origin isolated (
            <code className="font-mono">crossOriginIsolated === true</code>), and this browser or
            context did not grant it. Nyx cannot run in a degraded mode.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm font-medium">Open Nyx in a recent version of:</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {SUPPORTED_BROWSERS.map((browser) => (
              <li key={browser}>{browser}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
