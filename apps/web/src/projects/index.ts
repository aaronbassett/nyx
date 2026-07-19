/**
 * Public surface of the US13 project-handoff UI (FR-074/FR-075/D49/D58/D59).
 *
 * A pure re-export barrel: the handoff REST client (`GET archive` URL +
 * `POST`/`DELETE` clone-token), the clone-token state machine (reducer +
 * `useHandoff`), and the `HandoffPanel` container, plus every seam and
 * view-model type, are surfaced here so consumers import from `@/projects`
 * rather than reaching into files. The panel is intentionally NOT wired into the
 * app Shell (owner-gated placeholder).
 */
export { createHttpHandoffClient, HandoffFetchError } from "./handoff-client";
export type { HandoffClient, HandoffFetchReason, HttpHandoffClientDeps } from "./handoff-client";

export {
  buildCloneUrl,
  createInitialHandoffState,
  handoffErrorMessage,
  handoffReducer,
  HandoffPanel,
  useHandoff,
  DEFAULT_COPY_RESET_MS,
} from "./handoff";
export type {
  ClipboardWriter,
  DownloadTrigger,
  HandoffAction,
  HandoffPanelProps,
  HandoffProject,
  HandoffState,
  HandoffStatus,
  UseHandoff,
  UseHandoffOptions,
} from "./handoff";
