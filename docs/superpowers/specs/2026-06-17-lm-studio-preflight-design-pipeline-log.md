# Pipeline log — lm-studio-preflight

## checkpoint: 0-done
- stage: 0
- cycle: n/a
- timestamp: 2026-06-17
- standards: {found: false, path: null}
- gate_decision: n/a
- note: Brainstorming complete; spec written + committed. Tech stack = TypeScript/Node ESM CLI, vitest. Critic reviews against best practices (no standards file).

## checkpoint: A-1
- stage: A
- cycle: 1
- timestamp: 2026-06-17
- standards: {found: false, path: null}
- gate_decision: pending
- note: Cycle 1 critic returned 8 findings. Auto-applied F5 (single-way). 4 Significant needs-decision (F1-F4) + 3 Minor (F6-F8) held for terminal gate. No repeats (cycle 1).

### finding A-c1-f1
- severity: Significant
- resolution: needs-decision
- edit_scope: section
- title: --skip-preflight + new default model sends unloaded/wrong model name to API
- category: bug
- location: §Decisions (API model row), §index.ts wiring
- why: Skipping preflight passes logical name 'qwen3.6-35b-a3b' raw to the HTTP API; may not match loaded identifier → first-batch connection failure, the exact thing preflight prevents.
- fix: Define skip-preflight contract (read-only ps resolve / require --model-override / accept raw).
- applied: no (proposed)
- is_repeat_of: null
- root_cause: n/a

### finding A-c1-f2
- severity: Significant
- resolution: needs-decision
- edit_scope: section
- title: Preflight runs even for model-free --phase aggregate
- category: scope
- location: §index.ts wiring, §Data flow
- why: aggregate takes no model (src/index.ts:79); forcing unload/load can abort a cheap re-run on resources.
- fix: Skip preflight when selected phase set has no model-using phase.
- applied: no (proposed)
- is_repeat_of: null
- root_cause: n/a

### finding A-c1-f3
- severity: Significant
- resolution: needs-decision
- edit_scope: section
- title: resolvedIdentifier lifetime/staleness across phases unspecified
- category: consistency
- location: §index.ts wiring, §Idempotency
- why: Identifier read once; if LM Studio evicts mid-run, later phases send dead id.
- fix: Specify lifetime — compute once + rely on no-idle-TTL load, or re-validate per phase.
- applied: no (proposed)
- is_repeat_of: null
- root_cause: n/a

### finding A-c1-f4
- severity: Significant
- resolution: needs-decision
- edit_scope: section
- title: Unknown --model-override derivation deferred to nonexistent plan section
- category: missing-validation
- location: §models.ts, §Testing test 6
- why: requiredFreeGB / identifierMatch / loadPath derivation undefined; test 6 asserts unspecified behavior.
- fix: Specify conservative requiredFreeGB, regex derivation rule, step-6 fallback.
- applied: no (proposed)
- is_repeat_of: null
- root_cause: n/a

### finding A-c1-f5
- severity: Significant
- resolution: single-way
- edit_scope: section
- title: lms JSON parse assumptions unverified; no malformed-output path
- category: missing-validation
- location: §lms.ts, §Error handling
- why: Bare JSON.parse on external unversioned lms output → unlabeled SyntaxError.
- fix: Defensive parse + shape validation + labeled error; add test.
- applied: yes
- is_repeat_of: null
- root_cause: n/a

### finding A-c1-f6
- severity: Minor
- resolution: single-way
- edit_scope: line
- title: --gpu max fixed in command but also a param (redundant/contradictory)
- category: consistency
- location: §lms.ts load signature, §preflight step 5
- why: Ambiguous whether gpu param is honored.
- fix: Interpolate --gpu ${gpu} or drop the param.
- applied: logged-only
- is_repeat_of: null
- root_cause: n/a

### finding A-c1-f7
- severity: Minor
- resolution: single-way
- edit_scope: line
- title: GB conversion basis (1e9 vs 2^30) and rounding unspecified
- category: ambiguity
- location: §preflight step 4
- why: ~7% difference straddles abort boundary; message digits depend on it.
- fix: Specify GiB (1024^3) and one-decimal rounding.
- applied: logged-only
- is_repeat_of: null
- root_cause: n/a

### finding A-c1-f8
- severity: Minor
- resolution: needs-decision
- edit_scope: line
- title: No bound/timeout on lms load
- category: missing-validation
- location: §Error handling, §lms.ts load
- why: A hung 35B load blocks indefinitely with no labeled error.
- fix: Decide load timeout (value) or document unbounded blocking as accepted.
- applied: no (proposed)
- is_repeat_of: null
- root_cause: n/a

