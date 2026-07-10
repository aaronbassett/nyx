import { describe, expect, it } from "vitest";

import { isolationHeadersFor } from "@/lib/isolation-headers";

describe("isolationHeadersFor", () => {
  it("serves the strict isolation pair for app routes", () => {
    for (const pathname of ["/", "/index.html", "/assets/app.js"]) {
      const headers = isolationHeadersFor(pathname);
      expect(headers["Cross-Origin-Embedder-Policy"]).toBe("require-corp");
      expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    }
  });

  it("serves the unsafe-none carve-out for the connect bridge route", () => {
    for (const pathname of ["/webcontainer/connect", "/webcontainer/connect/bridge"]) {
      const headers = isolationHeadersFor(pathname);
      expect(headers["Cross-Origin-Embedder-Policy"]).toBe("unsafe-none");
      expect(headers["Cross-Origin-Opener-Policy"]).toBe("unsafe-none");
    }
  });

  it("does not apply the carve-out to sibling paths that merely share the prefix", () => {
    const headers = isolationHeadersFor("/webcontainer/connection");
    expect(headers["Cross-Origin-Embedder-Policy"]).toBe("require-corp");
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
  });
});
