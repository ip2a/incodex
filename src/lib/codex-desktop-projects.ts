import { stat } from "node:fs/promises";
import { basename } from "node:path";
import process from "node:process";

import {
  deriveCodexDesktopGlobalStatePath,
  loadCodexDesktopGlobalState,
  type CodexDesktopGlobalState,
} from "./codex-global-state.js";

export interface CodexDesktopProject {
  root: string;
  label: string;
  active: boolean;
  available: boolean;
}

export interface LoadedCodexDesktopProjects {
  found: boolean;
  path: string;
  projects: CodexDesktopProject[];
}

export async function loadCodexDesktopProjects(
  globalStatePath?: string,
): Promise<LoadedCodexDesktopProjects> {
  const defaultPath = globalStatePath ?? deriveCodexDesktopGlobalStatePath();
  const loaded = await loadCodexDesktopGlobalState();

  if (!loaded.found) {
    return {
      found: false,
      path: defaultPath,
      projects: [],
    };
  }

  const projects = await parseCodexDesktopProjects(loaded.state);
  return {
    found: true,
    path: loaded.path,
    projects,
  };
}

async function parseCodexDesktopProjects(
  state: CodexDesktopGlobalState,
): Promise<CodexDesktopProject[]> {
  const roots = uniqueStrings(state["electron-saved-workspace-roots"]);
  const activeRoots = new Set(uniqueStrings(state["active-workspace-roots"]));
  const labels = isJsonRecord(state["electron-workspace-root-labels"])
    ? state["electron-workspace-root-labels"]
    : {};
  const projectsByRoot = new Map<
    string,
    {
      active: boolean;
      label: unknown;
    }
  >();

  for (const rawRoot of roots) {
    const root = normalizeDesktopProjectRoot(rawRoot);
    const existingProject = projectsByRoot.get(root);
    projectsByRoot.set(root, {
      active:
        (existingProject?.active ?? false) || activeRoots.has(rawRoot) || activeRoots.has(root),
      label: existingProject?.label ?? labels[rawRoot] ?? labels[root],
    });
  }

  return Promise.all(
    Array.from(projectsByRoot.entries()).map(async ([root, project]) => ({
      root,
      label: resolveDesktopProjectLabel(root, project.label),
      active: project.active,
      available: await isDirectory(root),
    })),
  );
}

function resolveDesktopProjectLabel(root: string, label: unknown): string {
  return typeof label === "string" && label.trim().length > 0
    ? label.trim()
    : basename(root) || "Project";
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

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeDesktopProjectRoot(root: string): string {
  const normalizedWslUncPath = convertWslUncPathToLinux(root);
  if (normalizedWslUncPath) {
    return normalizedWslUncPath;
  }

  return convertWindowsPathToWsl(root);
}

function convertWindowsPathToWsl(path: string): string {
  if (!isRunningInWsl()) {
    return path;
  }

  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (!match) {
    return path;
  }

  const driveLetter = match[1].toLowerCase();
  const relativePath = match[2].replaceAll("\\", "/");
  return `/mnt/${driveLetter}/${relativePath}`;
}

function convertWslUncPathToLinux(path: string): string | null {
  if (!isRunningInWsl()) {
    return null;
  }

  const lowerCasePath = path.toLowerCase();
  let prefixLength = 0;
  if (lowerCasePath.startsWith("\\\\wsl$\\")) {
    prefixLength = "\\\\wsl$\\".length;
  } else if (lowerCasePath.startsWith("\\\\wsl.localhost\\")) {
    prefixLength = "\\\\wsl.localhost\\".length;
  } else {
    return null;
  }

  const segments = path
    .slice(prefixLength)
    .split("\\")
    .filter((segment) => segment.length > 0);
  const distroName = segments.shift();
  const currentDistroName = process.env.WSL_DISTRO_NAME?.trim().toLowerCase();
  if (!distroName) {
    return null;
  }
  if (currentDistroName && distroName.toLowerCase() !== currentDistroName) {
    return null;
  }

  return `/${segments.join("/")}`;
}

function isRunningInWsl(): boolean {
  return (
    process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
  );
}
