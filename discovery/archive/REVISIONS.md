# Revision History: nyx-platform

*Record of all revisions to graduated stories.*

---

[Revision entries will be added when graduated stories are revised]

## REV-001: Story 1 - Modified charging model across scenarios, requirements, edge cases, success criteria — 2026-07-10

**Trigger**: Q16 pricing decision (D34): token-metered reserve-then-settle replaced the flat-decrement + credit-back model (D22 superseded)

**Before**:
```
Scenario 4: exhausted turns still charged (D21, D22). Scenario 5: infra failure credits back the NYXT decrement (D22). FR-005: infra-failure refund after 3 retries, no refund on exhaustion. FR-010: decrement after classification. EC-01: zero balance blocks next prompt. EC-02: credit-back on infra failure. SC-003: credit-backs post within 60s
```

**After**:
```
Scenario 4: exhausted turns settle at actual token consumption (D34). Scenario 5: infra failure settles at actual consumption to failure point; no refund mechanism (D34). FR-005: reserve-then-settle - flat reserve after classification, settle at actual consumption in all outcomes, no credit-backs. FR-010: flat reserve placed after classification; declined prompts place none. EC-01: prompt requires available balance >= flat reserve; mid-turn reserve exhaustion finishes current cycle with overage from balance. EC-02: settles at actual consumption. SC-003: turn settlement posts within 60s of turn end
```

**Decision Reference**: D34

**User Confirmed**: Yes — [Date]

---

## REV-002: Story 1 - Additive cross-cutting fixes from /sdd:analyze (owner-authorized) — 2026-07-10

**Trigger**: Three-reviewer cross-artifact analysis; owner pre-authorized automatic MEDIUM+ fixes

**Before**:
```
No FR encoded the D10 config chokepoint (constitution VII had no spec home); FR-033 said protocol-safe size with salient diagnostics (untestable); FR-053 gave no quota default; SC-008 had no provisional number; Personas table still listed BYOK power user as active with (Phase 3) framing despite D57
```

**After**:
```
FR-081 added (config.ts chokepoint + VITE_ guardrail, D10); FR-033 quantified (32 KB cap, deterministic truncation preserving per-test name + first assertion message); FR-053 quota default 20 projects/account (config tunable); SC-008 provisional 60s budget marked adjustable; BYOK persona row retired with D57 annotation
```

**Decision Reference**: D62

**User Confirmed**: Yes — [Date]

---
