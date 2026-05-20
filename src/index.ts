#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const DEFAULT_URL = "http://localhost:3333";
const CONFIG_DIR = expandHome(process.env.IMA2_CONFIG_DIR || path.join(os.homedir(), ".ima2"));
const ADVERTISE_FILE = expandHome(process.env.IMA2_ADVERTISE_FILE || path.join(CONFIG_DIR, "server.json"));
const GENERATED_DIR = expandHome(process.env.IMA2_GENERATED_DIR || path.join(CONFIG_DIR, "generated"));
const AUTO_START = process.env.IMA2_MCP_AUTO_START === "1" || process.env.IMA2_MCP_AUTO_START === "true";
const START_TIMEOUT_MS = Number(process.env.IMA2_MCP_START_TIMEOUT_MS || 30_000);

const TRANSPORT = (process.env.IMA2_MCP_TRANSPORT || "stdio").toLowerCase();
const HTTP_HOST = process.env.IMA2_MCP_HTTP_HOST || "127.0.0.1";
const HTTP_PORT = Number(process.env.IMA2_MCP_HTTP_PORT || 8787);
const HTTP_PATH = normalizePath(process.env.IMA2_MCP_HTTP_PATH || "/mcp");
const BEARER_TOKEN = process.env.IMA2_MCP_BEARER_TOKEN || "";
const MAX_BODY_BYTES = Number(process.env.IMA2_MCP_MAX_BODY_BYTES || 20 * 1024 * 1024);

let ima2Child: ChildProcess | null = null;

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith(`~${path.sep}`)) return path.join(os.homedir(), input.slice(2));
  return input;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function normalizePath(input: string): string {
  const withSlash = input.startsWith("/") ? input : `/${input}`;
  return withSlash.replace(/\/+$/, "") || "/mcp";
}

async function readAdvertisedServerUrl(): Promise<string | null> {
  if (process.env.IMA2_SERVER) return normalizeBaseUrl(process.env.IMA2_SERVER);
  if (!existsSync(ADVERTISE_FILE)) return null;

  try {
    const raw = await readFile(ADVERTISE_FILE, "utf8");
    const adv = JSON.parse(raw);
    const url = adv?.backend?.url || adv?.url || (adv?.port ? `http://localhost:${adv.port}` : null);
    return typeof url === "string" && url.length > 0 ? normalizeBaseUrl(url) : null;
  } catch {
    return null;
  }
}

async function getBaseUrl(): Promise<string> {
  return (await readAdvertisedServerUrl()) || DEFAULT_URL;
}

async function isHealthy(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

function npxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function startIma2Serve(): void {
  if (ima2Child && !ima2Child.killed) return;

  const command = process.env.IMA2_MCP_SERVE_COMMAND || npxCommand();
  const args = process.env.IMA2_MCP_SERVE_ARGS
    ? process.env.IMA2_MCP_SERVE_ARGS.split(" ").filter(Boolean)
    : ["ima2-gen", "serve"];

  const child = spawn(command, args, {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"]
  });

  ima2Child = child;

  child.stdout?.on("data", (chunk) => process.stderr.write(`[ima2] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[ima2] ${chunk}`));
  child.on("exit", (code, signal) => {
    process.stderr.write(`[ima2] exited code=${code ?? "null"} signal=${signal ?? "null"}\n`);
    if (ima2Child === child) ima2Child = null;
  });
}

async function ensureIma2Server(): Promise<string> {
  let baseUrl = await getBaseUrl();
  if (await isHealthy(baseUrl)) return baseUrl;

  if (!AUTO_START) {
    throw new Error(
      `ima2-gen server is not reachable at ${baseUrl}. Start it with "npx ima2-gen serve", or set IMA2_MCP_AUTO_START=1 after completing ima2 setup/login.`
    );
  }

  startIma2Serve();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    baseUrl = await getBaseUrl();
    if (await isHealthy(baseUrl)) return baseUrl;
    await sleep(500);
  }

  throw new Error(
    `ima2-gen did not become healthy within ${START_TIMEOUT_MS}ms. Run "npx ima2-gen doctor" and "npx ima2-gen serve" manually to see setup errors.`
  );
}

