import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const firmwareRoot = resolve(process.env.STACKCHAN_FIRMWARE_ROOT || resolve(repoRoot, "../stackchan-jarvis-firmware/firmware"));
const buildDir = resolve(process.env.STACKCHAN_BUILD_DIR || resolve(firmwareRoot, "build-xiaohei-local"));
const devicePort = process.env.STACKCHAN_PORT || "/dev/cu.usbmodem31201";
const idfExport = process.env.IDF_EXPORT || "/Users/jerf/esp/esp-idf-v5.5.4/export.sh";
const backupPath = process.env.STACKCHAN_FULLFLASH_BACKUP || "/Users/jerf/Documents/stackchan-firmware-backups/stackchan-fullflash-16mb-20260705-211317.bin";
const expectedBackupSha256 = process.env.STACKCHAN_FULLFLASH_BACKUP_SHA256 || "bf0d8b35e0431e3a16abbea730df090dbc197e96d985c6548c0a3c6ab4db4825";
const expectedAppSha256 = process.env.STACKCHAN_APP_SHA256 || "04303c0060f39a7226317b482e7a1a00ab8947296151d3e3aee84018e15dada1";
const expectedAssetsSha256 = process.env.STACKCHAN_ASSETS_SHA256 || "ccd7d1ef488aa07eb4f5c982084db9515bc902f588c6c3ba2ec193070315cbfe";
const appPartitionBytes = Number(process.env.STACKCHAN_APP_PARTITION_BYTES || 0x4f0000);
const assetsPartitionBytes = Number(process.env.STACKCHAN_ASSETS_PARTITION_BYTES || 5 * 1024 * 1024);

const command = process.argv[2] || "preflight";
if (!["preflight", "device-check", "flash", "rollback"].includes(command)) {
  die(`Unknown command: ${command}. Use preflight, device-check, flash, or rollback.`);
}

if (command === "preflight") {
  await preflight();
}
if (command === "device-check") {
  await deviceCheck();
}
if (command === "flash") {
  requireFlashApproval();
  await preflight();
  await deviceCheck();
  flashCandidate();
}
if (command === "rollback") {
  requireRollbackApproval();
  await preflight({ requireCandidate: false });
  await deviceCheck();
  rollbackFullFlash();
}

async function preflight({ requireCandidate = true } = {}) {
  const checks = [];
  const errors = [];

  addFileCheck(checks, errors, "Firmware root", firmwareRoot, "directory");
  addFileCheck(checks, errors, "Full-flash backup", backupPath, "file");
  if (existsSync(backupPath)) {
    const backup = inspectFile(backupPath);
    checks.push(`Backup size: ${backup.size} bytes`);
    if (backup.size !== 16 * 1024 * 1024) errors.push(`Backup is not 16MB: ${backupPath}`);
    checks.push(`Backup SHA-256: ${backup.sha256}`);
    if (expectedBackupSha256 && backup.sha256 !== expectedBackupSha256) {
      errors.push("Backup SHA-256 does not match the recorded factory backup.");
    }
  }

  if (requireCandidate) inspectCandidate(checks, errors);

  if (errors.length) {
    console.error(errors.map((item) => `ERROR: ${item}`).join("\n"));
    process.exit(1);
  }

  console.log(checks.map((item) => `OK: ${item}`).join("\n"));
  console.log("");
  console.log("Preflight passed. No device read or flash write was performed.");
  console.log("Read-only USB device check: npm run stackchan:firmware:device-check");
  console.log("Flash requires command `npm run stackchan:firmware:flash` plus:");
  console.log("  JARVIS_STACKCHAN_FLASH_APPROVED=I_UNDERSTAND_THIS_WRITES_DEVICE");
}

