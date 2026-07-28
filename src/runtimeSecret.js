import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

export function ensureHexRuntimeSecret(path, {
  randomBytesImpl = randomBytes,
} = {}) {
  const secretPath = resolve(path);
  mkdirSync(dirname(secretPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(secretPath), 0o700);

  try {
    const stat = lstatSync(secretPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Runtime secret path must be a regular file: ${secretPath}`);
    }
    const existing = readFileSync(secretPath, "utf8").trim();
    if (!/^[a-f0-9]{64}$/i.test(existing)) {
      throw new Error(`Runtime secret is invalid: ${secretPath}`);
    }
    chmodSync(secretPath, 0o600);
    return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const secret = randomBytesImpl(32).toString("hex");
  const descriptor = openSync(secretPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${secret}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  chmodSync(secretPath, 0o600);
  return secret;
}

export function writeRuntimeSecretFile(path, value) {
  const secretPath = resolve(path);
  const directory = dirname(secretPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const existing = readExistingSecretFile(secretPath);
  const normalized = String(value || "").trim();
  if (existing === normalized) {
    chmodSync(secretPath, 0o600);
    return secretPath;
  }

  const temporary = join(
    directory,
    `.${basename(secretPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${normalized}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, secretPath);
    chmodSync(secretPath, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
  return secretPath;
}

export function readRuntimeSecretFile(path, {
  maximumBytes = 4096,
} = {}) {
  const secretPath = resolve(path);
  const stat = lstatSync(secretPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Runtime secret path must be a regular file: ${secretPath}`);
  }
  if (stat.size > maximumBytes) {
    throw new Error(`Runtime secret file is too large: ${secretPath}`);
  }
  return readFileSync(secretPath, "utf8").trim();
}

function readExistingSecretFile(path) {
  try {
    return readRuntimeSecretFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