async function requestJson(pathname: string, init?: RequestInit): Promise<{ baseUrl: string; json: any }> {
  const baseUrl = await ensureIma2Server();
  const res = await fetch(`${baseUrl}${pathname}`, init);
  const text = await res.text();
  let json: any = null;

  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }

  if (!res.ok) {
    const code = json?.code ? ` ${json.code}` : "";
    const message = json?.error || json?.raw || res.statusText;
    throw new Error(`ima2-gen HTTP ${res.status}${code}: ${message}`);
  }

  return { baseUrl, json };
}

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

async function fileToBase64(filePath: string): Promise<string> {
  const resolved = expandHome(filePath);
  const bytes = await readFile(resolved);
  return bytes.toString("base64");
}

async function fileToDataUrl(filePath: string): Promise<string> {
  const resolved = expandHome(filePath);
  const b64 = await fileToBase64(resolved);
  return `data:${guessMimeType(resolved)};base64,${b64}`;
}

function dataUrlToImageContent(dataUrl: string): { type: "image"; data: string; mimeType: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/s);
  if (!match) return null;
  return { type: "image", mimeType: match[1], data: match[2] };
}

function generatedPath(filename: string): string {
  return path.join(GENERATED_DIR, filename);
}

function summarizeGeneratedResponse(json: any): {
  files: string[];
  filenames: string[];
  imageDataUrls: string[];
  meta: Record<string, unknown>;
} {
  const imageDataUrls: string[] = [];
  const filenames: string[] = [];

  if (typeof json?.image === "string") imageDataUrls.push(json.image);
  if (typeof json?.filename === "string") filenames.push(json.filename);

  if (Array.isArray(json?.images)) {
    for (const item of json.images) {
      if (typeof item?.image === "string") imageDataUrls.push(item.image);
      if (typeof item?.filename === "string") filenames.push(item.filename);
    }
  }

  const files = filenames.map(generatedPath);
  const { image, images, ...meta } = json || {};
  return { files, filenames, imageDataUrls, meta };
}

