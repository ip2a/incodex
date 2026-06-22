import type { JsonRecord } from "./protocol.js";
import { expandThreadListCwdFilter } from "./session-cwd-index.js";

export const GLOBAL_THREAD_LIST_LIMIT = 100;

export function normalizeThreadListParams(params: JsonRecord, sessionCwds: string[]): JsonRecord {
  if (!hasCwdFilter(params)) {
    return normalizeGlobalThreadListParams(params);
  }

  return {
    ...params,
    cwd: expandThreadListCwdFilter(params.cwd, sessionCwds),
    sourceKinds: [],
  };
}

function normalizeGlobalThreadListParams(params: JsonRecord): JsonRecord {
  if (params.cursor !== null && params.cursor !== undefined) {
    return params;
  }
  if (typeof params.limit === "number" && params.limit >= GLOBAL_THREAD_LIST_LIMIT) {
    return params;
  }

  return {
    ...params,
    limit: GLOBAL_THREAD_LIST_LIMIT,
  };
}

function hasCwdFilter(params: JsonRecord): boolean {
  return "cwd" in params && params.cwd !== null && params.cwd !== undefined;
}
