import { IsolationGate } from "@/components/IsolationGate";
import { Shell } from "@/components/Shell";
import { isCrossOriginIsolated } from "@/lib/isolation";

/**
 * App root. Enforces the cross-origin isolation hard gate (FR-025 / D39) before
 * rendering anything else: without `crossOriginIsolated` the in-browser
 * WebContainer cannot run, so we show the gate instead of the shell.
 */
export function App() {
  if (!isCrossOriginIsolated()) {
    return <IsolationGate />;
  }
  return <Shell />;
}