const ProviderSchema = z.enum(["auto", "oauth", "api"]).optional().describe("Provider override. auto preserves ima2-gen default routing.");
const QualitySchema = z.enum(["low", "medium", "high"]).optional();
const ModerationSchema = z.enum(["auto", "low"]).optional();
const ModeSchema = z.enum(["auto", "direct"]).optional();
const ReasoningEffortSchema = z.enum(["none", "low", "medium", "high", "xhigh"]).optional();

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "ima2-gen-mcp",
    version: "0.2.0"
  });

  server.registerTool(
    "ima2_status",
    {
      title: "ima2-gen status",
      description: "Check the local ima2-gen server health, provider availability, and adapter paths.",
      inputSchema: {}
    },
    async () => {
      const baseUrl = await ensureIma2Server();
      const [health, providers] = await Promise.allSettled([
        requestJson("/api/health", { method: "GET" }),
        requestJson("/api/providers", { method: "GET" })
      ]);

      const output = {
        baseUrl,
        advertiseFile: ADVERTISE_FILE,
        generatedDir: GENERATED_DIR,
        transport: TRANSPORT,
        http: TRANSPORT === "http" ? { host: HTTP_HOST, port: HTTP_PORT, path: HTTP_PATH } : undefined,
        health: health.status === "fulfilled" ? health.value.json : { error: health.reason?.message || String(health.reason) },
        providers: providers.status === "fulfilled" ? providers.value.json : { error: providers.reason?.message || String(providers.reason) }
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output
      };
    }
  );

  server.registerTool(
    "ima2_generate",
    {
      title: "Generate image with ima2-gen",
      description: "Generate one or more images through the local ima2-gen /api/generate endpoint. The ima2 web UI can run at the same time.",
      inputSchema: {
        prompt: z.string().min(1).describe("Image prompt"),
        reference_image_paths: z.array(z.string()).max(5).optional().describe("Optional local image paths used as references. Max 5. Only usable on the server host."),
        provider: ProviderSchema,
        model: z.string().optional().describe("Optional ima2/OpenAI image model id. Omit to use server default."),
        quality: QualitySchema,
        size: z.string().optional().describe("Example: 1024x1024. Omit to use server default."),
        format: z.enum(["png", "jpeg", "webp"]).optional(),
        moderation: ModerationSchema,
        mode: ModeSchema,
        reasoning_effort: ReasoningEffortSchema,
        web_search_enabled: z.boolean().optional(),
        n: z.number().int().min(1).max(8).optional().describe("Number of images, clamped by ima2-gen. Max 8."),
        return_image_data: z.boolean().optional().describe("When true, also return generated image bytes as MCP image content.")
      }
    },
    async (args) => {
      const references = await Promise.all((args.reference_image_paths || []).map(fileToDataUrl));

      const body: Record<string, unknown> = {
        prompt: args.prompt,
        references,
        provider: args.provider || "auto",
        quality: args.quality || "medium",
        size: args.size || "1024x1024",
        format: args.format || "png",
        moderation: args.moderation || "low",
        mode: args.mode || "auto",
        n: args.n || 1
      };

      if (args.model) body.model = args.model;
      if (args.reasoning_effort) body.reasoningEffort = args.reasoning_effort;
      if (typeof args.web_search_enabled === "boolean") body.webSearchEnabled = args.web_search_enabled;

      const { baseUrl, json } = await requestJson("/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-ima2-client": "mcp"
        },
        body: JSON.stringify(body)
      });

      const summary = summarizeGeneratedResponse(json);
      const output = {
        baseUrl,
        generatedDir: GENERATED_DIR,
        files: summary.files,
        filenames: summary.filenames,
        note: TRANSPORT === "http" ? "File paths are on the MCP server host. Use return_image_data=true when calling from another computer." : undefined,
        meta: summary.meta
      };

      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
        { type: "text", text: JSON.stringify(output, null, 2) }
      ];

      if (args.return_image_data) {
        for (const dataUrl of summary.imageDataUrls) {
          const imageContent = dataUrlToImageContent(dataUrl);
          if (imageContent) content.push(imageContent);
        }
      }

      return { content, structuredContent: output };
    }
  );

  server.registerTool(
    "ima2_edit",
    {
      title: "Edit image with ima2-gen",
      description: "Edit an existing local image through the local ima2-gen /api/edit endpoint.",
      inputSchema: {
        image_path: z.string().min(1).describe("Local PNG/JPEG/WEBP image path to edit. In HTTP mode this path must exist on the MCP server host."),
        prompt: z.string().min(1).describe("Edit instruction"),
        mask_path: z.string().optional().describe("Optional PNG mask path. Mask is guidance, not guaranteed pixel-perfect inpainting."),
        provider: ProviderSchema,
        model: z.string().optional().describe("Optional ima2/OpenAI image model id. Omit to use server default."),
        quality: QualitySchema,
        size: z.string().optional().describe("Example: 1024x1024. Omit to use server default."),
        moderation: ModerationSchema,
        mode: ModeSchema,
        reasoning_effort: ReasoningEffortSchema,
        web_search_enabled: z.boolean().optional(),
        return_image_data: z.boolean().optional().describe("When true, also return generated image bytes as MCP image content.")
      }
    },
    async (args) => {
      const image = await fileToBase64(args.image_path);
      const body: Record<string, unknown> = {
        prompt: args.prompt,
        image,
        provider: args.provider || "auto",
        quality: args.quality || "medium",
        size: args.size || "1024x1024",
        moderation: args.moderation || "low",
        mode: args.mode || "auto"
      };

      if (args.mask_path) body.mask = await fileToBase64(args.mask_path);
      if (args.model) body.model = args.model;
      if (args.reasoning_effort) body.reasoningEffort = args.reasoning_effort;
      if (typeof args.web_search_enabled === "boolean") body.webSearchEnabled = args.web_search_enabled;

      const { baseUrl, json } = await requestJson("/api/edit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-ima2-client": "mcp"
        },
        body: JSON.stringify(body)
      });

      const summary = summarizeGeneratedResponse(json);
      const output = {
        baseUrl,
        generatedDir: GENERATED_DIR,
        files: summary.files,
        filenames: summary.filenames,
        note: TRANSPORT === "http" ? "File paths are on the MCP server host. Use return_image_data=true when calling from another computer." : undefined,
        meta: summary.meta
      };

      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
        { type: "text", text: JSON.stringify(output, null, 2) }
      ];

      if (args.return_image_data) {
        for (const dataUrl of summary.imageDataUrls) {
          const imageContent = dataUrlToImageContent(dataUrl);
          if (imageContent) content.push(imageContent);
        }
      }

      return { content, structuredContent: output };
    }
  );

  return server;
}

