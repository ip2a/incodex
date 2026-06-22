import { randomInt, timingSafeEqual } from "node:crypto";

import type { IncodexAuthMode, IncodexConfig, IncodexOtpRotation } from "./incodex-config.js";

export interface AuthCredentials {
  key: string;
  otpCode: string;
}

export interface AuthChallenge {
  mode: IncodexAuthMode;
  requiresKey: boolean;
  requiresOtpCode: boolean;
  otpRotation: IncodexOtpRotation;
  otpTtlSeconds: number;
  otpExpiresAt: number | null;
}

export interface OtpCodeSnapshot {
  code: string;
  expiresAt: number | null;
  rotation: IncodexOtpRotation;
  ttlSeconds: number;
}

export interface AuthController {
  authorize(credentials: AuthCredentials): boolean;
  appendOpenUrlCredentials(url: URL): void;
  getChallenge(): AuthChallenge;
  getCurrentOtpCode(): OtpCodeSnapshot | null;
  isAuthRequired(): boolean;
  rotateOtpCode(): OtpCodeSnapshot | null;
}

interface OtpState {
  code: string;
  expiresAt: number | null;
}

export function createAuthController(config: IncodexConfig): AuthController {
  return new IncodexAuthController(config);
}

export function readAuthCredentialsFromUrl(url: URL): AuthCredentials {
  return {
    key: (url.searchParams.get("key") ?? url.searchParams.get("token") ?? "").trim(),
    otpCode: (url.searchParams.get("otp_code") ?? url.searchParams.get("otp") ?? "").trim(),
  };
}

export function startOtpCodeLogging(
  auth: AuthController,
  onCode: (snapshot: OtpCodeSnapshot) => void,
): () => void {
  const current = auth.getCurrentOtpCode();
  if (!current) {
    return () => {};
  }

  onCode(current);
  if (current.rotation !== "interval") {
    return () => {};
  }

  const timer = setInterval(() => {
    const next = auth.rotateOtpCode();
    if (next) {
      onCode(next);
    }
  }, current.ttlSeconds * 1000);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}

class IncodexAuthController implements AuthController {
  private otpState: OtpState | null;

  constructor(private readonly config: IncodexConfig) {
    if (this.requiresKey() && this.config.auth.key.secret.length === 0) {
      throw new Error(
        `auth.mode "${this.config.auth.mode}" requires auth.key.secret in ~/.incodex/config.toml.`,
      );
    }
    this.otpState = this.requiresOtpCode() ? this.createOtpState(Date.now()) : null;
  }

  authorize(credentials: AuthCredentials): boolean {
    if (this.config.auth.mode === "no_auth") {
      return true;
    }

    if (this.requiresKey() && !constantTimeEquals(credentials.key, this.config.auth.key.secret)) {
      return false;
    }

    if (this.requiresOtpCode()) {
      const otpState = this.getFreshOtpState();
      if (!otpState || !/^\d{6}$/.test(credentials.otpCode)) {
        return false;
      }
      if (!constantTimeEquals(credentials.otpCode, otpState.code)) {
        return false;
      }
    }

    return true;
  }

  appendOpenUrlCredentials(url: URL): void {
    if (this.requiresKey()) {
      url.searchParams.set("key", this.config.auth.key.secret);
    }
  }

  getChallenge(): AuthChallenge {
    const otpState = this.requiresOtpCode() ? this.getFreshOtpState() : null;
    return {
      mode: this.config.auth.mode,
      requiresKey: this.requiresKey(),
      requiresOtpCode: this.requiresOtpCode(),
      otpRotation: this.config.auth.otp.rotation,
      otpTtlSeconds: this.config.auth.otp.ttlSeconds,
      otpExpiresAt: otpState?.expiresAt ?? null,
    };
  }

  getCurrentOtpCode(): OtpCodeSnapshot | null {
    const otpState = this.requiresOtpCode() ? this.getFreshOtpState() : null;
    if (!otpState) {
      return null;
    }

    return {
      code: otpState.code,
      expiresAt: otpState.expiresAt,
      rotation: this.config.auth.otp.rotation,
      ttlSeconds: this.config.auth.otp.ttlSeconds,
    };
  }

  isAuthRequired(): boolean {
    return this.config.auth.mode !== "no_auth";
  }

  rotateOtpCode(): OtpCodeSnapshot | null {
    if (!this.requiresOtpCode()) {
      return null;
    }

    this.otpState = this.createOtpState(Date.now());
    return this.getCurrentOtpCode();
  }

  private getFreshOtpState(): OtpState | null {
    if (!this.otpState) {
      return null;
    }
    if (this.config.auth.otp.rotation === "interval" && this.otpState.expiresAt !== null) {
      const now = Date.now();
      if (now >= this.otpState.expiresAt) {
        this.otpState = this.createOtpState(now);
      }
    }
    return this.otpState;
  }

  private createOtpState(now: number): OtpState {
    return {
      code: randomInt(0, 1_000_000).toString().padStart(6, "0"),
      expiresAt:
        this.config.auth.otp.rotation === "interval"
          ? now + this.config.auth.otp.ttlSeconds * 1000
          : null,
    };
  }

  private requiresKey(): boolean {
    return this.config.auth.mode === "key" || this.config.auth.mode === "code_and_key";
  }

  private requiresOtpCode(): boolean {
    return this.config.auth.mode === "otp_code" || this.config.auth.mode === "code_and_key";
  }
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.byteLength !== rightBuffer.byteLength) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}
