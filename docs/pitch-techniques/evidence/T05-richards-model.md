# T05 Richards Model

Captured: `2026-08-03T14:29:22-03:00`

## Implementation

`server/src/pitch-techniques/richards.js` provides the two distinct F1 model families:

- `rawRichards(t, inflectionSeconds, steepnessPerSecond, B)` for the asymptotic
  `richards_asymptotic` unit curve.
- `richardsSegment(t, fromSeconds, toSeconds, inflectionSeconds, steepnessPerSecond, B)`
  for the endpoint-normalized `richards_segment_normalized` unit curve.

The module also exposes the reference-backed inflection and value-transition helpers needed
to preserve `RICHARDS_INFLECTION_OVERFLOW` and finite convex interpolation behavior. Its sole
business-logic dependency is `docs/pitch-techniques/reference/model.mjs`; it copies no Richards
formula and imports no host, session, store, artifact, MCP, or environment dependency.

## Offline Measurements

The benchmark ran one warmup followed by 20 serial runs of 10,000 normalized segment samples.

| Samples / run | Runs | Median | P95 | Gate |
|---:|---:|---:|---:|---:|
| 10,000 | 20 | 2.475 ms | 3.598 ms | <= 20 ms |

## Verification

| Command | Result |
|---|---|
| `node --test test/pitch-techniques-richards.test.mjs` | 8 passed |
| `node --test docs/pitch-techniques/reference/model.test.mjs docs/pitch-techniques/reference/contract.test.mjs` | 83 passed |
| `npm test` | 820 passed in 48.676 s |
| `git diff --exit-code -- api-docs` | clean |
| `git diff --check` | clean |

The focused production suite checks raw/reference parity, exact upward and downward endpoints,
inflection preservation for `B` 0.35/1/3, logistic symmetry, 1,200 seeded finite-property
cases, deterministic corpus replay, invalid/degenerate rejection, and the P95 gate.

## Scope And Safety

T05 changes no public schema, MCP handler, Artifact payload, or response serialization; the
serialized-byte change is `0`. It made no host connection or call, no setter call, and no Undo
record. There is no live-host gate in this pure F1 task; H1 remains independently blocked in T02.
