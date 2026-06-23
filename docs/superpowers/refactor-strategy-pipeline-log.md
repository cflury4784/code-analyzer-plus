# Pipeline Log — refactor-strategy.md

## checkpoint: A-start
- stage: A
- cycle: 1
- timestamp: 2026-06-22T00:00:00Z
- standards: {found: true, path: "code-analysis/aggregate/standards.md"}
- gate_decision: pending
- note: Spec entered directly (no Stage 0). Snapshot taken. Dispatching spec-critic cycle 1.

---

## checkpoint: A-1
- stage: A
- cycle: 1
- timestamp: 2026-06-22T00:01:00Z
- standards: {found: true, path: "code-analysis/aggregate/standards.md"}
- gate_decision: approved — f2:A (src/llm-client.ts), f3:A (src/phase-orchestrator.ts), f4:A (function param injection, src/fs-service.ts), f10:A (unit test required)
- note: Cycle 1 complete. 10 findings (0 Critical, 8 Significant, 2 Minor). 5 single-way applied. 4 needs-decision resolved at gate. 1 minor logged only. Proceeding to Stage B.

---

## checkpoint: B-01 — Phase 0 Finding Validation
- stage: B
- cycle: n/a
- timestamp: 2026-06-22T00:10:00Z
- note: Written to plans/01-phase-0-finding-validation.md. Pre-populated verdicts for all 11 findings from source read. Provides: signed-off finding list. Requires: nothing.

## checkpoint: B-02 — Phase 1a Bin Entry Fix
- stage: B
- timestamp: 2026-06-22T00:11:00Z
- note: Written to plans/02-phase-1a-bin-entry-fix.md. Key finding: binary name mismatch (code-analyzer vs gitnexus); file path correct. Provides: working CLI binary. Requires: nothing.

## checkpoint: B-03 — Phase 1b.1 LLM Client
- stage: B
- timestamp: 2026-06-22T00:12:00Z
- note: Written to plans/03-phase-1b1-llm-client.md. Creates src/llm-client.ts; refactors lm-studio.ts and lms-rest.ts. Provides: LLMClient interface, makeAbortPair, T3 enforced. Requires: Phase 0 sign-off.

## checkpoint: B-04 — Phase 1b.2 Phase Orchestrator
- stage: B
- timestamp: 2026-06-22T00:13:00Z
- note: Written to plans/04-phase-1b2-phase-orchestrator.md. Creates src/phase-orchestrator.ts, src/process-helpers.ts; modifies all 4 phase modules + index.ts. Provides: PhaseOrchestrator, T2 enforced. Requires: Phase 1b.1.

## checkpoint: B-05 — Phase 2.1 FileSystemService
- stage: B
- timestamp: 2026-06-22T00:14:00Z
- note: Written to plans/05-phase-2-1-filesystem-service.md. Creates src/fs-service.ts; refactors aggregate.ts and dedup.ts. Provides: FileSystemService, T1 enforced. Requires: Phase 1b.2 gate.

## checkpoint: B-06 — Phase 2.2 extractJson
- stage: B
- timestamp: 2026-06-22T00:15:00Z
- note: Written to plans/06-phase-2-2-extract-json.md. Creates src/utils/extractJson.ts + barrel. Provides: extractJson, C4 fully satisfied. Requires: Phase 1b.2 gate.

## checkpoint: B-07 — Phase 2.3 TestEnvironmentManager
- stage: B
- timestamp: 2026-06-22T00:16:00Z
- note: Written to plans/07-phase-2-3-test-environment-manager.md. Creates tests/utils/TestEnvironmentManager.ts; deletes envHelpers.ts + fsHelpers.ts. Provides: TS1 enforced. Requires: Phase 1b.2 gate.

## checkpoint: B-08 — Phase 2.4 Sync/Async Cleanup
- stage: B
- timestamp: 2026-06-22T00:17:00Z
- note: Written to plans/08-phase-2-4-sync-async-cleanup.md. Converts runLms to async spawn; creates gitnexus-detect.ts; makes index.ts wiring-only. Requires: Phase 1b.2.

## checkpoint: B-09 — Phase 2.5 Platform Adapter
- stage: B
- timestamp: 2026-06-22T00:18:00Z
- note: Written to plans/09-phase-2-5-platform-adapter.md. Creates src/platform-adapter.ts; moves DXGI block; adds discovery precedence comment + unit test (f10 done-when). Requires: Phase 1b.2 gate.

