import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";

export const JARVIS_HERMES_MCP_SERVER = "jarvis_pc_workspace";
export const JARVIS_HERMES_API_TOOLSETS = [
  "search",
  JARVIS_HERMES_MCP_SERVER,
];
export const JARVIS_HERMES_PC_TOOLS = [
  "read_text_file",
  "read_multiple_files",
  "write_file",
  "edit_file",
  "create_directory",
  "list_directory",
  "list_directory_with_sizes",
  "search_files",
  "directory_tree",
  "get_file_info",
  "list_allowed_directories",
];
const DEFAULT_MODEL_CONTEXT_LENGTH = 131_072;

export function resolveHermesApiIsolationConfig({
  repoRoot = process.cwd(),
  hermesHome,
  env = process.env,
} = {}) {
  const resolvedRepoRoot = resolve(repoRoot);
  const workspaceRoot = resolve(
    env.JARVIS_HERMES_PC_WORKSPACE_ROOT
      || join(resolvedRepoRoot, "data/pc-workspace.local"),
  );
  const contextLength = Number(
    env.JARVIS_HERMES_MODEL_CONTEXT_LENGTH || DEFAULT_MODEL_CONTEXT_LENGTH,
  );
  if (!Number.isInteger(contextLength) || contextLength < 64_000) {
    throw new Error("JARVIS_HERMES_MODEL_CONTEXT_LENGTH must be an integer of at least 64000.");
  }
  return {
    configPath: resolve(hermesHome, "config.yaml"),
    workspaceRoot,
    nodePath: resolve(process.execPath),
    filesystemServerPath: resolve(
      resolvedRepoRoot,
      "node_modules/@modelcontextprotocol/server-filesystem/dist/index.js",
    ),
    contextLength,
  };
}

export function buildIsolatedHermesConfig(currentConfig = {}, isolation) {
  const next = structuredClone(currentConfig && typeof currentConfig === "object" ? currentConfig : {});
  const currentModel = next.model;
  next.model = typeof currentModel === "string"
    ? {
        default: currentModel,
        context_length: isolation.contextLength,
      }
    : {
        ...(currentModel && typeof currentModel === "object" ? currentModel : {}),
        context_length: currentModel?.context_length || isolation.contextLength,
      };
  next.auxiliary = {
    ...(next.auxiliary && typeof next.auxiliary === "object" ? next.auxiliary : {}),
    compression: {
      ...(next.auxiliary?.compression && typeof next.auxiliary.compression === "object"
        ? next.auxiliary.compression
        : {}),
      context_length: next.auxiliary?.compression?.context_length || isolation.contextLength,
    },
  };
  next.platform_toolsets = {
    ...(next.platform_toolsets && typeof next.platform_toolsets === "object"
      ? next.platform_toolsets
      : {}),
    api_server: [...JARVIS_HERMES_API_TOOLSETS],
  };
  next.mcp_servers = {
    ...(next.mcp_servers && typeof next.mcp_servers === "object" ? next.mcp_servers : {}),
    [JARVIS_HERMES_MCP_SERVER]: {
      command: isolation.nodePath,
      args: [isolation.filesystemServerPath, isolation.workspaceRoot],
      enabled: true,
      timeout: 60,
      connect_timeout: 30,
      tools: {
        include: [...JARVIS_HERMES_PC_TOOLS],
        resources: false,
        prompts: false,
      },
      sampling: {
        enabled: false,
      },
    },
  };
  return next;
}

export function ensureHermesApiIsolation(options = {}) {
  const isolation = resolveHermesApiIsolationConfig(options);
  assertIsolationDependencies(isolation);
  mkdirSync(isolation.workspaceRoot, { recursive: true, mode: 0o700 });

  const currentText = existsSync(isolation.configPath)
    ? readFileSync(isolation.configPath, "utf8")
    : "";
  const currentConfig = currentText.trim() ? parse(currentText) : {};
  const nextConfig = buildIsolatedHermesConfig(currentConfig, isolation);
  const nextText = stringify(nextConfig, { lineWidth: 100 });
  const changed = currentText !== nextText;
  if (changed) writeYamlAtomic(isolation.configPath, nextText);

  return {
    changed,
    workspaceRoot: isolation.workspaceRoot,
    toolsets: [...JARVIS_HERMES_API_TOOLSETS],
    pcTools: [...JARVIS_HERMES_PC_TOOLS],
    contextLength: isolation.contextLength,
  };
}

function assertIsolationDependencies(isolation) {
  if (!existsSync(isolation.nodePath)) {
    throw new Error("Jarvis Hermes isolation requires the current Node.js executable.");
  }
  if (!existsSync(isolation.filesystemServerPath)) {
    throw new Error(
      "Jarvis Hermes isolation requires @modelcontextprotocol/server-filesystem. Run npm install.",
    );
  }
}

function writeYamlAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, text, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
