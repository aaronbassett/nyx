# Open Questions: nyx-platform

## 🔴 Blocking




### Cross-Cutting / Affects Graduated Stories
[Questions that may trigger revisions to graduated stories]

### Problem Space (Phase 1)
[Questions about problem domain that may surface new stories]

---

## 🟡 Clarifying
[Questions that help but don't block progress]






---

## 🔵 Research Pending
[Questions requiring investigation]
- **Q3**: Does Lace inject window.midnight into the WebContainer preview origin when opened as a top-level tab, and what is preview lifetime while the original tab stays open?
  - *Context*: PRD section 6 and 14.3. Phase 0 assumption to verify; the escape-hatch flow depends on it.





---

## 🟠 Watching (May Affect Graduated)
*Questions that could trigger revisions:*
[Track questions that may require changes to completed stories]

---

## Question Log Summary

**Total Questions**: 16
**Open**: 14
**Resolved**: 2


<!-- Resolved: Q10 - Owner decision 2026-07-10: in scope - archive download AND read-only clone URL (Phase 3). Promoted to Story 13. See D17. -->

<!-- Resolved: Q11 - Owner decision 2026-07-10: in scope - Monaco editor with Monarch tokenizer hand-ported from LFDT-Minokawa TextMate grammar (Phase 3). Promoted to Story 14. See D18. -->

<!-- Resolved: Q12 - Owner decision 2026-07-10: per-agent provider+model via static config file with redeploy; OpenAI/Anthropic/Gemini first-party, OpenRouter, owner-hosted OpenAI-compatible endpoints. BYOK still Phase 3. See D19. -->

<!-- Resolved: Q13 - Owner decision 2026-07-10: full activity stream - supervisor narration, collapsible sub-agent feed, persistent tab-alive session indicator, interrupted-turn recovery message. See D20. -->

<!-- Resolved: Q14 - Owner decision 2026-07-10: 3 compile+test cycles per turn with honest failure on exhaustion (D21); bounded retries then loud failure and NYXT credit-back on infra unavailability, no refund for exhausted budgets (D22). -->

<!-- Resolved: Q15 - Owner decision 2026-07-10: chat history persisted with the project in the authoritative store and rehydrated on open. See D23. -->

<!-- Resolved: Q1 - Owner decision 2026-07-10: Postgres rows - files as rows with turn-scoped transactional commits; chat history alongside; R2 remains ephemeral-artifacts-only preserving the D6 single-writer boundary. See D26. -->

<!-- Resolved: Q5 - Owner decision 2026-07-10: owner develops Tome - assume retrieval works, fix upstream if not. Story 1 watching item retired. See D27. -->

<!-- Resolved: Q17 - Owner decision 2026-07-10: owner develops mnm, hosted on Fly.io like the orchestrator - assume reachable, fix upstream if not. See D28. -->

<!-- Resolved: Q4 - Owner decision 2026-07-10: commercial license not needed at present per StackBlitz terms. Recheck at commercial launch. See D29. -->

<!-- Resolved: Q7 - Owner decision 2026-07-10: toolchain exposed via owner's in-development MCP server; assume agent access. Story 2 specifies the consumed tool contract instead. See D30. -->

<!-- Resolved: Q8 - Owner decision 2026-07-10: spec the consumed contract only (safe concurrency, no silent timeouts, explicit queued/progress state); concurrency model and sizing are implementation details of the owner's toolchain MCP. See D31. -->

<!-- Resolved: Q9 - Owner decision 2026-07-10: only crate names matter; convention nyx-midnight-* (verified available on crates.io; bare nyx taken). Consider early placeholder publishes. See D33. -->

<!-- Resolved: Q16 - Owner decision 2026-07-10: token-metered reserve-then-settle with flat reserve; settle at actual consumption in all outcomes; no credit-backs; deposits one-way. Supersedes D22. See D34, REV-001. -->

<!-- Resolved: Q18 - Owner decision 2026-07-10: check mode per verify iteration, full artifacts compile on green; artifacts:ready at most once per successful turn. See D35. -->

<!-- Resolved: Q19 - Owner decision 2026-07-10: accept breakage - expired-artifact fetches surface a clear reopen-the-project error; no protocol change. See D36. -->

<!-- Resolved: Q2 - Owner decision 2026-07-10: interim Nyx-hosted proof server (D37). Evidence trail: connector v4 + getProvingProvider advertised by live Lace (R5, R7); end-to-end in-wallet proving unverifiable due to wallet-sdk tx-history migration bug (R8). Watching item: retest and flip back when the upstream fix lands. -->

<!-- Resolved: Q20 - Owner decision 2026-07-10: full resync on reconnect via authoritative manifest diff (paths + content hashes); no sequence numbers. See D38. -->

<!-- Resolved: Q21 - Owner decision 2026-07-10: one auto-reboot then loud crashed state with manual retry; hard unsupported-browser gate, no degraded mode. See D39. Multi-tab: last tab wins (D40). -->

<!-- Resolved: Q22 - Owner decision 2026-07-10: steering only - green is a passing suite; quality owned by compact-testing steering + Review agent; per-circuit coverage tracked as telemetry, mechanical floor available via revision if needed. See D41. -->

<!-- Resolved: Q23 - Owner decision 2026-07-10: no retries, 120s per-run budget, timeout = failing cycle with diagnostics. See D42. -->

<!-- Resolved: Q24 - Owner decision 2026-07-10: unshielded address keys the account; one wallet = one account. See D43. -->

<!-- Resolved: Q25 - Owner decision 2026-07-10: 7-day sliding sessions, re-sign after 7 idle days, logout invalidates immediately. See D44. -->

<!-- Resolved: Q26 - Owner decision 2026-07-10: Architecture C - single NyxtVault, one atomic deposit circuit, one signature per top-up. See D45. -->

<!-- Resolved: Q27 - Owner decision 2026-07-10: no auto-credit; orphans table + manual support resolution. See D46. -->

<!-- Resolved: Q6 - Closed by Story 6 graduation 2026-07-10: NyxtVault Architecture C per the R4 design brief (D45); attribution via preregistered depositRef matched on finalized SUCCESS indexer observations; unshielded NYXT. Pre-implementation Watching gate: R4 vault-funding spike. -->

<!-- Resolved: Q28 - Owner decision 2026-07-10: turn-scoped version history retained with config retention window; undo/restore future-enabled, not in scope. See D48. -->

<!-- Resolved: Q29 - Owner decision 2026-07-10: soft-delete with 30-day recovery; immediate cascade for artifacts/contracts/sessions; caps and quota as config tunables. See D49. -->

<!-- Resolved: Q30 - Owner decision 2026-07-10: orchestrator-direct - key stays in the main app server per D9 literal; toolchain MCP remains compile-only. See D50. -->

<!-- Resolved: Q31 - Owner decision 2026-07-10: deploys free on pre-prod; ledger stays purely model-cost. See D51. -->

<!-- Resolved: Q32 - Owner decision 2026-07-10: session-bound short-lived proving tokens, per-session rate limits. See D52. -->

<!-- Resolved: Q33 - Owner decision 2026-07-10: detect-and-guide popup UX; persistent lifetime notice. See D53. -->

<!-- Resolved: Q34 - Owner decision 2026-07-10: batched burn matching consumed credit, exactly-once per watermark. See D55. -->

<!-- Resolved: Q35 - Owner decision 2026-07-10: daily schedule only, cadence as config. See D56. -->

<!-- Resolved: Q36 - Owner decision 2026-07-10: BYOK descoped entirely (supersedes D14). See D57. -->

<!-- Resolved: Q37 - Owner decision 2026-07-10: unguessable revocable read-only token URLs. See D58. -->

<!-- Resolved: Q38 - Owner decision 2026-07-10: commits synthesized from D48 turn history. See D59. -->

<!-- Resolved: Q39 - Owner decision 2026-07-10: debounced auto-save (~1s idle). See D60. -->