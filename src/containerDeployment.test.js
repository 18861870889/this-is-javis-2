import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const composeCandidates = [
  "compose.yml",
  "compose.yaml",
  "docker-compose.yml",
  "docker-compose.yaml",
];

function readRepositoryFile(relativePath) {
  const absolutePath = fileURLToPath(new URL(relativePath, new URL("../", import.meta.url)));
  expect(existsSync(absolutePath), `${relativePath} must exist`).toBe(true);
  return readFileSync(absolutePath, "utf8");
}

function readComposeFile() {
  const relativePath = composeCandidates.find((candidate) => existsSync(`${repositoryRoot}${candidate}`));
  expect(relativePath, `one of ${composeCandidates.join(", ")} must exist`).toBeTruthy();
  return readRepositoryFile(relativePath);
}

function dockerInstructions(source) {
  return source
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter(Boolean);
}

describe("container deployment contract", () => {
  it("uses a production multi-stage image with a non-root, health-checked runtime", () => {
    const dockerfile = readRepositoryFile("Dockerfile");
    const instructions = dockerInstructions(dockerfile);
    const fromIndexes = instructions
      .map((instruction, index) => (/^FROM\s+/i.test(instruction) ? index : -1))
      .filter((index) => index >= 0);

    expect(fromIndexes.length, "Dockerfile must contain build and runtime stages").toBeGreaterThanOrEqual(2);
    expect(dockerfile, "the runtime image must copy artifacts from an earlier stage").toMatch(/^\s*COPY\s+--from(?:=|\s+)/im);
    expect(dockerfile, "production dependencies must exclude devDependencies").toMatch(
      /^\s*RUN\s+[^\n]*npm\s+(?:ci|install|prune)\b[^\n]*(?:--omit(?:=|\s+)dev|--only(?:=|\s+)production)\b/im,
    );

    const runtimeInstructions = instructions.slice(fromIndexes.at(-1));
    const runtimeStage = runtimeInstructions.join("\n");
    const userInstruction = runtimeInstructions.find((instruction) => /^USER\s+/i.test(instruction));

    expect(runtimeStage, "the final stage must set NODE_ENV=production").toMatch(/^ENV\s+NODE_ENV(?:=|\s+)production\b/im);
    expect(userInstruction, "the final stage must declare a non-root USER").toBeTruthy();
    expect(userInstruction, "the final stage must not run as root").not.toMatch(/^USER\s+(?:root|0)(?::(?:root|0))?\s*$/i);
    expect(runtimeStage, "the final stage must define a HEALTHCHECK").toMatch(/^HEALTHCHECK\b/im);
    expect(runtimeStage, "the image healthcheck must query the runtime status route").toContain("/api/runtime/status");
  });

  it("keeps the compose service local, dry-run, healthy, and least-privileged", () => {
    const compose = readComposeFile();

    expect(compose).toMatch(/^services:\s*$/m);
    expect(compose, "the host port must only bind to localhost").toMatch(/127\.0\.0\.1:[^\n]*:5173\b/);
    expect(compose, "the container server must listen on its network interface").toMatch(
      /JARVIS_BIND_HOST\s*(?::|=)\s*["']?0\.0\.0\.0\b/,
    );
    expect(compose).toMatch(/NODE_ENV\s*(?::|=)\s*["']?production\b/);
    expect(compose).toMatch(
      /HARNESS_EXECUTION_MODE\s*(?::|=)\s*["']?(?:dry_run|\$\{JARVIS_CONTAINER_EXECUTION_MODE:-dry_run\})/,
    );
    expect(compose).toMatch(/^\s+healthcheck:\s*$/m);
    expect(compose).toContain("/api/runtime/status");

    expect(compose).toMatch(/^\s+security_opt:\s*$/m);
    expect(compose).toMatch(/no-new-privileges\s*(?::|=)\s*true\b/);
    expect(compose).toMatch(/^\s+cap_drop:\s*(?:\[[^\]]*\bALL\b[^\]]*\]|\n\s+-\s*["']?ALL["']?\s*$)/m);
    expect(compose).toMatch(/^\s+read_only:\s*true\s*$/m);
    expect(compose).toMatch(/^\s+cpus:\s*["']?\$\{JARVIS_CONTAINER_CPUS:-2\.0\}/m);
    expect(compose).toMatch(/^\s+mem_limit:\s*["']?\$\{JARVIS_CONTAINER_MEMORY:-1g\}/m);
  });

  it("exposes npm commands for the container lifecycle", () => {
    const packageJson = JSON.parse(readRepositoryFile("package.json"));
    const containerScripts = Object.entries(packageJson.scripts ?? {})
      .filter(([name]) => /(?:container|docker)/i.test(name))
      .map(([, command]) => command);

    expect(containerScripts, "package scripts must include a Docker build command").toEqual(
      expect.arrayContaining([expect.stringMatching(/\bdocker(?:\s+compose)?\s+build\b/)]),
    );
    expect(containerScripts, "package scripts must include a Docker Compose up command").toEqual(
      expect.arrayContaining([expect.stringMatching(/\bdocker\s+compose\s+up\b/)]),
    );
    expect(containerScripts, "package scripts must include a Docker Compose down command").toEqual(
      expect.arrayContaining([expect.stringMatching(/\bdocker\s+compose\s+down\b/)]),
    );

    const wrapper = readRepositoryFile("scripts/jarvis-container.mjs");
    expect(wrapper).toContain('JARVIS_CONTAINER_ENGINE || "auto"');
    expect(wrapper).toContain('JARVIS_CONTAINER_BIND_HOST || "127.0.0.1"');
    expect(wrapper).toContain('JARVIS_CONTAINER_EXECUTION_MODE === "real" ? "real" : "dry_run"');
    expect(wrapper).toContain('"--read-only"');
    expect(wrapper).toContain('"--cap-drop", "ALL"');
    expect(wrapper).toContain("/api/runtime/status");
    expect(wrapper).not.toContain('run("container", ["inspect", containerName]);');
  });
});