async function deviceCheck() {
  const checks = [];
  const errors = [];

  if (!existsSync(devicePort)) {
    errors.push(`StackChan serial port is missing: ${devicePort}`);
  } else {
    checks.push(`Device port exists: ${devicePort}`);
  }

  if (existsSync(devicePort)) {
    const chipId = runIdfCommand(`python -m esptool --chip esp32s3 --port ${shellQuote(devicePort)} --baud 115200 chip_id`, { allowFailure: true });
    checks.push("chip_id read attempted.");
    if (!chipId.ok) errors.push(`chip_id failed: ${chipId.output}`);
    else {
      requireOutput(chipId.output, /ESP32-S3/, "chip_id did not report ESP32-S3", errors);
      requireOutput(chipId.output, /MAC:\s*80:45:6b:4d:da:d0/i, "chip_id MAC did not match the allowlisted StackChan.", errors);
    }

    const flashId = runIdfCommand(`python -m esptool --chip esp32s3 --port ${shellQuote(devicePort)} --baud 115200 flash_id`, { allowFailure: true });
    checks.push("flash_id read attempted.");
    if (!flashId.ok) errors.push(`flash_id failed: ${flashId.output}`);
    else requireOutput(flashId.output, /Detected flash size:\s*16MB/i, "flash_id did not report 16MB flash.", errors);
  }

  if (errors.length) {
    console.error(errors.map((item) => `ERROR: ${item}`).join("\n"));
    process.exit(1);
  }

  console.log(checks.map((item) => `OK: ${item}`).join("\n"));
  console.log("");
  console.log("Device check passed. No flash write was performed.");
}

function inspectCandidate(checks, errors) {
  const sdkconfig = resolve(buildDir, "config/sdkconfig.h");
  const appBin = resolve(buildDir, "stack-chan.bin");
  const assetsBin = resolve(buildDir, "generated_assets.bin");
  const flashArgs = resolve(buildDir, "flash_args");

  addFileCheck(checks, errors, "Firmware candidate sdkconfig.h", sdkconfig, "file");
  addFileCheck(checks, errors, "Firmware app binary", appBin, "file");
  addFileCheck(checks, errors, "Firmware assets binary", assetsBin, "file");
  addFileCheck(checks, errors, "Firmware flash_args", flashArgs, "file");

  if (existsSync(sdkconfig)) {
    const config = readFileSync(sdkconfig, "utf8");
    requireOutput(config, /CONFIG_USE_CUSTOM_WAKE_WORD 1/, "Candidate does not enable custom wake word.", errors);
    requireOutput(config, /CONFIG_CUSTOM_WAKE_WORD "xiao hei"/, "Candidate wake word is not xiao hei.", errors);
    requireOutput(config, /CONFIG_CUSTOM_WAKE_WORD_DISPLAY "小黑"/, "Candidate wake-word display is not 小黑.", errors);
    requireOutput(config, /CONFIG_CUSTOM_WAKE_WORD_THRESHOLD 10/, "Candidate wake-word threshold is not the Jarvis sensitivity value 10.", errors);
    requireOutput(config, /CONFIG_SR_MN_CN_MULTINET7_QUANT 1/, "Candidate does not include Chinese MultiNet7.", errors);
    requireOutput(config, /CONFIG_OTA_URL "http:\/\/192\.168\.31\.99:8003\/xiaozhi\/ota\/"/, "Candidate OTA URL is not the current local Xiaozhi endpoint.", errors);
    checks.push("Candidate sdkconfig.h contains 小黑 + local OTA settings.");
  }

  if (existsSync(appBin)) {
    const app = inspectFile(appBin);
    checks.push(`App binary size: ${app.size} bytes`);
    checks.push(`App binary SHA-256: ${app.sha256}`);
    if (app.size >= appPartitionBytes) errors.push(`App binary exceeds app partition: ${app.size} >= ${appPartitionBytes}`);
    if (expectedAppSha256 && app.sha256 !== expectedAppSha256) errors.push("App binary SHA-256 changed from the recorded candidate.");
    if (!readFileSync(appBin).includes(Buffer.from("Jarvis firmware forcing AI Agent start on boot"))) {
      errors.push("App binary does not contain the Jarvis AI Agent auto-start marker.");
    } else {
      checks.push("App binary contains the Jarvis AI Agent auto-start marker.");
    }
    if (readFileSync(appBin).includes(Buffer.from("head touch starts xiaozhi manual listening"))) {
      errors.push("App binary still contains the Jarvis head-touch manual-start marker.");
    } else {
      checks.push("App binary confirms head-touch manual-start is disabled.");
    }
    if (readFileSync(appBin).includes(Buffer.from("head touch stops xiaozhi manual listening"))) {
      errors.push("App binary still contains the Jarvis head-touch manual-stop marker.");
    } else {
      checks.push("App binary confirms head-touch manual-stop is disabled.");
    }
  }

  if (existsSync(assetsBin)) {
    const assets = inspectFile(assetsBin);
    checks.push(`Assets binary size: ${assets.size} bytes`);
    checks.push(`Assets binary SHA-256: ${assets.sha256}`);
    if (assets.size >= assetsPartitionBytes) errors.push(`Assets binary exceeds assets partition: ${assets.size} >= ${assetsPartitionBytes}`);
    if (expectedAssetsSha256 && assets.sha256 !== expectedAssetsSha256) errors.push("Assets binary SHA-256 changed from the recorded candidate.");
  }
}