## checkpoint: A-2
- stage: A
- cycle: 2
- timestamp: 2026-06-17
- standards: {found: false, path: null}
- gate_decision: pending (HALTED)
- note: REPEAT-HALT TRIGGERED. Cycle 2 reviewed the revised spec (post empirical re-benchmark: dropped --gpu max, default Q3_K_S confirmed, gate decisions F1-F4/F7/F8 applied). Critic returned 7 findings incl. 1 Critical (F2-1) and 1 repeat (F2-4 is_repeat_of A-c1-f3, root_cause introduced-while-revising). Per A.3, any is_repeat_of != null on cycle >= 2 => STOP + alert. F2-1 Critical premise EMPIRICALLY DISPROVEN this turn: os.totalmem()=31.15 GiB on host (sees full 32GB), so requiredTotalGB:30 passes — no spurious abort; but spec Host-context wording was misleading and caused it. Awaiting user direction to proceed with fixes (override halt) or stop.

### finding A-c2-f1
- severity: Critical
- resolution: needs-decision
- edit_scope: cross-cutting
- title: Resource check vs os.totalmem() assumed to exclude VRAM carveout
- category: bug
- location: §models.ts requiredTotalGB; §preflight step 4; §Host context
- why: Critic asserted os.totalmem() returns ~20GB on carveout host => requiredTotalGB:30 always aborts.
- fix: DISPROVEN on host: os.totalmem()=31.15 GiB (full box). Real fix = correct misleading Host-context wording (no fixed boot carveout; 12GB is HIP VRAM-heap runtime limit). requiredTotalGB:30 passes.
- applied: no (proposed) — wording correction pending
- is_repeat_of: null
- root_cause: n/a

### finding A-c2-f2
- severity: Significant
- resolution: needs-decision
- edit_scope: section
- title: FREE_FLOOR_GB (1.5) unjustified vs measured ~1GB-when-loaded headroom
- category: bug
- location: §models.ts FREE_FLOOR_GB; §preflight step 4
- why: Free-floor sampled post-unload/pre-load; threshold value not justified; risk of spurious abort on thin-headroom box.
- fix: Specify sampling point + what it protects against; justify or adjust value.
- applied: no (proposed)
- is_repeat_of: null
- root_cause: n/a

### finding A-c2-f3
- severity: Significant
- resolution: single-way
- edit_scope: section
- title: estimateTotalGB margin/round-up home unspecified
- category: consistency
- location: §lms.ts estimateTotalGB; §models.ts F4 note; §preflight step 4
- why: "round up + small margin" described in prose but absent from wrapper contract and orchestrator; margin unquantified.
- fix: Place transform in one named location; quantify margin (e.g. +1.0 GiB).
- applied: no (pending)
- is_repeat_of: null
- root_cause: n/a

### finding A-c2-f4
- severity: Significant
- resolution: single-way
- edit_scope: section
- title: F3 per-phase recovery calls full ensureModelReady — re-runs resource gate mid-run + fires under --skip-preflight
- category: bug
- location: §preflight resolveLoadedIdentifier; §index.ts per-phase revalidation + skip-preflight path
- why: Eviction mid-run triggers full reload/gate even under --skip-preflight, contradicting "preserves externally-managed setups".
- fix: Under --skip-preflight, per-phase revalidation is read-only (throw if vanished, never reload); document normal-path recovery re-runs gate.
- applied: no (pending)
- is_repeat_of: A-c1-f3
- root_cause: introduced-while-revising

### finding A-c2-f5
- severity: Minor
- resolution: single-way
- edit_scope: line
- title: numCtx not validated before passing to lms subprocess args
- category: missing-validation
- location: §index.ts numCtx parse; §preflight estimate/load
- why: NaN/bad numCtx now fails inside preflight subprocess rather than HTTP path.
- fix: Validate numCtx positive integer before estimate/load.
- applied: no (pending)
- is_repeat_of: null
- root_cause: n/a

### finding A-c2-f6
- severity: Minor
- resolution: single-way
- edit_scope: line
- title: --skip-preflight not noted in minimist boolean array
- category: consistency
- location: §index.ts wiring
- why: Spec adds flag but omits the minimist config delta.
- fix: Register skip-preflight in minimist boolean: [...].
- applied: no (pending)
- is_repeat_of: null
- root_cause: n/a

### finding A-c2-f7
- severity: Minor
- resolution: single-way
- edit_scope: line
- title: startServer ~15s poll budget may be short for cold ROCm start
- category: ambiguity
- location: §lms.ts startServer; §Error handling
- why: Cold start + ROCm init can exceed 15s => spurious "server won't start".
- fix: Mark provisional / raise to measured-safe value.
- applied: no (pending)
- is_repeat_of: null
- root_cause: n/a

