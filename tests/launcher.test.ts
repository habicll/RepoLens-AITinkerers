import { describe, expect, it } from "vitest";
import { LocalLauncher, localExecutionEnvironment } from "../server/launcher.js";
import type { LocalLaunchRecipe } from "../server/project.js";

const recipe: LocalLaunchRecipe = {
  repository: { owner: "demo", repo: "app", url: "https://github.com/demo/app" },
  commitSha: "a".repeat(40), cloneUrl: "https://github.com/demo/app.git",
  install: { command: "npm", args: ["ci"], display: "npm ci", cwd: "repository" },
  start: { command: "npm", args: ["run", "dev"], display: "npm run dev", cwd: "repository" },
  proposal: { status: "available", runtime: "Node.js + npm", commands: ["npm ci", "npm run dev"], reason: "Supported", requiresApproval: true },
};

describe("local execution boundary", () => {
  it("never passes server credentials into repository processes", () => {
    const result = localExecutionEnvironment({ PATH: "/bin", TMPDIR: "/tmp", LANG: "fr_FR", OPENAI_API_KEY: "secret", GITHUB_TOKEN: "secret", DATABASE_URL: "secret" }, "/tmp/repolens-home");
    expect(result).toEqual({ PATH: "/bin", HOME: "/tmp/repolens-home", TMPDIR: "/tmp", LANG: "fr_FR", CI: "1", BROWSER: "none" });
  });
  it("requires both server opt-in and the exact per-run approval", () => {
    expect(() => new LocalLauncher(false).start(recipe, "RUN_UNTRUSTED_REPOSITORY_CODE")).toThrow(/disabled/);
    expect(() => new LocalLauncher(true).start(recipe, "yes")).toThrow(/explicitly approve/);
  });
});