function flashCandidate() {
  console.log("Writing StackChan candidate firmware. Do not unplug the device.");
  const result = runIdfCommand(
    `python -m esptool --chip esp32s3 --port ${shellQuote(devicePort)} -b 460800 --before default_reset --after hard_reset write_flash @flash_args`,
    { cwd: buildDir, allowFailure: true },
  );
  if (!result.ok) die(result.output);
  console.log(result.output);
  console.log("Flash completed. Run `npm run jarvis:stack:e2e -- --device` after the device boots.");
}

function rollbackFullFlash() {
  console.log("Restoring recorded full-flash backup. Do not unplug the device.");
  const result = runIdfCommand(
    `python -m esptool --chip esp32s3 --port ${shellQuote(devicePort)} --baud 921600 write_flash 0x0 ${shellQuote(backupPath)}`,
    { allowFailure: true },
  );
  if (!result.ok) die(result.output);
  console.log(result.output);
  console.log("Rollback flash completed.");
}

function requireFlashApproval() {
  if (process.env.JARVIS_STACKCHAN_FLASH_APPROVED !== "I_UNDERSTAND_THIS_WRITES_DEVICE") {
    die("Refusing to flash. Set JARVIS_STACKCHAN_FLASH_APPROVED=I_UNDERSTAND_THIS_WRITES_DEVICE after explicit user approval.");
  }
}

function requireRollbackApproval() {
  if (process.env.JARVIS_STACKCHAN_ROLLBACK_APPROVED !== "I_UNDERSTAND_THIS_WRITES_DEVICE") {
    die("Refusing to rollback. Set JARVIS_STACKCHAN_ROLLBACK_APPROVED=I_UNDERSTAND_THIS_WRITES_DEVICE after explicit user approval.");
  }
}

function addFileCheck(checks, errors, label, path, type) {
  if (!existsSync(path)) {
    errors.push(`${label} missing: ${path}`);
    return;
  }
  const stat = statSync(path);
  if (type === "directory" && !stat.isDirectory()) errors.push(`${label} is not a directory: ${path}`);
  if (type === "file" && !stat.isFile()) errors.push(`${label} is not a file: ${path}`);
  checks.push(`${label}: ${path}`);
}

function inspectFile(path) {
  const content = readFileSync(path);
  return {
    size: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function requireOutput(output, pattern, message, errors) {
  if (!pattern.test(output)) errors.push(message);
}

function runIdfCommand(commandLine, { cwd = firmwareRoot, allowFailure = false } = {}) {
  const commandText = `. ${shellQuote(idfExport)} >/tmp/jarvis-idf-export.log && ${commandLine}`;
  const result = spawnSync("zsh", ["-lc", commandText], {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.status !== 0 && !allowFailure) die(output);
  return { ok: result.status === 0, output };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function die(message) {
  console.error(message);
  process.exit(1);
}
