import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { parse } from "smol-toml";

export type IncodexServerAccess = "local" | "lan";
export type IncodexAuthMode = "no_auth" | "otp_code" | "key" | "code_and_key";
export type IncodexOtpRotation = "startup" | "interval";

export interface IncodexConfig {
  server: {
    access: IncodexServerAccess;
  };
  auth: {
    mode: IncodexAuthMode;
    otp: {
      rotation: IncodexOtpRotation;
      ttlSeconds: number;
    };
    key: {
      secret: string;
    };
  };
}

export interface LoadedIncodexConfig {
  config: IncodexConfig;
  configPath: string;
  created: boolean;
}

const DEFAULT_OTP_TTL_SECONDS = 300;
const MIN_OTP_TTL_SECONDS = 30;
const MAX_OTP_TTL_SECONDS = 86_400;

const DEFAULT_CONFIG: IncodexConfig = {
  server: {
    access: "local",
  },
  auth: {
    mode: "no_auth",
    otp: {
      rotation: "startup",
      ttlSeconds: DEFAULT_OTP_TTL_SECONDS,
    },
    key: {
      secret: "",
    },
  },
};

export function deriveIncodexConfigPath(): string {
  return join(homedir(), ".incodex", "config.toml");
}

export async function loadIncodexConfig(
  configPath = deriveIncodexConfigPath(),
): Promise<LoadedIncodexConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    return {
      config: parseIncodexConfig(raw, configPath),
      configPath,
      created: false,
    };
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }

    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, renderDefaultIncodexConfig(), "utf8");
    return {
      config: cloneDefaultConfig(),
      configPath,
      created: true,
    };
  }
}

export function applySecurityKeyOverride(
  config: IncodexConfig,
  securityKey: string | null,
): IncodexConfig {
  const trimmedKey = securityKey?.trim() ?? "";
  if (!trimmedKey) {
    return config;
  }

  const next = cloneConfig(config);
  next.auth.key.secret = trimmedKey;
  if (next.auth.mode === "no_auth") {
    next.auth.mode = "key";
  } else if (next.auth.mode === "otp_code") {
    next.auth.mode = "code_and_key";
  }
  return next;
}

export function resolveListenHostForAccess(access: IncodexServerAccess): string {
  return access === "lan" ? "0.0.0.0" : "127.0.0.1";
}

function parseIncodexConfig(raw: string, configPath: string): IncodexConfig {
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new Error(`Invalid Incodex config at ${configPath}: ${normalizeErrorMessage(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`Invalid Incodex config at ${configPath}: expected a top-level table.`);
  }

  const server = isRecord(parsed.server) ? parsed.server : {};
  const auth = isRecord(parsed.auth) ? parsed.auth : {};
  const otp = isRecord(auth.otp) ? auth.otp : {};
  const key = isRecord(auth.key) ? auth.key : {};

  return {
    server: {
      access: readStringEnum(
        server.access,
        DEFAULT_CONFIG.server.access,
        ["local", "lan"],
        "server.access",
        configPath,
      ),
    },
    auth: {
      mode: readStringEnum(
        auth.mode,
        DEFAULT_CONFIG.auth.mode,
        ["no_auth", "otp_code", "key", "code_and_key"],
        "auth.mode",
        configPath,
      ),
      otp: {
        rotation: readStringEnum(
          otp.rotation,
          DEFAULT_CONFIG.auth.otp.rotation,
          ["startup", "interval"],
          "auth.otp.rotation",
          configPath,
        ),
        ttlSeconds: readPositiveInteger(
          otp.ttl_seconds,
          DEFAULT_CONFIG.auth.otp.ttlSeconds,
          "auth.otp.ttl_seconds",
          configPath,
        ),
      },
      key: {
        secret: typeof key.secret === "string" ? key.secret.trim() : DEFAULT_CONFIG.auth.key.secret,
      },
    },
  };
}

function readStringEnum<TValue extends string>(
  value: unknown,
  defaultValue: TValue,
  allowedValues: readonly TValue[],
  fieldName: string,
  configPath: string,
): TValue {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid Incodex config at ${configPath}: ${fieldName} must be a string.`);
  }

  const normalized = value.trim();
  if (allowedValues.includes(normalized as TValue)) {
    return normalized as TValue;
  }

  throw new Error(
    `Invalid Incodex config at ${configPath}: ${fieldName} must be one of ${allowedValues.join(", ")}.`,
  );
}

function readPositiveInteger(
  value: unknown,
  defaultValue: number,
  fieldName: string,
  configPath: string,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Invalid Incodex config at ${configPath}: ${fieldName} must be an integer.`);
  }
  if (value < MIN_OTP_TTL_SECONDS || value > MAX_OTP_TTL_SECONDS) {
    throw new Error(
      `Invalid Incodex config at ${configPath}: ${fieldName} must be between ${MIN_OTP_TTL_SECONDS} and ${MAX_OTP_TTL_SECONDS}.`,
    );
  }
  return value;
}

function renderDefaultIncodexConfig(): string {
  return `# Incodex configuration

[server]
# local = 127.0.0.1 only, lan = 0.0.0.0 for local network access.
access = "local"

[auth]
# no_auth | otp_code | key | code_and_key
mode = "no_auth"

[auth.otp]
# startup | interval
rotation = "startup"
ttl_seconds = ${DEFAULT_OTP_TTL_SECONDS}

[auth.key]
secret = ""
`;
}

function cloneDefaultConfig(): IncodexConfig {
  return cloneConfig(DEFAULT_CONFIG);
}

function cloneConfig(config: IncodexConfig): IncodexConfig {
  return {
    server: {
      access: config.server.access,
    },
    auth: {
      mode: config.auth.mode,
      otp: {
        rotation: config.auth.otp.rotation,
        ttlSeconds: config.auth.otp.ttlSeconds,
      },
      key: {
        secret: config.auth.key.secret,
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
