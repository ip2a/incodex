import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

export async function listCodexSessionCwds(sessionsRoot: string): Promise<string[]> {
  const files = await listCodexSessionFiles(sessionsRoot);
  const cwds = new Set<string>();

  await Promise.all(
    files.map(async (file) => {
      const cwd = await readCodexSessionCwd(file);
      if (cwd) {
        cwds.add(cwd);
      }
    }),
  );

  return Array.from(cwds);
}

export function expandThreadListCwdFilter(
  cwdFilter: unknown,
  sessionCwds: string[],
): string | string[] | null | undefined | unknown[] {
  const roots = readCwdFilterValues(cwdFilter);
  if (roots.length === 0) {
    return cwdFilter as string | string[] | null | undefined | unknown[];
  }

  const expanded = new Set(roots);
  for (const root of roots) {
    for (const cwd of sessionCwds) {
      if (isSameOrChildPath(cwd, root)) {
        expanded.add(cwd);
      }
    }
  }

  return Array.from(expanded);
}

async function listCodexSessionFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(entryPath);
          return;
        }

        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(entryPath);
        }
      }),
    );
  }

  await visit(root);
  return files;
}

async function readCodexSessionCwd(file: string): Promise<string | null> {
  let raw = "";
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const cwd = readCwdFromSessionRecord(parsed);
    if (cwd) {
      return cwd;
    }
  }

  return null;
}

function readCwdFromSessionRecord(record: unknown): string | null {
  if (!isJsonRecord(record) || !isJsonRecord(record.payload)) {
    return null;
  }

  const cwd = record.payload.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
}

function readCwdFilterValues(cwdFilter: unknown): string[] {
  if (typeof cwdFilter === "string" && cwdFilter.length > 0) {
    return [cwdFilter];
  }

  if (!Array.isArray(cwdFilter)) {
    return [];
  }

  const values = new Set<string>();
  for (const value of cwdFilter) {
    if (typeof value === "string" && value.length > 0) {
      values.add(value);
    }
  }
  return Array.from(values);
}

function isSameOrChildPath(path: string, parentPath: string): boolean {
  const relativePath = relative(parentPath, path);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