## checkpoint: B-10 — Phase 3.1 Test Fixtures
- stage: B
- timestamp: 2026-06-22T00:19:00Z
- note: Written to plans/10-phase-3-1-test-fixtures.md. Creates tests/utils/fixtures.ts; extracts sseResponse and BatchEntry literals. Requires: Phase 2.3.

## checkpoint: B-11 — Phase 3.2 Utility Extraction
- stage: B
- timestamp: 2026-06-22T00:20:00Z
- note: Written to plans/11-phase-3-2-utility-extraction.md. Creates groupByByteSize + resolveModelIdentifier; consolidates safeMaxTokens. Requires: Phase 2.2.

## checkpoint: B-DONE — Stage B complete
- stage: B
- timestamp: 2026-06-22T00:21:00Z
- note: All 11 plans persisted. Proceeding to Stage C (cross-check + plan review).

---

## checkpoint: C-1 — Stage C cycle 1
- stage: C
- cycle: 1
- timestamp: 2026-06-22T00:30:00Z
- gate_decision: approved — f1:A (keep src/process-helpers.ts, narrow Phase 2.4 to lms.ts only), f5:A (extend Phase 2.1 to all 4 phase modules)
- note: 9 findings (2 Critical, 5 Significant, 2 Minor). 5 single-way applied. 2 needs-decision resolved at gate. 2 minor logged only.

### finding C-c1-f1
- severity: Critical
- resolution: needs-decision → resolved: Option A
- edit_scope: cross-cutting
- title: Phase 1b.2 and Phase 2.4 both extract spawnAsync/detectGitNexus into different files
- applied: yes (Phase 2.4 narrowed to lms.ts only; src/gitnexus-detect.ts section removed)

### finding C-c1-f2
- severity: Critical
- resolution: single-way
- title: Phase 2.1 caller-update missing full orchestrator argument list
- applied: yes (all four full corrected call signatures added to Plan 05)

### finding C-c1-f3
- severity: Significant
- resolution: single-way
- title: Phase 2.5 discovery test path wrong (tests/ vs tests/unit/)
- applied: yes (changed to tests/unit/discovery.test.ts, APPEND)

### finding C-c1-f4
- severity: Significant
- resolution: single-way
- title: Phase 2.5 test uses raw mkdtempSync/rmSync, violates TS1
- applied: yes (replaced with setupTempFs/cleanup in Plan 09)

### finding C-c1-f5
- severity: Significant
- resolution: needs-decision → resolved: Option A
- title: T1 standard incomplete — index.ts and analyze.ts have no plan
- applied: yes (Phase 2.1 extended to all 4 phase modules; T1 fully satisfied by Plan 05)

### finding C-c1-f6
- severity: Significant
- resolution: single-way
- title: C1 violation — hardcoded maxBatchSize/timeoutMs in Phase 1b.2 index.ts
- applied: yes (env var reads + .env.example note added to Plan 04)

### finding C-c1-f7
- severity: Significant
- resolution: single-way
- title: Spurious Phase 1a gate on Phase 1b.1 Requires Manifest
- applied: yes (removed from Plan 03 Requires Manifest)

### finding C-c1-f8
- severity: Minor
- resolution: single-way
- title: Phase 0 "second engineer" criterion not machine-verifiable
- applied: logged-only (treat as human gate in practice)

### finding C-c1-f9
- severity: Minor
- resolution: single-way
- title: Phase 2.4 smoke test references wrong dist path (dist/index.js vs dist/src/index.js)
- applied: yes (corrected to dist/src/index.js in revised Plan 08)

## checkpoint: DONE — Pipeline complete
- stage: final
- timestamp: 2026-06-22T00:35:00Z
- gate_decision: approved
- note: All stages complete. 11 plans written and reviewed. Stage A: 1 cycle, 10 findings resolved. Stage C: 1 cycle, 9 findings resolved. Plans ready for execution.

### finding A-c1-f1
- severity: Significant
- resolution: single-way
- edit_scope: line
- title: src/types.js reference should be src/types.ts
- category: consistency
- location: Phase 2.1 findings bullet
- why: Plan-writers would look for src/types.js, not find it, and create a new file.
- fix: Changed "src/types.js" to "src/types.ts"
- applied: yes
- is_repeat_of: null
- root_cause: n/a

