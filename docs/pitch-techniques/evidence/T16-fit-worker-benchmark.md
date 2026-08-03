# T16 FitWorker Benchmark And Selection

Captured: `2026-08-03T16:10:25-03:00`

## Scope

T16 establishes the internal F8 FitWorker protocol and selects an implementation without adding
an MCP operation, a host write path, or a worker path to MCP, PIPE, handles, session state, or
Artifact storage. Workers receive strict canonical request objects only; Node revalidates bounds,
finite values, forward metrics, and identifiability before a result can be used by a later layer.

`server/src/pitch-techniques/fit-worker.js` provides the protocol validator, deterministic bounded
Richards fitter, result revalidator, and content hash. `tools/fit-worker-scipy.py` is a persistent
JSON-lines SciPy comparison adapter used only by the benchmark. Neither is a public surface.

Changed files are `server/src/pitch-techniques/fit-worker.js`,
`tools/lib/fit-worker-benchmark.mjs`, `tools/benchmark-fit-workers.mjs`,
`tools/fit-worker-scipy.py`, `test/pitch-techniques-fit-worker.test.mjs`, `server/package.json`,
this evidence pair, and the T16 task record.

## Common Measurement Contract

Every candidate consumed identical protocol v1 requests derived from the concentrated T01 corpus:

| Set | Cases | Expected outcome |
|---|---:|---|
| clean | 2 | recover Richards parameters and canonical forward curve |
| noisy/null | 2 | recover under Huber loss with masked samples |
| degenerate | 2 | structured rejection, no hang, no NaN |

The corpus hash was `sha256_8a214e57d33bac9ed6e94235880ca857258a2944b92990160387efdeb70bc484`.
Each candidate ran 20 warmups and 20 measured repetitions. Phrase timing fits 12 adjacent segments
per measured repetition. The fixed gates are clean and noisy recovery at least 95%, canonical
forward parity at most `1e-9` cents, single-fit p95 at most 100 ms, and phrase p95 at most 1500 ms.

## Results

| Candidate | Startup | Single median / p95 | Phrase median / p95 | Clean forward max | Clean | Noisy/null | Degenerate | Decision |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `node-bounded-richards` | 0 ms | 22.065 / 22.842 ms | 245.993 / 261.893 ms | `9.095e-13` cents | 100% | 100% | 100% reject | selected |
| `scipy-least-squares` | 587.857 ms | 137.605 / 143.785 ms | 1563.931 / 1691.443 ms | `1.819e-12` cents | 100% | 100% | 100% reject | rejected |

Both candidates replayed deterministically and had maximum clean pointwise deviation from the
canonical Node forward model at or below `1e-9` cents. The Node candidate also demonstrated a
structured timeout followed by a successful subsequent request.
SciPy exceeds both latency gates. It is additionally benchmark-only: it has no automated
Windows/macOS package path in this repository and no completed third-party NOTICE entry. Local
SciPy metadata identifies a multi-component redistributable bundle, so it remains ineligible until
a pinned distributable and full notice ledger exist.

The selected Node path adds `0` runtime packages and `0` runtime bytes. The local SciPy comparison
path requires NumPy and SciPy: `32,833,850` and `120,213,371` bytes respectively (`153,047,221`
bytes total). Those bytes are measurement evidence only, not a production dependency declaration.

`rust-or-wasm` was not benchmarked because this repository has neither a pinned implementation nor
a distributable artifact. Node adds no runtime dependency or installer; its packaging result is an
inheritance of the existing Node package rather than a new cross-platform distribution claim. Its
in-process crash-isolation gate is explicitly not applicable because it does not introduce a child
worker process.

The selection is therefore `node-bounded-richards`: it is the only candidate that passes all fixed
quality, deterministic replay, timeout, latency, packaging, and license gates without extending the
production dependency or NOTICE surface.

## Artifact And Environment

The complete machine-readable report is
[T16-fit-worker-benchmark.json](T16-fit-worker-benchmark.json). It records every case, gate,
environment field, candidate status, and the sealed benchmark Artifact:

| Field | Value |
|---|---|
| Artifact kind | `fit-worker-benchmark` |
| Artifact schema | `1` |
| Artifact content hash | `sha256_166734bfbcbcfd4c219b0bd4baba5dce41cbd3dbb09b878a329b704457aea0a1` |
| Artifact payload | 6,937 bytes |
| Node | `v24.16.0` |
| Python / SciPy | `3.12.6` / `1.16.1` |
| Platform | `win32-x64` |
| CPU | `12th Gen Intel(R) Core(TM) i9-12900KS`, 24 logical cores |
| Memory | 68,472,627,200 bytes |

The benchmark test seals a real ArtifactStore record, but the selected Node implementation has no
public schema, MCP response, or persisted production Artifact change. Its public serialized-byte
change is therefore `0`; the benchmark Artifact is under the existing direct-payload budget and
needs no paging projection.

## Verification

| Command | Result |
|---|---|
| `node --test --test-concurrency=1 ../test/pitch-techniques-fit-worker.test.mjs` | 5 passed |
| explicit `scripts.test` diff audit | no removals; added only `pitch-techniques-fit-worker.test.mjs` |
| `node --test --test-concurrency=1 ../docs/pitch-techniques/reference/model.test.mjs ../docs/pitch-techniques/reference/contract.test.mjs` | 83 passed |
| `npm test` | 856 passed in 45.658 s |
| `npm run bench:fit-workers -- --write-report ../docs/pitch-techniques/evidence/T16-fit-worker-benchmark.json` | selected `node-bounded-richards` |
| `git diff --exit-code -- api-docs` | clean |
| `git diff --check` | clean |

The focused tests cover strict closed-shape protocol validation, pure-module import boundaries,
finite and bounded request rejection, deterministic clean recovery, Huber recovery with nulls,
degenerate structured rejection, timeout recovery, non-actionable iteration limits, canonical metric
revalidation, common benchmark inputs, and ArtifactStore sealing.

## Scope And Safety

T16 made no host connection or call, no setter call, and no Undo record. It neither claims nor
changes H1--H8 evidence. Although T16 unlocks the FitWorker choice, T17 remains blocked on
T08/H1 because it also requires the unblocked uniform-seconds grid.
