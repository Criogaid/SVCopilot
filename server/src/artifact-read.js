import { MAX_ARTIFACT_PAGE_BYTES } from "./artifact-store.js";
import { encodeToolResult, measureToolEnvelope } from "./mcp-result-encoder.js";
import { COMPACT_MAX_BYTES } from "./response-budget.js";

/**
 * 读取一个短 offset 页面，并按最终 MCP tool envelope 动态选择正文大小。
 */
export function readArtifactOffsetPage({ artifactStore, sessionId, artifactId, offset = 0 }) {
  const { artifact, page: window } = artifactStore.readOffsetPage({
    artifactId,
    sessionId,
    offset,
    byteBudget: MAX_ARTIFACT_PAGE_BYTES,
  });
  const windowBytes = Buffer.from(window.text, "utf8");
  const boundaries = utf8EndBoundaries(windowBytes);
  let lower = 0;
  let upper = boundaries.length - 1;
  let best = null;

  while (lower <= upper) {
    const boundaryIndex = Math.floor((lower + upper) / 2);
    const bytesReturned = boundaries[boundaryIndex];
    const page = {
      text: windowBytes.subarray(0, bytesReturned).toString("utf8"),
      nextOffset:
        window.done && bytesReturned === windowBytes.length ? null : offset + bytesReturned,
      done: window.done && bytesReturned === windowBytes.length,
    };
    const response = pageResponse(artifact, page);
    const envelopeBytes = measureToolEnvelope(encodeToolResult(response)).envelopeUtf8Bytes;
    if (envelopeBytes <= COMPACT_MAX_BYTES) {
      best = response;
      lower = boundaryIndex + 1;
    } else {
      upper = boundaryIndex - 1;
    }
  }

  if (!best) {
    const error = new Error("artifact page cannot fit the compact MCP response budget");
    error.code = "ARTIFACT_PAGE_BUDGET_TOO_SMALL";
    throw error;
  }
  return best;
}

function utf8EndBoundaries(value) {
  const boundaries = [];
  for (let end = 1; end <= value.length; end += 1) {
    if (end === value.length || (value[end] & 0xc0) !== 0x80) boundaries.push(end);
  }
  return boundaries;
}

function pageResponse(artifact, page) {
  return {
    status: "succeeded",
    data: {
      text: page.text,
      ...(page.nextOffset === null ? {} : { nextOffset: page.nextOffset }),
      done: page.done,
      ...(page.done ? { contentHash: artifact.contentHash } : {}),
    },
  };
}