async function runStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function requestPath(req: IncomingMessage): string {
  const host = req.headers.host || "localhost";
  const url = new URL(req.url || "/", `http://${host}`);
  return normalizePath(url.pathname);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error(`Request body too large. Max ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return undefined;
  return JSON.parse(raw);
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!BEARER_TOKEN) return true;
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${BEARER_TOKEN}`;
}

type SessionRecord = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};

async function runHttp(): Promise<void> {
  const sessions = new Map<string, SessionRecord>();

  const httpServer = http.createServer(async (req, res) => {
    try {
      const pathname = requestPath(req);

      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,mcp-session-id");
        res.end();
        return;
      }

      if (pathname === "/" || pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          name: "ima2-gen-mcp",
          transport: "http",
          mcpPath: HTTP_PATH,
          ima2Server: await getBaseUrl(),
          ima2Healthy: await isHealthy(await getBaseUrl())
        });
        return;
      }

      if (pathname !== HTTP_PATH) {
        sendJson(res, 404, { error: "not_found", mcpPath: HTTP_PATH });
        return;
      }

      if (!isAuthorized(req)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      if (req.method === "POST") {
        const parsedBody = await readJsonBody(req);
        const rawSessionId = req.headers["mcp-session-id"];
        const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

        let record = sessionId ? sessions.get(sessionId) : undefined;

        if (!record && !sessionId && isInitializeRequest(parsedBody)) {
          let transport!: StreamableHTTPServerTransport;
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              sessions.set(newSessionId, { transport, server });
              process.stderr.write(`[mcp-http] session initialized ${newSessionId}\n`);
            }
          });

          const server = createMcpServer();
          transport.onclose = async () => {
            const sid = transport.sessionId;
            if (sid) sessions.delete(sid);
            await server.close();
            process.stderr.write(`[mcp-http] session closed ${sid ?? "unknown"}\n`);
          };

          await server.connect(transport);
          await transport.handleRequest(req, res, parsedBody);
          return;
        }

        if (!record) {
          sendJson(res, 400, {
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: missing or invalid MCP session. Send an initialize request first."
            },
            id: null
          });
          return;
        }

        await record.transport.handleRequest(req, res, parsedBody);
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        const rawSessionId = req.headers["mcp-session-id"];
        const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
        const record = sessionId ? sessions.get(sessionId) : undefined;
        if (!record) {
          sendJson(res, 400, { error: "invalid_or_missing_session_id" });
          return;
        }
        await record.transport.handleRequest(req, res);
        return;
      }

      sendJson(res, 405, { error: "method_not_allowed" });
    } catch (error: any) {
      process.stderr.write(`[mcp-http] ${error?.stack || error}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: error?.message || "Internal server error" },
          id: null
        });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(HTTP_PORT, HTTP_HOST, () => resolve());
  });

  process.stderr.write(`[mcp-http] ima2-gen MCP HTTP server running at http://${HTTP_HOST}:${HTTP_PORT}${HTTP_PATH}\n`);
  process.stderr.write(`[mcp-http] health check: http://${HTTP_HOST}:${HTTP_PORT}/health\n`);

  const shutdown = async () => {
    process.stderr.write("[mcp-http] shutting down\n");
    for (const [sessionId, record] of sessions) {
      sessions.delete(sessionId);
      await record.transport.close().catch(() => undefined);
      await record.server.close().catch(() => undefined);
    }
    httpServer.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  if (TRANSPORT === "http" || TRANSPORT === "streamable-http" || process.argv.includes("--http")) {
    await runHttp();
  } else {
    await runStdio();
  }
}

process.on("exit", () => {
  if (ima2Child && !ima2Child.killed) ima2Child.kill("SIGTERM");
});

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
