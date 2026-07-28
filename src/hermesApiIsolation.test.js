import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse } from "yaml";
import {
  buildIsolatedHermesConfig,
  ensureHermesApiIsolation,
  JARVIS_HERMES_API_TOOLSETS,
  JARVIS_HERMES_MCP_SERVER,
  JARVIS_HERMES_PC_TOOLS,
} from "./hermesApiIsolation.js";

describe("Hermes API isolation", () => {
  it("preserves non-API platforms while replacing the API surface with search and workspace MCP", () => {
    const result = buildIsolatedHermesConfig({
      platform_toolsets: {
        cli: ["hermes-cli"],
        weixin: ["hermes-weixin"],
        api_server: ["hermes-api-server"],
      },
      mcp_servers: {
        personal: { command: "personal-mcp" },
      },
      model: "glm-test",
      auxiliary: {
        compression: {
          model: "glm-test-fast",
        },
      },
    }, {
      nodePath: "/usr/bin/node",
      filesystemServerPath: "/repo/node_modules/filesystem/dist/index.js",
      workspaceRoot: "/safe/workspace",
      contextLength: 131_072,
    });

    expect(result.platform_toolsets).toEqual({
      cli: ["hermes-cli"],
      weixin: ["hermes-weixin"],
      api_server: JARVIS_HERMES_API_TOOLSETS,
    });
    expect(result.mcp_servers.personal).toEqual({ command: "personal-mcp" });
    expect(result.model).toEqual({
      default: "glm-test",
      context_length: 131_072,
    });
    expect(result.auxiliary.compression).toEqual({
      model: "glm-test-fast",
      context_length: 131_072,
    });
    expect(result.mcp_servers[JARVIS_HERMES_MCP_SERVER]).toMatchObject({
      command: "/usr/bin/node",
      args: ["/repo/node_modules/filesystem/dist/index.js", "/safe/workspace"],
      tools: {
        include: JARVIS_HERMES_PC_TOOLS,
        resources: false,
        prompts: false,
      },
      sampling: { enabled: false },
    });
    expect(JSON.stringify(result.platform_toolsets.api_server)).not.toMatch(
      /terminal|file|browser|homeassistant|code_execution|skills|messaging/,
    );
  });

  it("writes a private, idempotent config and creates only the allowed workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-hermes-isolation-"));
    const hermesHome = join(root, "hermes");
    const repoRoot = join(root, "repo");
    const filesystemServerPath = join(
      repoRoot,
      "node_modules/@modelcontextprotocol/server-filesystem/dist/index.js",
    );
    mkdirSync(join(hermesHome), { recursive: true });
    mkdirSync(join(filesystemServerPath, ".."), { recursive: true });
    writeFileSync(filesystemServerPath, "#!/usr/bin/env node\n");
    writeFileSync(join(hermesHome, "config.yaml"), "model: test\nplatform_toolsets:\n  cli: [hermes-cli]\n");

    const env = {
      JARVIS_HERMES_PC_WORKSPACE_ROOT: join(root, "workspace"),
      JARVIS_HERMES_MODEL_CONTEXT_LENGTH: "131072",
    };
    const first = ensureHermesApiIsolation({ repoRoot, hermesHome, env });
    const second = ensureHermesApiIsolation({ repoRoot, hermesHome, env });
    const config = parse(readFileSync(join(hermesHome, "config.yaml"), "utf8"));

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(existsSync(env.JARVIS_HERMES_PC_WORKSPACE_ROOT)).toBe(true);
    expect(config.platform_toolsets.api_server).toEqual(JARVIS_HERMES_API_TOOLSETS);
    expect(config.model).toEqual({
      default: "test",
      context_length: 131_072,
    });
    expect(config.auxiliary.compression.context_length).toBe(131_072);
    expect(config.mcp_servers[JARVIS_HERMES_MCP_SERVER].args.at(-1)).toBe(
      env.JARVIS_HERMES_PC_WORKSPACE_ROOT,
    );
    expect(statSync(join(hermesHome, "config.yaml")).mode & 0o777).toBe(0o600);
  });

  it("uses the official filesystem MCP to write inside the workspace and reject traversal", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "jarvis-pc-workspace-"));
    const outsidePath = join(workspaceRoot, "..", `jarvis-outside-${Date.now()}.md`);
    const serverPath = join(
      process.cwd(),
      "node_modules/@modelcontextprotocol/server-filesystem/dist/index.js",
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath, workspaceRoot],
    });
    const client = new Client({ name: "jarvis-isolation-test", version: "0.1" });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("write_file");

      const insidePath = join(workspaceRoot, "hello.md");
      const writeResult = await client.callTool({
        name: "write_file",
        arguments: { path: insidePath, content: "helloworld" },
      });
      expect(writeResult.isError).not.toBe(true);
      expect(readFileSync(insidePath, "utf8")).toBe("helloworld");

      const outsideResult = await client.callTool({
        name: "write_file",
        arguments: { path: outsidePath, content: "must-not-exist" },
      });
      expect(outsideResult.isError).toBe(true);
      expect(existsSync(outsidePath)).toBe(false);
    } finally {
      await client.close();
    }
  });
});
