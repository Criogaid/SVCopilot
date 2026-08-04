# T20 Evaluation, Documentation And Release Evidence

## Release Scope

SV Copilot `0.10.0` publishes the completed pitch-technique MVP: deterministic forward planning,
host-interpolation verification, read-only technique analysis, and one independently verified
open-loop correction. The primary write surface is `pitchDelta`; `vibratoEnv` is an auxiliary
envelope. `PitchControlCurve` and bounded closed-loop calibration remain disabled capability gates,
not incomplete MVP promises.

The machine-readable release ledger is
[T20-release-evidence.json](T20-release-evidence.json). It contains only repository-relative paths,
sanitized hashes, aggregate measurements, and host selectors. It contains no project identifiers,
lyrics, host handles, artifact leases, or machine paths.

## Reproducibility

The canonical request, normalized IR, and compiler plan hashes are recomputed from a fixed synthetic
two-note Richards specimen by `test/helpers/pitch-technique-release-specimen.mjs`. The specimen calls
the production normalizer, composition layer, and `pitchDelta` compiler. The release test rejects
any drift in those hashes.

Large evidence stays outside normal MCP responses:

| Evidence | Contents | Integrity |
|---|---|---|
| T01 synthetic corpus | 20 seeded mathematical and failure cases | canonical corpus hash |
| T16 FitWorker report | uniform-seconds samples, initials, bounds, seed, fits, dense predictions, rejected candidates, performance | file SHA-256 plus Artifact content hash |
| T18 live-host RC | capture metadata, compiled/readback/residual summaries, timings, Undo, rollback and cleanup | file SHA-256 |
| host profile v2 | host selector and H1-H8 semantic evidence states | file SHA-256 plus evidence SHA-256 |

## Host Matrix

| Product | Version | Platform | PIPE | Result |
|---|---|---|---:|---|
| Synthesizer V Studio 2 Pro | 2.2.1 | Windows | 2 | accepted, 14 RC scenarios, 0 pending MVP scenarios |
| Other product/version/platform combinations | unknown | unknown | unknown | fail closed for host-semantic techniques |

Human audition remains `human_only`. Playback success and objective computed-pitch or curve metrics
are not claims that a technique sounds natural or preferable.

## Performance And Safety

The frozen T01 planner baseline was 7,090 bytes and 2.486 ms p95 for 12 notes, and 7,149 bytes and
2.588 ms p95 for 373 notes. T16 selected `node-bounded-richards/1`: 22.842 ms single-fit p95 and
261.893 ms p95 for 12 fits, with no added runtime dependency. T18 records per-operation host,
serialization, write, verification, rollback, and Artifact measurements. Aggregate live PIPE and
MCP byte percentiles were not captured and remain an explicit transport-evidence limit.

Dry-run and no-change paths use zero setters and zero Undo records. A successful multi-curve commit
uses one user Undo and independent host readback. Rollback is reverse-order and verified. An
`outcome_unknown`, `partial`, or restore-failed write must not be retried automatically: stop writes,
re-snapshot, compare the live state, and only then re-plan.

## Dependency Provenance

Production direct dependencies are `@modelcontextprotocol/sdk@1.29.0` and `ajv@8.20.0`, both MIT.
The exact transitive closure and integrity hashes are in `server/package-lock.json`; the ledger and
clean-room external reference record are in `THIRD_PARTY_NOTICES.md`. The selected fit worker adds
no runtime package.

## Validation

The release gate passed 850 serial tests, 83 independent reference-model tests, MCP smoke, both Lua
dispatcher suites at 42/42, and the 14-scenario reversible live-host RC. The final live doctor and
capabilities read reported interface `0.10.0`, matched host profile, zero Artifact entries, zero known
handles, and zero pending executions. `api-docs/` remained unchanged.
