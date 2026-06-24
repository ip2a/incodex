import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { deriveCodexHomePath, listCodexHomePathCandidates } from "./codex-home.js";

export interface CodexDesktopGlobalState {
  "active-workspace-roots"?: string[];
  "electron-saved-workspace-roots"?: string[];
  "electron-workspace-root-labels"?: Record<string, string>;
  "electron-persisted-atom-state"?: Record<string, unknown>;
  "pinned-thread-ids"?: string[];
  "project-order"?: string[];
  [key: string]: unknown;
}

export interface WorkspaceRootState {
  roots: string[];
  labels: Record<string, string>;
  activeRoot: string | null;
}

export function deriveCodexDesktopGlobalStatePath(): string {
  return join(deriveCodexHomePath(), ".codex-global-state.json");
}

export async function loadCodexDesktopGlobalState(): Promise<{
  found: boolean;
  path: string;
  state: CodexDesktopGlobalState;
}> {
  const defaultPath = deriveCodexDesktopGlobalStatePath();

  for (const candidatePath of listDesktopGlobalStatePathCandidates(defaultPath)) {
    try {
      const raw = await readFile(candidatePath, "utf8");
      return {
        found: true,
        path: candidatePath,
        state: parseCodexDesktopGlobalState(raw),
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      throw error;
    }
  }

  return {
    found: false,
    path: defaultPath,
    state: {},
  };
}

export async function saveCodexDesktopGlobalState(
  path: string,
  state: CodexDesktopGlobalState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${randomUUID()}`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

export function readWorkspaceRootsFromGlobalState(
  state: CodexDesktopGlobalState,
): WorkspaceRootState {
  const rawRoots = uniqueStrings(state["electron-saved-workspace-roots"]);
  const activeRoots = uniqueStrings(state["active-workspace-roots"]);
  const labels = isJsonRecord(state["electron-workspace-root-labels"])
    ? state["electron-workspace-root-labels"]
    : {};

  const roots: string[] = [];
  const seen = new Set<string>();
  for (const root of [...activeRoots, ...rawRoots]) {
    if (seen.has(root)) {
      continue;
    }
    seen.add(root);
    roots.push(root);
  }

  const activeRoot = activeRoots[0] ?? roots[0] ?? null;

  return {
    roots,
    labels: normalizeWorkspaceRootLabels(roots, labels),
    activeRoot,
  };
}

export function writeWorkspaceRootsToGlobalState(
  state: CodexDesktopGlobalState,
  roots: WorkspaceRootState,
): CodexDesktopGlobalState {
  return {
    ...state,
    "electron-saved-workspace-roots": roots.roots,
    "active-workspace-roots": roots.activeRoot ? [roots.activeRoot] : [],
    "electron-workspace-root-labels": roots.labels,
  };
}

export function readPersistedAtomsFromGlobalState(
  state: CodexDesktopGlobalState,
): Record<string, unknown> {
  const atomState = state["electron-persisted-atom-state"];
  return isJsonRecord(atomState) ? { ...atomState } : {};
}

export function writePersistedAtomsToGlobalState(
  state: CodexDesktopGlobalState,
  atoms: Record<string, unknown>,
): CodexDesktopGlobalState {
  return {
    ...state,
    "electron-persisted-atom-state": atoms,
  };
}

export function readPinnedThreadIdsFromGlobalState(state: CodexDesktopGlobalState): string[] {
  return uniqueStrings(state["pinned-thread-ids"]);
}

export async function getFileMtime(path: string): Promise<number | null> {
  try {
    const stats = await stat(path);
    return stats.mtimeMs;
  } catch {
    return null;
  }
}

export function writePinnedThreadIdsToGlobalState(
  state: CodexDesktopGlobalState,
  threadIds: string[],
): CodexDesktopGlobalState {
  return {
    ...state,
    "pinned-thread-ids": threadIds,
  };
}

function parseCodexDesktopGlobalState(raw: string): CodexDesktopGlobalState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  return isJsonRecord(parsed) ? parsed : {};
}

function normalizeWorkspaceRootLabels(
  roots: string[],
  labels: Record<string, unknown>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const root of roots) {
    const label = labels[root];
    if (typeof label === "string" && label.trim().length > 0) {
      normalized[root] = label.trim();
    }
  }
  return normalized;
}

function listDesktopGlobalStatePathCandidates(globalStatePath: string): string[] {
  const candidates = [globalStatePath];
  if (globalStatePath !== deriveCodexDesktopGlobalStatePath()) {
    return candidates;
  }

  for (const codexHome of listCodexHomePathCandidates()) {
    const candidatePath = join(codexHome, ".codex-global-state.json");
    if (!candidates.includes(candidatePath)) {
      candidates.push(candidatePath);
    }
  }

  return candidates;
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
