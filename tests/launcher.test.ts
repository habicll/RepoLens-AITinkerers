import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { LocalLauncher, localExecutionEnvironment } from "../server/launcher.js";
import type { LocalLaunchRecipe } from "../server/project.js";

const recipe: LocalLaunchRecipe = {
  repository: { owner: "demo", repo: "app", url: "https://github.com/demo/app" },
  commitSha: "a".repeat(40), cloneUrl: "https://github.com/demo/app.git",
  install: { command: "npm", args: ["ci"], display: "npm ci", cwd: "repository" },
  start: { command: "npm", args: ["run", "dev"], display: "npm run dev", cwd: "repository" },
  proposal: { status: "available", runtime: "Node.js + npm", commands: ["npm ci", "npm run dev"], reason: "Supported", requiresApproval: true },
};
const runFile = promisify(execFile);

describe("local execution boundary", () => {
  it("never passes server credentials into repository processes", () => {
    const result = localExecutionEnvironment({ PATH: "/bin", TMPDIR: "/tmp", LANG: "fr_FR", OPENAI_API_KEY: "secret", GITHUB_TOKEN: "secret", DATABASE_URL: "secret" }, "/tmp/repolens-home");
    expect(result).toEqual({ PATH: "/bin", HOME: "/tmp/repolens-home", TMPDIR: "/tmp", LANG: "fr_FR", CI: "1", BROWSER: "none" });
  });
  it("requires both server opt-in and the exact per-run approval", () => {
    expect(() => new LocalLauncher(false).start(recipe, "RUN_UNTRUSTED_REPOSITORY_CODE")).toThrow(/disabled/);
    expect(() => new LocalLauncher(true).start(recipe, "yes")).toThrow(/explicitly approve/);
  });
  it("clones a trusted fixture, reports its local URL and stops its process group", { timeout: 20_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "repolens-launcher-test-"));
    const source = join(root, "source");
    const workspaces = join(root, "workspaces");
    const previousSecret = process.env.OPENAI_API_KEY;
    let launcher: LocalLauncher | null = null;
    let runId: string | null = null;
    try {
      await mkdir(source);
      await writeFile(join(source, "package.json"), JSON.stringify({
        name: "trusted-repolens-fixture", version: "1.0.0",
        scripts: { dev: "node -e \"console.log('Local: http://127.0.0.1:45678'); console.log('SECRET=' + (process.env.OPENAI_API_KEY || 'missing')); setInterval(() => {}, 1000)\"" },
      }));
      await runFile("git", ["init", "-q"], { cwd: source });
      await runFile("git", ["add", "package.json"], { cwd: source });
      await runFile("git", ["-c", "user.name=RepoLens Test", "-c", "user.email=test@repolens.local", "commit", "-qm", "fixture"], { cwd: source });
      const { stdout } = await runFile("git", ["rev-parse", "HEAD"], { cwd: source });
      process.env.OPENAI_API_KEY = "must-not-reach-the-project";
      launcher = new LocalLauncher(true, workspaces);
      const trustedRecipe: LocalLaunchRecipe = {
        ...recipe, commitSha: stdout.trim(), cloneUrl: source,
        install: { command: "npm", args: ["install", "--ignore-scripts"], display: "npm install --ignore-scripts", cwd: "repository" },
      };
      runId = launcher.start(trustedRecipe, "RUN_UNTRUSTED_REPOSITORY_CODE").id;
      let status = launcher.get(runId);
      const deadline = Date.now() + 12_000;
      while (status.status !== "running" && status.status !== "error" && Date.now() < deadline) { await delay(100); status = launcher.get(runId); }
      while (!status.lines.some(line => line.includes("SECRET=")) && status.status === "running" && Date.now() < deadline) { await delay(100); status = launcher.get(runId); }
      expect(status.status).toBe("running");
      expect(status.url).toBe("http://127.0.0.1:45678/");
      expect(status.lines).toContain("SECRET=missing");
      expect(status.lines.join("\n")).not.toContain("must-not-reach-the-project");
      expect(launcher.stop(runId).status).toBe("stopped");
      runId = null;
    } finally {
      if (runId && launcher) launcher.stop(runId);
      if (previousSecret === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousSecret;
      await rm(root, { recursive: true, force: true });
    }
  });
});
