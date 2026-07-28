import { chmodSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureHexRuntimeSecret,
  readRuntimeSecretFile,
  writeRuntimeSecretFile,
} from "./runtimeSecret.js";

describe("runtimeSecret", () => {
  const cleanup = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("creates and reuses a mode-0600 32-byte hex secret", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-runtime-secret-"));
    cleanup.push(root);
    const path = join(root, "nested/api.key");
    const first = ensureHexRuntimeSecret(path, {
      randomBytesImpl: () => Buffer.alloc(32, 0xab),
    });
    chmodSync(path, 0o644);
    const second = ensureHexRuntimeSecret(path);

    expect(first).toBe("ab".repeat(32));
    expect(second).toBe(first);
    expect(readFileSync(path, "utf8")).toBe(`${first}\n`);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(root, "nested")).mode & 0o777).toBe(0o700);
  });

  it("rejects invalid existing values and symbolic links", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-runtime-secret-"));
    cleanup.push(root);
    mkdirSync(join(root, "runtime"));
    const invalid = join(root, "runtime/invalid.key");
    writeFileSync(invalid, "not-a-secret\n");
    expect(() => ensureHexRuntimeSecret(invalid)).toThrow(/invalid/);

    const target = join(root, "target.key");
    writeFileSync(target, "cd".repeat(32));
    const link = join(root, "runtime/link.key");
    symlinkSync(target, link);
    expect(() => ensureHexRuntimeSecret(link)).toThrow(/regular file/);
  });

  it("atomically stores arbitrary runtime secrets without exposing them in configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-runtime-secret-"));
    cleanup.push(root);
    const path = join(root, "runtime/ha_token");

    expect(writeRuntimeSecretFile(path, "header.payload.signature")).toBe(path);
    expect(readRuntimeSecretFile(path)).toBe("header.payload.signature");
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    writeRuntimeSecretFile(path, "replacement");
    expect(readRuntimeSecretFile(path)).toBe("replacement");
  });
});
