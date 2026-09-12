import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { get, type Server } from "node:http";
import { createApp } from "../server/index.js";

describe("local API boundary", () => {
  let server: Server;
  let origin: string;
  beforeAll(async () => {
    const app = createApp({ port: 3001, host: "127.0.0.1", model: "test", openaiApiKey: "server-only-test-credential" });
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test listener");
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("rejects browser requests from unrelated sites before reaching the paid agent", async () => {
    const response = await fetch(`${origin}/api/copilotkit/agent/repolens/run`, {
      method: "POST", headers: { Origin: "https://unrelated.example", "Content-Type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toMatchObject({ error: { code: "PERMISSION_DENIED" } });
  });

  it("rejects a non-loopback host even if it resolves to the local server", async () => {
    // Native HTTP preserves the explicit Host header used in a rebinding request.
    const response = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
      get(`${origin}/api/health`, { headers: { Host: "unrelated.example" } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
        res.on("error", reject);
      }).on("error", reject);
    });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "FORBIDDEN_HOST" } });
  });

  it("allows the local UI and exposes configuration flags without credentials", async () => {
    const response = await fetch(`${origin}/api/health`, { headers: { Origin: "http://127.0.0.1:5173" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    expect(await response.json()).toEqual({ status: "ok", openaiConfigured: true, githubConfigured: false, localExecutionEnabled: false, model: "test" });
  });

  it("keeps local execution disabled without an explicit server opt-in", async () => {
    const response = await fetch(`${origin}/api/local-launch/start`, {
      method: "POST", headers: { Origin: "http://127.0.0.1:5173", "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryAnalysisId: crypto.randomUUID(), threadId: "thread", approval: "RUN_UNTRUSTED_REPOSITORY_CODE" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "REPOSITORY_ANALYSIS_REQUIRED" } });
  });
});
