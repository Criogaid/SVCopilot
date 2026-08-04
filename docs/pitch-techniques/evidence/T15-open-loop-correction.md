# T15 Open-Loop Correction

Captured: `2026-08-04`

## Scope

T15 adds `sv_plan/plan_pitch_correction`, a pure in-memory P3 planner. It reads one previously
committed P2 `sv_plan_pitch_gesture` PlanRef and one post-commit range Context, then returns at
most one sealed `sv_patch_parameter_curves` PlanRef. It never enters the execution coordinator,
opens Undo, retries a write, or claims that a predicted improvement was observed.

The source PlanRef must be committed, retain a v2 uniform-seconds correction target, contain only
additive `pitchDelta` replacement curves, and retain P2 provenance. The observed Context must
identify exactly the sealed target occurrence and contain notes, captured `pitchDelta` Automation,
computed pitch, a tempo map, and internally consistent sampling provenance. Missing retention,
vibrato/non-additive sources, target mismatch, ambiguity, expired artifacts, and missing capture
all stop before an output PlanRef exists.

## Solver And Boundaries

The production solver uses a dedicated five-diagonal Cholesky factorization. It solves each
continuous finite run separately, so null gaps have no D2 coupling. The independent dense oracle
remains in `reference/model.mjs` and is used only by tests. The public `magnitudeMu` hard floor is
`1e-6`; all-null and insufficient-coverage inputs return `insufficient_evidence`, while a zero or
non-improving projected correction returns `no_change`.

The retained target and observed series are aligned on the P2 sealed uniform-seconds axis. A
retained target is capped at 4000 frames before it can become a P3 source, matching the transaction
hard point budget. Each output run is checked against the supported `pitchDelta` range, 2000-point
per-curve cap, total 4000-point cap, and the versioned slope policy. If otherwise eligible samples
collapse to one local BLICK and cannot form an Automation range, the planner returns
`CORRECTION_TIME_RESOLUTION_TOO_COARSE` before sealing or writing.

`pitch-correction-policy-v1` currently uses a 0.01-cent write threshold and a 1200-cent/second
slope cap. Its declared basis is `synthetic_corpus_v1_requires_live_host_calibration`; it is not
presented as a completed live-host calibration.

## Verification

| Check | Result |
|---|---|
| Banded solver vs independent dense oracle | 3, 4, 17, 127, and 2000-frame cases agree |
| Rank and numeric boundaries | 1/2-frame rejection, `magnitudeMu` floor, lambda/mu extremes, explicit overflow |
| Null behavior | finite runs are independent; short runs and low coverage produce zero-plan evidence |
| Source/Context gates | uncommitted, missing target, vibrato/non-additive, mismatch, ambiguity, and bad provenance covered |
| Transaction path | plan -> dry-run -> commit gives zero dry-run Undo and one expected user Undo |
| Compact surface | 2000-frame plan keeps dense data in Artifact and public response below 16 KiB |
| MCP contract | facade reachability, strict schema resource, invalidation policy, smoke, and root envelope covered |

Commands run:

```powershell
node --test ../test/pitch-correction-plan.test.mjs
node --test ../test/pitch-gesture-plan.test.mjs
node --test ../test/pitch-techniques-time-grid.test.mjs
node --test ../test/context-invalidation.test.mjs
node --test ../test/root-envelope.test.mjs
npm run smoke:mcp
npm test
```

Results: P3 service suite 12/12, P2 target suite 9/9, time-grid suite 6/6, invalidation suite
12/12, root-envelope suite 8/8, MCP smoke passed, and full serial suite 842/842 in 41.139 s.

## Host Scope

The correction planner path was verified with the in-memory host model and MCP's isolated smoke
bridge only. The planner itself has no host traffic; its execution test proves the existing verified
transaction opens one user Undo boundary after dry-run. No claim is made that a real Synthesizer V
project improved. T18 remains the separate live-host RC gate and requires a single restarted MCP
instance before its results can be recorded.