## checkpoint: A-3
- stage: A
- cycle: 3
- timestamp: 2026-06-17
- standards: {found: false, path: null}
- gate_decision: pending
- note: User overrode repeat-halt (chose "apply fixes + cycle-3 review"). Applied all cycle-2 fixes (F2-1..F2-7). Cycle-3 critic verdict = READY: all 7 cycle-2 findings resolved, no recurrence (A-c1-f3/A-c2-f4 NOT recurring). Two new Minor wording items only; auto-applied A-c3-f1. CLEAN -> terminal gate.

### finding A-c3-f1
- severity: Minor
- resolution: single-way
- edit_scope: line
- title: Conservative fallback requiredTotalGB=os.totalmem() always passes gate (X<X false)
- category: consistency
- location: §preflight step 4; §F4 note
- why: Fallback intended "safe" but X<X never aborts; real backstop is step-5 load failure.
- fix: Skip capacity gate on unparseable estimate; document step-5 load failure as backstop.
- applied: yes
- is_repeat_of: null
- root_cause: n/a

### finding A-c3-f2
- severity: Minor
- resolution: single-way
- edit_scope: line
- title: F3 recovery prose could imply unconditional reload (behavior actually correct)
- category: consistency
- location: §preflight resolveLoadedIdentifier recovery branch
- why: ensureModelReady short-circuits if already correct; prose only a clarity nit.
- fix: Optional wording clarification.
- applied: logged-only (behavior correct)
- is_repeat_of: null
- root_cause: n/a

## checkpoint: A-gate
- stage: A
- cycle: n/a
- timestamp: 2026-06-17
- standards: {found: false, path: null}
- gate_decision: approved (user: "ok write the plans")
- note: Stage A terminal gate cleared. User approved proceeding to plan generation.

## checkpoint: B-1
- stage: B
- cycle: n/a
- timestamp: 2026-06-17
- standards: {found: false, path: null}
- gate_decision: n/a
- note: Plans written directly (subagent dispatch hit session limit; feature small/fully-specified). 4 phases persisted to docs/superpowers/specs/plans/: 01-models.md, 02-lms.md, 03-preflight.md, 04-index-wiring.md. Token sizes ~1.2k/2.1k/4.4k/2.4k (all << 70k split threshold).

## checkpoint: C-1
- stage: C
- cycle: 1
- timestamp: 2026-06-17
- standards: {found: false, path: null}
- gate_decision: pending
- note: C.1 deterministic cross-check PASSED (acyclic, complete, no ordering violation). C.2 fits (~10k tok < 150k) -> full-text single critic. C.3 verdict = "minor fixes": 2 Significant single-way (applied) + 3 Minor (1 needs-decision f3 decided + applied; 2 confirmation-only). No repeats.

### finding C-c1-f1
- severity: Significant
- resolution: single-way
- title: tests/lms.test.ts type-only import + typeof does not type-check
- location: plans/03-preflight.md
- fix: Export explicit RunLms type from lms.ts (P2); import `type RunLms` in tests.
- applied: yes
- is_repeat_of: null

### finding C-c1-f2
- severity: Significant
- resolution: single-way
- title: tsc --noEmit does not type-check tests (tsconfig excludes tests/)
- location: plans/02,03,04 §5; tsconfig.json
- fix: Add tsconfig.tests.json + typecheck:tests script (P4); correct §5 claims.
- applied: yes
- is_repeat_of: null

### finding C-c1-f3
- severity: Minor
- resolution: needs-decision
- title: estimate-only ANSI/spacing regex left conditional
- location: plans/02-lms.md
- fix: Decided — strip ANSI + tolerant regex committed; added ANSI fixture test 7e.
- applied: yes
- is_repeat_of: null

### finding C-c1-f4
- severity: Minor
- title: numCtx validation soundness (confirmation only — no defect)
- applied: no change needed
- is_repeat_of: null

### finding C-c1-f5
- severity: Minor
- title: index.ts diffs apply against current file (confirmation only)
- applied: no change needed
- is_repeat_of: null

### finding C-c1-f6
- severity: Minor
- resolution: single-way
- title: README note skip-preflight resolves/throws before first phase
- fix: Added sentence.
- applied: yes
- is_repeat_of: null

## checkpoint: C-gate
- stage: C
- cycle: n/a
- timestamp: 2026-06-17
- standards: {found: false, path: null}
- gate_decision: pending
- note: All Stage C findings applied. Plans clean and executable. Awaiting user approval at terminal gate before implementation.
