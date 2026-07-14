#!/usr/bin/env node

declare global {
  var __CODEX_SHIM_VALUES__: {
    version: string;
  };
}

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { parseArgs as parseCliArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { installModuleAliasHook } from "./module";

type ServerOptions = {
  port: number;
};

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization, X-Requested-With",
  "access-control-max-age": "86400",
};

function applyCorsHeaders(target: {
  header(name: string, value: string): unknown;
}): void {
  for (const [name, value] of Object.entries(corsHeaders)) {
    target.header(name, value);
  }
}

function applyRawCorsHeaders(target: {
  setHeader(name: string, value: string): unknown;
}): void {
  for (const [name, value] of Object.entries(corsHeaders)) {
    target.setHeader(name, value);
  }
}

function resolveAsarRoot(): string {
  const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
  const scriptDir = scriptPath ? path.dirname(scriptPath) : null;
  const candidates = [...new Set([
    process.env.CODEX_ASAR_DIR,
    scriptDir ? path.join(scriptDir, "scratch/asar") : null,
    scriptDir ? path.join(scriptDir, "../scratch/asar") : null,
    path.resolve(process.cwd(), "scratch/asar"),
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value)))];

  for (const candidate of candidates) {
    if (fsSync.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }

  throw new Error(
    [
      "Codex web assets not found.",
      "Expected a patched scratch/asar directory containing package.json.",
      "Run npm run setup and either keep scratch/asar next to the bundle, or set CODEX_ASAR_DIR to that directory.",
      `Checked: ${candidates.join(", ")}`,
    ].join(" "),
  );
}

const asarRoot = resolveAsarRoot();

type RendererToMainMessage =
  | {
      type: "ipc-renderer-invoke";
      clientId: string;
      requestId: string;
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-send";
      clientId: string;
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-post-message";
      channel: string;
      message: unknown;
      portIds: string[];
      sourceUrl?: string;
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    }
  | {
      type: "workspace-directory-entries-request";
      clientId: string;
      requestId: string;
      directoryPath: string | null;
      directoriesOnly: boolean;
    };

type MainToRendererMessage =
  | {
      type: "ipc-main-event";
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: true;
      result: WorkspaceDirectoryEntries;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    };

type WorkspaceDirectoryEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
};

type WorkspaceDirectoryEntries = {
  directoryPath: string;
  parentPath: string | null;
  entries: WorkspaceDirectoryEntry[];
};

type StagedUpload = {
  uploadedPath: string;
};


function workspaceDirectoryEntryTypeRank(
  entry: WorkspaceDirectoryEntry,
): number {
  return entry.type === "directory" ? 0 : 1;
}

function workspaceDirectoryEntryHiddenRank(
  entry: WorkspaceDirectoryEntry,
): number {
  return entry.name.startsWith(".") ? 1 : 0;
}

function compareWorkspaceDirectoryEntries(
  left: WorkspaceDirectoryEntry,
  right: WorkspaceDirectoryEntry,
): number {
  return (
    workspaceDirectoryEntryTypeRank(left) -
      workspaceDirectoryEntryTypeRank(right) ||
    workspaceDirectoryEntryHiddenRank(left) -
      workspaceDirectoryEntryHiddenRank(right) ||
    left.name.localeCompare(right.name)
  );
}

type IpcMainBridgeState = {
  broadcastToRenderer?: (message: MainToRendererMessage) => void;
  handleRendererInvoke?: (channel: string, args: unknown[]) => Promise<unknown>;
  handleRendererPostMessage?: (
    channel: string,
    message: unknown,
    ports: BridgedMessagePort[],
    sourceUrl?: string,
  ) => void;
  handleRendererSend?: (channel: string, args: unknown[]) => void;
};

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  server [--port <port>]",
      "",
      "Default:",
      "  --port 8214",
      "",
      "Examples:",
      "  npm run run",
      "  npm run run -- --port 9000",
    ].join("\n"),
  );
}

function parsePort(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return parsed;
}

