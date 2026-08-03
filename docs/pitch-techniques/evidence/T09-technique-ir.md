# T09 TechniqueIR And Canonicalization

Captured: `2026-08-03T15:05:10-03:00`

## Implementation

`server/src/pitch-techniques/ir.js` introduces the sealed v1 internal TechniqueIR boundary.
It reuses the concentrated reference numeric registry and canonicalizer, then materializes
sorted `tech_N` identities, normalized values, canonical keys, and a deeply frozen IR.

The P2 mapping is closed to `pitch_delta_contribution_cents` / `pitchDelta` /
`baseline_plus_contribution` / `replace`. It rejects mismatches with
`REFERENCE_FRAME_SURFACE_MISMATCH`; the H3/H4-gated `PitchControlCurve` path remains unavailable
for T14. The target requires the captured baseline fingerprint, profile hash, and per-parameter
interpolation evidence. Missing evidence returns `CAPTURE_EVIDENCE_REQUIRED` with directly usable
`sv_snapshot_range` arguments. A vibrato IR requires both `pitchDelta` and `vibratoEnv` evidence.

## Offline Measurement

The documented single-portamento F5-shaped IR normalized to `1,200` UTF-8 bytes. This is below the
8 KiB inline TechniqueIR budget. T09 adds no public schema, MCP response, or Artifact payload, so
the public serialized-byte change is `0`.

## Verification

| Command | Result |
|---|---|
| `node --test --test-concurrency=1 test/pitch-techniques-ir.test.mjs` | 8 passed |
| explicit `scripts.test` diff audit | no removals; added only `pitch-techniques-ir.test.mjs` |
| `node --test --test-concurrency=1 docs/pitch-techniques/reference/model.test.mjs docs/pitch-techniques/reference/contract.test.mjs` | 83 passed |
| `npm test` | 844 passed in 51.898 s |
| `git diff --exit-code -- api-docs` | clean |
| `git diff --check` | clean |

The focused suite proves registry identity, post-quantization canonical IDs, deep freezing,
same-kind/same-span parameter permutation stability, duplicate and unknown-numeric evidence,
real MCP encoder projection, safe-integer pointers, strict IR closure, P2 reference-frame sealing,
and both non-vibrato and vibrato capture prerequisites.

## Scope And Safety

T09 is pure offline normalization. It made no host connection or call, no setter call, and no Undo
record. It does not claim H1, H2, H3, or H4 host evidence; T02/T04 remain independently blocked,
and T14 stays conditional.
