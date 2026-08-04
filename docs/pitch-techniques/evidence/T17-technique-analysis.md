# T17 Technique Analysis

Captured: `2026-08-04T03:19:32-03:00`

## Scope

T17 adds the conditional P5 read-only operation `sv_read/analyze_pitch_techniques`. It consumes
only note fingerprints and computed-pitch frames already stored in a range Context. It does not
create a host session, take a coordinator lock, call a setter, open an Undo record, or make a PIPE
request. The operation maps captured BLICK samples through the verified TimeAxis into a uniform
seconds grid, preserves null fragmentation, and seals dense evidence as an immutable Artifact.

The public request has the strict closed shape:

```json
{
  "contextId": "ctx_...",
  "occurrence": 0,
  "maxCandidates": 12
}
```

`contextId` is required; `occurrence` is an optional ordinal; `maxCandidates` is an integer from
1 through 32. There are no aliases or implicit capture fallbacks. The guide directs callers to
capture `notes` and `computedPitch`, wait and recapture when evidence is pending, and treat all
confidence values as uncalibrated heuristics rather than listening or quality judgments.

## Analysis Contract

The implementation follows the T17 pipeline in the implementation plan:

```text
captured computed pitch -> uniform seconds -> score-relative cents/null mask
  -> per-note vibrato candidate and flattening
  -> score-informed adjacent Richards windows
  -> bounded first-peak transient windows
  -> non-overlap model evaluation -> reconstruction and residual metrics
```

Transition fitting uses the selected T16 `node-bounded-richards` protocol. Every fit request carries
a deterministic request id and seed derived from canonical input; raw solver response, revalidation
hash, termination, and rejection evidence remain in the Artifact. Candidate selection rejects
overlapping nonlinear structural models instead of assigning a false exact interpretation.

Successful empty analysis is represented as `data.summary.analysisStatus` equal to
`no_technique_candidate` with reason `NO_TECHNIQUE_CANDIDATE`; the MCP root status remains the
existing matrix value `succeeded`. Missing capture, incomplete provenance, all-null/pending input,
low coverage, and coarse sampling fail before a parameter is invented. Model and worker failures
are retained as bounded rejected evidence so a valid independent candidate is not hidden by an
unrelated failed window.

## Oracle And Tests

`docs/pitch-techniques/reference/analysis.mjs` is the concentrated P5 synthetic oracle. It creates
deterministic 120 BPM / 80 Hz BLICK-aligned cases for:

| Case | Ground truth | Service assertion |
|---|---|---|
| Richards transition | 60 -> 62 over 0.75--1.25 s | inflection and sharpness recovery |
| Steady vibrato | 5.5 Hz, 0.30 semitone depth | rate and depth recovery |
| First-peak transient | +0.35 semitone, 62.5 ms, damping 0.5422 | overshoot amplitude and damping recovery |
| Mixed transition + vibrato | 3-second phrase | both candidate families remain explainable |

The service-level suite also proves full-null, fragmented, low-rate, missing-capture, incomplete
provenance, invalid detune, unknown request fields, deterministic analysis hashes, Artifact paging,
FitWorker unavailable/timeout/iteration-limit evidence, endpoint non-identifiability, response
projection, and a no-host-write SnapshotStore proxy boundary.

## Size Measurements

The following read-only measurement used alternating 60/62-note synthetic ranges at 80 Hz with
`maxCandidates:12`. `structuredBytes` is the UTF-8 byte length of MCP `structuredContent` after
the normal result encoder; the Artifact contains dense traces and therefore deliberately grows with
the range.

| Range | Structured response | Artifact payload | Candidate count | Result |
|---|---:|---:|---:|---|
| 12 notes | 3,809 bytes | 28,194 bytes | 0 | compact response; Artifact paging required |
| 373 notes | 4,013 bytes | 210,637 bytes | 0 | compact response; Artifact paging required |

Neither compact response contains `dense`, `contribution`, a full solver trace, or a full rejected
candidate list. The 373-note response stays below the 16 KiB hard compact-surface budget.

## Verification

| Command | Result |
|---|---|
| `node --test ../docs/pitch-techniques/reference/analysis.test.mjs` | 2 passed |
| `node --test ../test/pitch-technique-analysis.test.mjs` | 7 passed |
| `node --test ../test/workflow-guide.test.mjs ../test/compact-facade.test.mjs` | 28 passed |
| `npm run smoke:mcp` | passed; facade, schema resource, handler preconditions, and simulated PIPE smoke passed |
| `npm test` | 827 passed in 36.807 s |
| `git diff --check` | clean |

The full suite also mechanically required the operation's Context invalidation policy and
SurfaceIoPolicy. Both classify T17 as `scope:none` and `hostTraffic:none`.

## Scope And Safety

This is offline computed-pitch analysis, not real-host pitch-technique acceptance. It makes no
claim about H2--H8 or listening quality, makes no write, and produces no Undo record. Live T18
verification remains blocked until the required write/correction work is complete and the user has
restarted into one single MCP instance that advertises `analyze_pitch_techniques`.
