# T07 Time-Varying Vibrato Model

Captured: `2026-08-03T14:45:12-03:00`

## Implementation

`server/src/pitch-techniques/vibrato.js` provides the seconds-domain
`integratedLinearFrequencyPhase()` and `timeVaryingVibrato()` primitives. Both use the sole
concentrated business definition in `docs/pitch-techniques/reference/model.mjs`; no duplicate
phase, fade, or numeric-error implementation was added.

The production module has no host, session, store, Artifact, MCP, environment, or native
`vibratoEnv` dependency. It therefore does not decide the H2 coexistence policy, which remains
with T04/H2 as required.

## Offline Measurements

The benchmark ran one warmup followed by 20 serial runs of 10,000 seconds-domain samples.

| Samples / run | Runs | Median | P95 | Gate |
|---:|---:|---:|---:|---:|
| 10,000 | 20 | 0.916 ms | 2.287 ms | <= 20 ms |

## Verification

| Command | Result |
|---|---|
| `node --test test/pitch-techniques-vibrato.test.mjs` | 8 passed |
| explicit `scripts.test` diff audit | no removals; added only `pitch-techniques-vibrato.test.mjs` |
| `node --test docs/pitch-techniques/reference/model.test.mjs docs/pitch-techniques/reference/contract.test.mjs` | 83 passed |
| `npm test` | 836 passed in 50.404 s |
| `git diff --exit-code -- api-docs` | clean |
| `git diff --check` | clean |

The focused production suite checks integrated-rate phase, fixed-rate zero crossings, zero-input
identity, fade normalization, center-drift continuity, 1,200 seeded finite cases, corpus replay,
and `VIBRATO_SPAN_OVERFLOW`, `VIBRATO_FADE_RESOLUTION_OVERFLOW`,
`OSCILLATORY_PHASE_OVERFLOW`, and `VIBRATO_OUTPUT_OVERFLOW` rejection paths.

## Scope And Safety

T07 changes no public schema, MCP handler, Artifact payload, or response serialization; the
serialized-byte change is `0`. It made no host connection or call, no setter call, and no Undo
record. H1 and the native-surface coexistence evidence remain independently blocked in T02/T04.
