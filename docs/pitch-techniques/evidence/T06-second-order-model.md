# T06 Second-Order Model

Captured: `2026-08-03T14:39:06-03:00`

## Implementation

`server/src/pitch-techniques/second-order.js` provides the F2 primitives:

- `secondOrderImpulse()` and `secondOrderImpulseDerivative()` for the nonnegative damping
  domain, including undamped, underdamped, critical, and overdamped responses.
- `firstPeakAngularFactor()` for the angular-frequency peak parameterization.
- `transientFromFirstPeak()` for the v1 first-peak product boundary and its explicit tail policy.

The module preserves the fixed `TRANSIENT_TAPER_RATIO` and delegates solely to the concentrated
reference implementation. It introduces no independent branch formula, no `naturalHz`/unqualified
`gain` field, and no host, session, store, Artifact, MCP, or environment dependency.

## Verification

| Command | Result |
|---|---|
| `node --test test/pitch-techniques-second-order.test.mjs` | 8 passed |
| explicit `scripts.test` diff audit | no removals; added only `pitch-techniques-second-order.test.mjs` |
| `node --test docs/pitch-techniques/reference/model.test.mjs docs/pitch-techniques/reference/contract.test.mjs` | 83 passed |
| `npm test` | 828 passed in 49.600 s |
| `git diff --exit-code -- api-docs` | clean |
| `git diff --check` | clean |

The focused production suite covers all damping branches, onset translation, the critical
neighborhood, extreme overdamping, phase overflow, angular-unit regressions, v1 overdamping
rejection, undamped/taper/tail failure families, C1 taper behavior, no-amplification sampling,
and corpus replay for first-peak and generic impulse cases.

## Scope And Safety

T06 changes no public schema, MCP handler, Artifact payload, or response serialization; the
serialized-byte change is `0`. It made no host connection or call, no setter call, and no Undo
record. This pure F2 task has no live-host acceptance gate; H1 remains independently blocked in
T02.
