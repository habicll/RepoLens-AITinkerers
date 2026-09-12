import "dotenv/config";
import express from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CopilotRuntime, InMemoryAgentRunner } from "@copilotkit/runtime/v2";
import { createCopilotExpressHandler } from "@copilotkit/runtime/v2/express";
import type { AbstractAgent } from "@ag-ui/client";
import { z } from "zod";
import { RepoLensAgent } from "./agent.js";
import type { HealthInfo } from "../shared/contracts.js";
import { AppError } from "./errors.js";
import { LOCAL_EXECUTION_APPROVAL, LocalLauncher } from "./launcher.js";
import { repositorySessions } from "./session.js";

export interface ServerConfig {
  port: number;
  host: string;
  openaiApiKey?: string;
  model: string;
  githubToken?: string;
  allowedRepos?: string[];
  extensionId?: string;
  runLimitPerMinute?: number;
  localExecutionEnabled?: boolean;
  workspaceRoot?: string;
}

export function readConfig(): ServerConfig {
  const port = Number(process.env.PORT || 3001);
  const host = process.env.HOST || "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("This MVP only supports a local backend. Use HOST=127.0.0.1.");
  if (process.env.EXTENSION_ID && !/^[a-p]{32}$/.test(process.env.EXTENSION_ID)) throw new Error("EXTENSION_ID must be a Chrome extension ID.");
  return {
    port, host,
    openaiApiKey: process.env.OPENAI_API_KEY?.trim() || undefined,
    model: process.env.OPENAI_MODEL?.trim() || "gpt-5.4",
    githubToken: process.env.GITHUB_TOKEN?.trim() || undefined,
    allowedRepos: process.env.GITHUB_ALLOWED_REPOS?.split(",").map((repo) => repo.trim().toLowerCase()).filter(Boolean),
    extensionId: process.env.EXTENSION_ID || undefined,
    localExecutionEnabled: process.env.ENABLE_LOCAL_EXECUTION?.trim().toLowerCase() === "true",
    workspaceRoot: process.env.REPOLENS_WORKSPACE_ROOT?.trim() || undefined,
  };
}

export function createApp(config: ServerConfig, agent: AbstractAgent = new RepoLensAgent(config), launcher = new LocalLauncher(Boolean(config.localExecutionEnabled), config.workspaceRoot)) {
  const app = express();
  app.disable("x-powered-by");
  const localOrigins = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, "http://127.0.0.1:5173", "http://localhost:5173"]);
  const allowedOrigin = (origin: string) => localOrigins.has(origin) || (
    /^chrome-extension:\/\/[a-p]{32}$/.test(origin) && (!config.extensionId || origin === `chrome-extension://${config.extensionId}`)
  );

  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      if (req.path.startsWith("/api/")) console.info(JSON.stringify({ event: "http", method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - started }));
    });
    res.setHeader("X-Content-Type-Options", "nosniff");
    const hostname = req.hostname;
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname)) {
      res.status(403).json({ error: { code: "FORBIDDEN_HOST", message: "Use the local RepoLens address." } });
      return;
    }
    const origin = req.headers.origin;
    if (origin && !allowedOrigin(origin)) {
      res.status(403).json({ error: { code: "PERMISSION_DENIED", message: "This origin is not allowed to access RepoLens." } });
      return;
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-CopilotKit-Runtime-Client-GQL-Version");
    }
    if (req.method === "OPTIONS") { res.sendStatus(204); return; }
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.get("/api/health", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ status: "ok", openaiConfigured: Boolean(config.openaiApiKey), githubConfigured: Boolean(config.githubToken), localExecutionEnabled: Boolean(config.localExecutionEnabled), model: config.model } satisfies HealthInfo);
  });

  const launchRequest = z.object({
    repositoryAnalysisId: z.string().uuid(), threadId: z.string().min(1).max(160),
    approval: z.literal(LOCAL_EXECUTION_APPROVAL),
  }).strict();
  const launchId = z.string().uuid();
  const sendLaunchError = (res: express.Response, error: unknown) => {
    const safe = error instanceof AppError ? error : new AppError("LOCAL_EXECUTION_FAILED", "The local project could not be controlled.", 500);
    res.status(safe.status).json({ error: { code: safe.code, message: safe.message, retryable: safe.retryable } });
  };
  app.post("/api/local-launch/start", (req, res) => {
    try {
      const command = launchRequest.parse(req.body);
      const session = repositorySessions.get(command.repositoryAnalysisId, command.threadId);
      res.status(202).json(launcher.start(session.recipe, command.approval));
    } catch (error) { sendLaunchError(res, error); }
  });
  app.get("/api/local-launch/:id", (req, res) => {
    try { res.setHeader("Cache-Control", "no-store"); res.json(launcher.get(launchId.parse(req.params.id))); }
    catch (error) { sendLaunchError(res, error); }
  });
  app.post("/api/local-launch/:id/stop", (req, res) => {
    try { res.json(launcher.stop(launchId.parse(req.params.id))); }
    catch (error) { sendLaunchError(res, error); }
  });

  const runStarts: number[] = [];
  app.use("/api/copilotkit/agent/repolens/run", (req, res, next) => {
    if (req.method !== "POST") { next(); return; }
    const now = Date.now();
    while (runStarts.length && runStarts[0]! < now - 60_000) runStarts.shift();
    if (runStarts.length >= (config.runLimitPerMinute ?? 10)) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many analyses. Please retry in a minute." } });
      return;
    }
    runStarts.push(now);
    next();
  });
  const runtime = new CopilotRuntime({ agents: { repolens: agent }, runner: new InMemoryAgentRunner() });
  app.use(createCopilotExpressHandler({ runtime, basePath: "/api/copilotkit", mode: "multi-route", cors: false }));

  if (existsSync(resolve("dist/index.html"))) {
    app.use(express.static(resolve("dist"), { index: "index.html" }));
  }
  app.use((_req, res) => res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found." } }));
  app.use((error: Error & { status?: number; type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(JSON.stringify({ event: "http_error", type: error.type || error.name }));
    res.status(error.status || 500).json({ error: { code: "REQUEST_ERROR", message: error.status === 413 ? "Request too large." : "Unable to process this request." } });
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = readConfig();
  createApp(config).listen(config.port, config.host, () => {
    console.info(JSON.stringify({ event: "server_started", url: `http://${config.host}:${config.port}`, model: config.model, openaiConfigured: Boolean(config.openaiApiKey), githubConfigured: Boolean(config.githubToken), localExecutionEnabled: Boolean(config.localExecutionEnabled) }));
  });
}