### finding A-c1-f2
- severity: Significant
- resolution: needs-decision
- edit_scope: section
- title: LLMClient interface location and module path not specified
- category: completeness
- location: Phase 1b.1 Action steps 1–4
- why: Plan-writer must invent a file path, risking divergence.
- fix: Add step 0 naming the exact file path for the interface definition.
- applied: no (proposed)
- is_repeat_of: null
- root_cause: n/a

### finding A-c1-f3
- severity: Significant
- resolution: needs-decision
- edit_scope: section
- title: PhaseOrchestrator file path not specified
- category: completeness
- location: Phase 1b.2 Action step 1
- why: Plan-writer will pick an arbitrary location; import paths will diverge.
- fix: Add target file path to step 1.
- applied: no (proposed)
- is_repeat_of: null
- root_cause: n/a

### finding A-c1-f4
- severity: Significant
- resolution: needs-decision
- edit_scope: section
- title: FileSystemService injection pattern (constructor vs param) and file path unspecified
- category: completeness
- location: Phase 2.1 Action steps 1–3
- why: Constructor injection requires phase modules to become classes; param injection keeps them as functions. Incompatible choices.
- fix: Decide injection pattern and name the interface file. Eliminate "or parameter" hedge.
- applied: no (proposed)
- is_repeat_of: null
- root_cause: n/a

### finding A-c1-f5
- severity: Significant
- resolution: single-way
- edit_scope: section
- title: tests/utils/fixtures.ts does not exist — spec treated it as pre-existing
- category: consistency
- location: Phase 3.1 Action step 1; standards.md TS2
- why: Plan-writer may treat creation as modification and emit wrong pre-condition checks.
- fix: Spec and standards.md now explicitly say "Create the new file tests/utils/fixtures.ts".
- applied: yes (refactor-strategy.md + standards.md)
- is_repeat_of: null
- root_cause: n/a

### finding A-c1-f6
- severity: Significant
- resolution: single-way
- edit_scope: section
- title: Phase 2.2 Done-when violates Current Invariant C4 — no guard during Phase 1b
- category: standards-alignment
- location: Phase 1b header (C4 compliance gap)
- why: C4 is enforced now; Phase 1b PRs touching parse-heavy files could introduce new violations.
- fix: Added C4 compliance guard note to Phase 1b header.
- applied: yes
- is_repeat_of: null
- root_cause: n/a

### finding A-c1-f7
- severity: Significant
- resolution: single-way
- edit_scope: section
- title: TestEnvironmentManager file path missing; envHelpers.ts relationship undefined
- category: completeness
- location: Phase 2.3 Action steps 1–2
- why: Plan-writer cannot determine whether to delete, rename, or leave envHelpers.ts.
- fix: Named file path as tests/utils/TestEnvironmentManager.ts; specified envHelpers.ts and fsHelpers.ts are deleted after migration.
- applied: yes
- is_repeat_of: null
- root_cause: n/a

### finding A-c1-f8
- severity: Significant
- resolution: single-way
- edit_scope: section
- title: Sequencing diagram missing 2.3 → 3.1 dependency edge
- category: sequencing
- location: Sequencing Diagram section
- why: Phase 3.1 test file refactors would conflict with 2.3 migration if run in parallel.
- fix: Added 2.3 → 3.1 edge to diagram.
- applied: yes
- is_repeat_of: null
- root_cause: n/a

### finding A-c1-f9
- severity: Minor
- resolution: single-way
- edit_scope: line
- title: Phase 1a Done-when references "npx gitnexus" — ambiguous for broken bin
- category: actionability
- location: Phase 1a.1 Done-when condition
- why: Binary name post-fix is unknown until verification.
- fix: Not auto-applied (minor). Surface at gate.
- applied: logged-only
- is_repeat_of: null
- root_cause: n/a

### finding A-c1-f10
- severity: Minor
- resolution: needs-decision
- edit_scope: section
- title: Phase 2.5 discovery.ts precedence accepts a comment as Done-when — not verifiable
- category: actionability
- location: Phase 2.5 Action step 2 / Done-when condition
- why: Comment-only deliverable cannot be machine-verified and can silently regress.
- fix: Decide: (a) require a unit test asserting exclusion precedence, or (b) explicitly accept comment-level documentation as sufficient.
- applied: no (proposed, minor)
- is_repeat_of: null
- root_cause: n/a
