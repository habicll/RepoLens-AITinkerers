import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { LocalLaunchStatus } from "../shared/contracts.js";
import type { LocalLaunchRecipe, LaunchStep } from "./project.js";
import { AppError } from "./errors.js";

const APPROVAL = "RUN_UNTRUSTED_REPOSITORY_CODE";
const FINAL = new Set<LocalLaunchStatus["status"]>(["exited", "stopped", "error"]);
type Entry = LocalLaunchStatus & { child: ChildProcessWithoutNullStreams | null; stopped: boolean };

function cleanLine(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, 1_200);
}
function publicStatus(entry: Entry): LocalLaunchStatus {
  const { child: _child, stopped: _stopped, ...status } = entry;
  return structuredClone(status);
}
function detectedUrl(line: string): string | null {
  for (const match of line.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:\/[^\s]*)?/gi)) {
    try {
      const parsed = new URL(match[0]);
      if (!parsed.port || Number(parsed.port) <= 65535) {
        if (parsed.hostname === "0.0.0.0") parsed.hostname = "127.0.0.1";
        return parsed.href;
      }
    } catch { /* keep looking */ }
  }
  return null;
}
export function localExecutionEnvironment(environment: NodeJS.ProcessEnv, isolatedHome: string): NodeJS.ProcessEnv {
  return {
    PATH: environment.PATH,
    HOME: isolatedHome,
    TMPDIR: environment.TMPDIR || tmpdir(),
    LANG: environment.LANG || "C.UTF-8",
    CI: "1",
    BROWSER: "none",
  };
}

export class LocalLauncher {
  private readonly entries = new Map<string, Entry>();
  private readonly root: string;

  constructor(private readonly enabled: boolean, workspaceRoot?: string) {
    this.root = resolve(workspaceRoot || resolve(tmpdir(), "repolens-workspaces"));
    if (!isAbsolute(this.root) || this.root === resolve("/") || this.root === resolve(homedir())) throw new Error("REPOLENS_WORKSPACE_ROOT must be a dedicated absolute directory.");
  }

  start(recipe: LocalLaunchRecipe | null, approval: unknown): LocalLaunchStatus {
    if (!this.enabled) throw new AppError("LOCAL_EXECUTION_DISABLED", "Local execution is disabled on this RepoLens server.", 403);
    if (!recipe || recipe.proposal.status !== "available") throw new AppError("LOCAL_EXECUTION_UNSUPPORTED", "This repository does not have a supported deterministic launch recipe.", 422);
    if (approval !== APPROVAL) throw new AppError("LOCAL_EXECUTION_APPROVAL_REQUIRED", "Review the commands and explicitly approve local repository execution.", 403);
    const active = [...this.entries.values()].filter(entry => !FINAL.has(entry.status)).length;
    if (active >= 2) throw new AppError("LOCAL_EXECUTION_BUSY", "Two local projects are already running or starting. Stop one and retry.", 429, true);
    this.prune();
    const id = randomUUID();
    const entry: Entry = {
      id, status: "queued", phase: "Preparing a temporary workspace", lines: [], url: null, exitCode: null,
      startedAt: new Date().toISOString(), finishedAt: null, child: null, stopped: false,
    };
    this.entries.set(id, entry);
    void this.launch(entry, recipe).catch(error => {
      if (entry.stopped) return;
      entry.status = "error";
      entry.phase = error instanceof AppError ? error.message : "The local project could not be started.";
      entry.finishedAt = new Date().toISOString();
      this.append(entry, `[RepoLens] ${entry.phase}`);
    });
    return publicStatus(entry);
  }

  get(id: string): LocalLaunchStatus {
    const entry = this.entries.get(id);
    if (!entry) throw new AppError("LOCAL_RUN_NOT_FOUND", "This local run is missing or has expired.", 404);
    return publicStatus(entry);
  }

  stop(id: string): LocalLaunchStatus {
    const entry = this.entries.get(id);
    if (!entry) throw new AppError("LOCAL_RUN_NOT_FOUND", "This local run is missing or has expired.", 404);
    if (!FINAL.has(entry.status)) {
      entry.stopped = true;
      if (entry.child?.pid) {
        try { process.kill(-entry.child.pid, "SIGTERM"); }
        catch { entry.child.kill("SIGTERM"); }
      }
      entry.status = "stopped";
      entry.phase = "Stopped by the user";
      entry.finishedAt = new Date().toISOString();
      this.append(entry, "[RepoLens] Process stopped.");
    }
    return publicStatus(entry);
  }

