# T10 Deterministic Technique Composition

Captured: `2026-08-03T15:21:43-03:00`

## Implementation

`server/src/pitch-techniques/compose.js` accepts only the exact frozen output of T09
normalization. It accepts one aligned value vector per canonical key, orders techniques by
`(priority, canonicalKey)` using code-unit comparison, and returns a deeply frozen result with a
content hash. Input and vector permutations therefore do not affect the result or its hash.

Equal-priority spans overlap only when their open intervals intersect. If either technique is
`exclusive`, composition rejects with `PLAN_CONFLICT`; endpoint contact is not an overlap. Finite
mask gaps require null contribution and baseline values and remain null in the result, so neither
aggregation nor final-pitch validation can interpolate across a gap.

The composer sums contribution vectors before applying `maxAbsCents`, reports one aggregate
`CONTRIBUTION_CLAMPED` warning, and then optionally checks captured baseline plus the clamped
contribution against the `pitchDelta` range. The latter returns
`PITCH_DELTA_RANGE_EXCEEDED` with `stage: "final"`; contribution diagnostics retain
`stage: "contribution"`.

The module is a pure P1 component: it imports no host, store, session, Artifact, MCP, or
environment API. Its 10,000-sample ceiling bounds the internal dense composition grid. The
separate public per-technique and compiled-point limits are applied by the later planner/compiler,
which is also the layer that can issue a paged Artifact instead of exposing dense details.

## Offline Measurement

| Samples | Techniques | Measured runs | Median | P95 | Gate |
|---|---:|---:|---:|---:|---|
| 10,000 | 32 | 20 | 9.542 ms | 10.971 ms | <= 50 ms |

The benchmark uses a normalized 32-technique IR and a 10,000-sample aligned vector for each
technique. It is the worst-case internal composition workload, not a public response payload.
No public schema, MCP response, or Artifact payload was added, so the public serialized-byte
change is `0`.

## Verification

| Command | Result |
|---|---|
| `node --test --test-concurrency=1 test/pitch-techniques-compose.test.mjs test/pitch-techniques-ir.test.mjs` | 15 passed |
| explicit `scripts.test` diff audit | no removals; added only `pitch-techniques-compose.test.mjs` |
| `node --test --test-concurrency=1 docs/pitch-techniques/reference/model.test.mjs docs/pitch-techniques/reference/contract.test.mjs` | 83 passed |
| `npm test` | 851 passed in 44.488 s |
| `git diff --exit-code -- api-docs` | clean |
| `git diff --check` | clean |

The focused tests cover T09 provenance enforcement, deep freezing, input and vector permutation
invariance, sum-then-clamp behavior, contribution-versus-final failure evidence through the real
MCP error encoder, null-gap isolation, exclusive conflicts, vector and dense-grid budgets, and the
20-run performance gate.

## Scope And Safety

T10 performed no host connection or call, no setter call, and no Undo record. It neither claims
nor changes H1--H8 evidence. T11 remains blocked on T08/H1 because mapping the seconds-domain
result to host points requires the unblocked uniform-seconds grid.