function parseServerArgs(args: string[]): ServerOptions {
  const parsed = parseCliArgs({
    args,
    allowPositionals: false,
    options: {
      help: {
        short: "h",
        type: "boolean",
      },
      port: {
        type: "string",
      },
    },
    strict: true,
  });

  if (parsed.values.help) {
    printUsage();
    process.exit(0);
  }

  return {
    port: parsed.values.port ? parsePort(parsed.values.port) : 8214,
  };
}

function getIpcMainBridgeState(): IpcMainBridgeState {
  const globals = globalThis as typeof globalThis & {
    __codexElectronIpcBridge?: IpcMainBridgeState;
  };
  if (!globals.__codexElectronIpcBridge) {
    globals.__codexElectronIpcBridge = {};
  }
  return globals.__codexElectronIpcBridge;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createUploadedPath(uploadRoot: string, label: string): string {
  return path.join(uploadRoot, `${randomUUID()}${path.extname(label)}`);
}

async function removeFileIfExists(filePath: string): Promise<void> {
  try {
    await fs.rm(filePath, { force: true });
  } catch {}
}

async function getWorkspaceDirectoryEntries({
  directoryPath,
  directoriesOnly,
}: {
  directoryPath: string | null;
  directoriesOnly: boolean;
}): Promise<WorkspaceDirectoryEntries> {
  const requestedPath = directoryPath?.trim() || os.homedir();
  const resolvedPath = path.resolve(requestedPath);
  const stat = await fs.stat(resolvedPath);
  if (!stat.isDirectory()) {
    throw new Error(`Directory not found: ${requestedPath}`);
  }

  const entries: WorkspaceDirectoryEntry[] = [];
  for (const entry of await fs.readdir(resolvedPath, { withFileTypes: true })) {
    const type = entry.isDirectory() ? "directory" : "file";
    if (directoriesOnly && type !== "directory") {
      continue;
    }

    entries.push({
      name: entry.name,
      path: path.join(resolvedPath, entry.name),
      type,
    });
  }
  entries.sort(compareWorkspaceDirectoryEntries);

  const rootPath = path.parse(resolvedPath).root;
  const parentPath =
    resolvedPath === rootPath ? null : path.dirname(resolvedPath);

  return {
    directoryPath: resolvedPath,
    parentPath,
    entries,
  };
}

function ensureElectronLikeProcessContext(): void {
  process.env.BUILD_FLAVOR = "prod";

  const versions = process.versions as NodeJS.ProcessVersions & {
    electron?: string;
  };
  if (!versions.electron) {
    Object.defineProperty(versions, "electron", {
      value: "41.2.0",
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }

  const processWithElectronFields = process as NodeJS.Process & {
    resourcesPath?: string;
    type?: string;
  };
  processWithElectronFields.resourcesPath ??= asarRoot;
  processWithElectronFields.type ??= "browser";
}

async function startIpcBridgeServer(options: ServerOptions): Promise<void> {
  const bridgeState = getIpcMainBridgeState();
  const app = Fastify({ logger: false });
  const websocketServer = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  const clientSockets = new Map<string, WebSocket>();

  function sendToClient(
    clientId: string | undefined,
    fallbackSocket: WebSocket,
    message: MainToRendererMessage,
  ): void {
    const targetSocket =
      (clientId ? clientSockets.get(clientId) : undefined) ?? fallbackSocket;
    if (targetSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    targetSocket.send(JSON.stringify(message));
  }

  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS") {
      applyCorsHeaders(reply);
      return reply.code(204).send();
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    applyCorsHeaders(reply);
    return payload;
  });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: Infinity,
    },
  });

  const uploadRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-web-uploads-"),
  );
  const stagedUploads = new Map<string, StagedUpload>();

  app.addHook("onClose", async () => {
    await fs.rm(uploadRoot, { recursive: true, force: true });
  });

  app.post("/__backend/upload", async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: "expected multipart upload body" });
    }

    const files = await Array.fromAsync(
      (async function* () {
        for await (const part of request.files()) {
          const label = part.filename?.trim() || "upload";
          const uploadedPath = createUploadedPath(uploadRoot, label);

          await pipeline(part.file, fsSync.createWriteStream(uploadedPath));

          yield {
            label,
            path: uploadedPath,
            fsPath: uploadedPath,
          };
        }
      })(),
    );

    return reply.send({ files });
  });

  app.post("/__backend/staged-upload/create", async (request, reply) => {
    const body = request.body;
    const label =
      isRecord(body) && typeof body.fileName === "string" && body.fileName.trim()
        ? body.fileName.trim()
        : "upload";
    const assetId = randomUUID();
    const uploadedPath = createUploadedPath(uploadRoot, label);

    await fs.writeFile(uploadedPath, "");
    stagedUploads.set(assetId, { uploadedPath });

    return reply.send({ ok: true, assetId, path: "" });
  });

  app.post("/__backend/staged-upload/append", async (request, reply) => {
    const body = request.body;
    if (
      !isRecord(body) ||
      typeof body.assetId !== "string" ||
      typeof body.dataBase64 !== "string"
    ) {
      return reply.code(400).send({ error: "invalid staged upload append body" });
    }

    const stagedUpload = stagedUploads.get(body.assetId);
    if (!stagedUpload) {
      return reply.code(404).send({ error: "staged upload not found" });
    }

    await fs.appendFile(
      stagedUpload.uploadedPath,
      Buffer.from(body.dataBase64, "base64"),
    );

    return reply.send({ ok: true });
  });

  app.post("/__backend/staged-upload/finish", async (request, reply) => {
    const body = request.body;
    if (!isRecord(body) || typeof body.assetId !== "string") {
      return reply.code(400).send({ error: "invalid staged upload finish body" });
    }

    const stagedUpload = stagedUploads.get(body.assetId);
    if (!stagedUpload) {
      return reply.code(404).send({ error: "staged upload not found" });
    }

    return reply.send({
      ok: true,
      assetId: body.assetId,
      path: stagedUpload.uploadedPath,
    });
  });

  app.post("/__backend/staged-upload/remove", async (request, reply) => {
    const body = request.body;
    if (!isRecord(body) || typeof body.assetId !== "string") {
      return reply.code(400).send({ error: "invalid staged upload remove body" });
    }

    const stagedUpload = stagedUploads.get(body.assetId);
    if (!stagedUpload) {
      return reply.send({ ok: true });
    }

    stagedUploads.delete(body.assetId);
    await removeFileIfExists(stagedUpload.uploadedPath);
    return reply.send({ ok: true });
  });

  await app.register(fastifyStatic, {
    root: "/",
    prefix: "/@fs/",
    decorateReply: false,
    setHeaders: applyRawCorsHeaders,
  });

  await app.register(fastifyStatic, {
    root: path.join(asarRoot, "webview"),
    prefix: "/",
    setHeaders: applyRawCorsHeaders,
  });

  app.get("/", async (_request, reply) => {
    return reply.sendFile("index.html");
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/@fs/")) {
      return reply.code(404).send({ error: "Not Found" });
    }

    if (request.method === "GET") {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not Found" });
  });

  app.server.on("upgrade", (request, socket, head) => {
    const requestUrl = request.url ?? "/";
    const host = request.headers.host ?? "localhost";
    const url = new URL(requestUrl, `http://${host}`);
    if (url.pathname !== "/__backend/ipc") {
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (upgradedSocket) => {
      websocketServer.emit("connection", upgradedSocket, request);
    });
  });

  bridgeState.broadcastToRenderer = (message: MainToRendererMessage): void => {
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  };

  websocketServer.on("connection", (socket) => {
    sockets.add(socket);

    const messagePorts = new Map<string, WebSocketMessagePort>();
    const dispatchPostMessage = (
      channel: string,
      message: unknown,
      ports: WebSocketMessagePort[],
      sourceUrl?: string,
    ): void => {
      const handler = bridgeState.handleRendererPostMessage;
      if (handler) {
        handler(channel, message, ports, sourceUrl);
        return;
      }

      console.error(
        `[ipc-bridge] no ipcMain postMessage handler for channel ${channel}`,
      );
      for (const port of ports) {
        port.close();
      }
    };

    socket.on("close", () => {
      sockets.delete(socket);
      for (const [clientId, clientSocket] of clientSockets) {
        if (clientSocket === socket) {
          clientSockets.delete(clientId);
        }
      }
    });

    socket.on("message", (rawData) => {
      let message: RendererToMainMessage;
      try {
        message = JSON.parse(String(rawData)) as RendererToMainMessage;
      } catch (error) {
        console.error("[ipc-bridge] invalid JSON payload", error);
        return;
      }

      clientSockets.set(message.clientId, socket);

      if (message.type === "ipc-renderer-send") {
        bridgeState.handleRendererSend?.(message.channel, message.args);
        return;
      }

      if (message.type === "ipc-renderer-post-message") {
        if (new Set(message.portIds).size !== message.portIds.length) {
          console.error("[ipc-bridge] duplicate transferred MessagePort id");
          return;
        }

        const ports = message.portIds.map((portId) => {
          const existingPort = messagePorts.get(portId);
          if (existingPort) {
            existingPort.disconnect();
          }
          const port = new WebSocketMessagePort(
            portId,
            (message) => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify(message));
              }
            },
            () => messagePorts.delete(portId),
          );
          messagePorts.set(portId, port);
          return port;
        });

        dispatchPostMessage(
          message.channel,
          message.message,
          ports,
          message.sourceUrl,
        );
        return;
      }

      if (message.type === "message-port-message") {
        messagePorts.get(message.portId)?.receiveMessage(message.data);
        return;
      }

      if (message.type === "message-port-close") {
        messagePorts.get(message.portId)?.disconnect();
        return;
      }

      if (message.type === "workspace-directory-entries-request") {
        const { clientId, requestId } = message;
        getWorkspaceDirectoryEntries(message)
          .then((result) => {
            sendToClient(clientId, socket, {
              type: "workspace-directory-entries-result",
              requestId,
              ok: true,
              result,
            });
          })
          .catch((error) => {
            sendToClient(clientId, socket, {
              type: "workspace-directory-entries-result",
              requestId,
              ok: false,
              errorMessage: errorMessage(error),
            });
          });
        return;
      }

      if (message.type === "ipc-renderer-invoke") {
        const { clientId, channel, requestId, args } = message;
        Promise.resolve(
          bridgeState.handleRendererInvoke?.(channel, args) ??
            Promise.reject(
              new Error(
                `[ipc-bridge] no ipcMain.handle for channel ${channel}`,
              ),
            ),
        )
          .then((result) => {
            sendToClient(clientId, socket, {
              type: "ipc-renderer-invoke-result",
              requestId,
              ok: true,
              result,
            });
          })
          .catch((error) => {
            sendToClient(clientId, socket, {
              type: "ipc-renderer-invoke-result",
              requestId,
              ok: false,
              errorMessage: errorMessage(error),
            });
          });
      }
    });
  });

  await app.listen({ host: "127.0.0.1", port: options.port });

  ensureElectronLikeProcessContext();
  installModuleAliasHook();

  const packageJson = JSON.parse(
    await fs.readFile(
      path.join(asarRoot, "package.json"),
      "utf8",
    ),
  );

  globalThis.__CODEX_SHIM_VALUES__ = {
    version: packageJson.version,
  };

  const buildDirectory = path.join(asarRoot, ".vite/build");
  const matches = (await fs.readdir(buildDirectory)).filter((name) =>
    /^main-.+\.js$/.test(name),
  );

  if (matches.length === 0) {
    throw new Error("no main bundle found");
  }

  if (matches.length > 1) {
    throw new Error("multiple main bundles found");
  }

  const module = require(path.join(buildDirectory, matches[0]!));
  module.runMainAppStartup();
}

async function main(args: string[]) {
  const options = parseServerArgs(args);

  if (!process.env.CODEX_CLI_PATH) {
    try {
      process.env.CODEX_CLI_PATH = execFileSync("which", ["codex"], {
        encoding: "utf8",
      }).trim();
    } catch {}
  }

  await startIpcBridgeServer(options);
}

main(process.argv.slice(2));