  private async launch(entry: Entry, recipe: LocalLaunchRecipe): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(resolve(this.root, ".home"), { recursive: true, mode: 0o700 });
    const directoryName = `${recipe.repository.owner}-${recipe.repository.repo}-${entry.id.slice(0, 8)}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
    const directory = resolve(this.root, directoryName);
    const stages: Array<{ status: Entry["status"]; phase: string; step: LaunchStep }> = [
      { status: "cloning", phase: "Cloning the public repository", step: { command: "git", args: ["clone", "--filter=blob:none", "--no-checkout", recipe.cloneUrl, directoryName], display: `git clone ${recipe.cloneUrl}`, cwd: "parent" } },
      { status: "cloning", phase: "Fetching the analyzed commit", step: { command: "git", args: ["-C", directory, "fetch", "--depth", "1", "origin", recipe.commitSha], display: `git fetch ${recipe.commitSha}`, cwd: "parent" } },
      { status: "cloning", phase: "Checking out the analyzed commit", step: { command: "git", args: ["-C", directory, "checkout", "--detach", "FETCH_HEAD"], display: "git checkout --detach FETCH_HEAD", cwd: "parent" } },
      { status: "installing", phase: "Installing npm dependencies", step: recipe.install },
    ];
    for (const stage of stages) {
      if (entry.stopped) return;
      entry.status = stage.status;
      entry.phase = stage.phase;
      this.append(entry, `[RepoLens] ${stage.step.display}`);
      await this.runStep(entry, stage.step, directory);
    }
    if (entry.stopped) return;
    entry.status = "starting";
    entry.phase = `Starting with ${recipe.start.display}`;
    this.append(entry, `[RepoLens] ${recipe.start.display}`);
    const child = this.spawnStep(recipe.start, directory);
    entry.child = child;
    this.attachOutput(entry, child);
    child.once("spawn", () => {
      if (!entry.stopped) { entry.status = "running"; entry.phase = "Project process is running"; }
    });
    child.once("error", error => {
      if (!entry.stopped) { entry.status = "error"; entry.phase = `Could not start npm: ${cleanLine(error.message)}`; entry.finishedAt = new Date().toISOString(); }
    });
    child.once("exit", code => {
      entry.child = null;
      entry.exitCode = code;
      if (!entry.stopped) {
        entry.status = code === 0 ? "exited" : "error";
        entry.phase = code === 0 ? "Project process exited" : `Project process exited with code ${code ?? "unknown"}`;
        entry.finishedAt = new Date().toISOString();
      }
    });
  }

  private runStep(entry: Entry, step: LaunchStep, repositoryDirectory: string): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = this.spawnStep(step, repositoryDirectory);
      entry.child = child;
      this.attachOutput(entry, child);
      child.once("error", error => rejectPromise(new AppError("LOCAL_COMMAND_FAILED", `Could not run ${step.command}: ${cleanLine(error.message)}`, 500)));
      child.once("exit", code => {
        entry.child = null;
        entry.exitCode = code;
        if (entry.stopped) { resolvePromise(); return; }
        if (code === 0) resolvePromise();
        else rejectPromise(new AppError("LOCAL_COMMAND_FAILED", `${step.display} exited with code ${code ?? "unknown"}.`, 500));
      });
    });
  }

  private spawnStep(step: LaunchStep, repositoryDirectory: string): ChildProcessWithoutNullStreams {
    const isolatedHome = resolve(this.root, ".home");
    const safeEnvironment = localExecutionEnvironment(process.env, isolatedHome);
    return spawn(step.command, step.args, {
      cwd: step.cwd === "parent" ? this.root : repositoryDirectory,
      env: safeEnvironment, shell: false, detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  private attachOutput(entry: Entry, child: ChildProcessWithoutNullStreams): void {
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || "";
        for (const line of lines) this.append(entry, line);
      });
      stream.on("end", () => { if (pending) this.append(entry, pending); });
    }
  }

  private append(entry: Entry, value: string): void {
    const line = cleanLine(value);
    if (!line) return;
    entry.lines.push(line);
    if (entry.lines.length > 500) entry.lines.splice(0, entry.lines.length - 500);
    entry.url ||= detectedUrl(line);
  }

  private prune(): void {
    for (const [id, entry] of this.entries) {
      if (entry.finishedAt && Date.now() - Date.parse(entry.finishedAt) > 60 * 60_000) this.entries.delete(id);
    }
    while (this.entries.size >= 20) {
      const final = [...this.entries].find(([, entry]) => FINAL.has(entry.status));
      if (!final) break;
      this.entries.delete(final[0]);
    }
  }
}

export const LOCAL_EXECUTION_APPROVAL = APPROVAL;
