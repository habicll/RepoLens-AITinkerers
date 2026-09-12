import { createHash } from "node:crypto";
import type { Coverage, LocalLaunchProposal, RepositoryMetadata, RepositoryRef, Snapshot, Source } from "../shared/contracts.js";
import { RepositoryRefSchema, repositoryKey } from "../shared/contracts.js";
import { AppError } from "./errors.js";

const API = "https://api.github.com";
const API_VERSION = "2026-03-10";
const README_LIMIT = 32_000;
const MANIFEST_LIMIT = 18_000;
const ROOT_PATH_LIMIT = 180;

type JsonObject = Record<string, unknown>;
type FetchResult = { status: number; data: unknown };

export interface LaunchStep { command: string; args: string[]; display: string; cwd: "parent" | "repository" }
export interface LocalLaunchRecipe {
  repository: RepositoryRef;
  commitSha: string;
  cloneUrl: string;
  install: LaunchStep;
  start: LaunchStep;
  proposal: LocalLaunchProposal;
}
export interface ProjectReader {
  metadata: RepositoryMetadata | null;
  snapshot: Snapshot | null;
  sources: Source[];
  coverage: Coverage;
  recipe: LocalLaunchRecipe | null;
  proposal: LocalLaunchProposal;
  bootstrap(): Promise<void>;
  evidence(): string;
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("GITHUB_INVALID_RESPONSE", "GitHub returned an invalid repository response.", 502, true);
  return value as JsonObject;
}
function text(value: unknown, max = 500): string { return typeof value === "string" ? value.slice(0, max) : ""; }
function integer(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function gitSha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40,64}$/i.test(value)) throw new AppError("GITHUB_INVALID_RESPONSE", "GitHub returned an invalid commit identifier.", 502, true);
  return value;
}
function decodeContent(value: JsonObject, limit: number): string {
  if (value.encoding !== "base64" || typeof value.content !== "string") throw new AppError("GITHUB_INVALID_RESPONSE", "GitHub did not return readable text content.", 502, true);
  const decoded = Buffer.from(value.content.replace(/\s/g, ""), "base64").toString("utf8");
  return decoded.replace(/\u0000/g, "").slice(0, limit);
}
function numbered(textValue: string): { excerpt: string; lineEnd: number } {
  const lines = textValue.split(/\r?\n/).slice(0, 400);
  return { excerpt: lines.map((line, index) => `${index + 1}: ${line}`).join("\n"), lineEnd: Math.max(lines.length, 1) };
}

export class GitHubProject implements ProjectReader {
  public metadata: RepositoryMetadata | null = null;
  public snapshot: Snapshot | null = null;
  public sources: Source[] = [];
  public coverage: Coverage = {
    commentsTotal: 0, commentsRead: 0, commentsTruncated: false, filesRead: 0,
    pathsDiscovered: 0, treeTruncated: false, codeSearch: "not_used", limits: [],
  };
  public recipe: LocalLaunchRecipe | null = null;
  public proposal: LocalLaunchProposal = {
    status: "unsupported", runtime: null, commands: [],
    reason: "Automatic launch is currently available for Node.js repositories with an npm script named dev, start, serve, or preview.",
    requiresApproval: true,
  };
  private readonly fullName: string;
  private readonly prefix: string;
  private readonly transport: typeof fetch;
  private bootstrapped = false;

  constructor(
    public readonly ref: RepositoryRef,
    private readonly options: { token?: string; allowedRepos?: string[]; fetch?: typeof fetch; localExecutionEnabled: boolean },
    private readonly signal: AbortSignal,
    private readonly report: (label: string) => void,
  ) {
    const parsed = RepositoryRefSchema.safeParse(ref);
    if (!parsed.success || ref.repo === "." || ref.repo === "..") throw new AppError("INVALID_REPOSITORY", "Invalid GitHub repository reference.");
    this.fullName = `${ref.owner}/${ref.repo}`;
    if (options.allowedRepos?.length && !options.allowedRepos.some(repo => repo.toLowerCase() === this.fullName.toLowerCase())) {
      throw new AppError("REPOSITORY_NOT_ALLOWED", "This repository is not enabled on the demo server.", 403);
    }
    this.prefix = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
    this.transport = options.fetch ?? globalThis.fetch;
  }

  private async request(path: string, maxBytes = 1_000_000, optional = false): Promise<FetchResult> {
    this.signal.throwIfAborted();
    let response: Response;
    try {
      response = await this.transport(`${API}${path}`, {
        headers: {
          Accept: "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": "RepoLens-Hackathon",
          ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
        },
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(15_000)]), redirect: "manual",
      });
    } catch {
      this.signal.throwIfAborted();
      throw new AppError("GITHUB_UNAVAILABLE", "Could not reach GitHub. Please retry.", 502, true);
    }
    if (optional && response.status === 404) { void response.body?.cancel().catch(() => undefined); return { status: 404, data: null }; }
    if (response.status === 401 || response.status === 403) { void response.body?.cancel().catch(() => undefined); throw new AppError("PERMISSION_DENIED", "GitHub denied access. Check the token and repository permissions.", 403); }
    if (response.status === 429) { void response.body?.cancel().catch(() => undefined); throw new AppError("GITHUB_RATE_LIMIT", "GitHub's rate limit has been reached. Wait before retrying.", 429, true); }
    if (response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => undefined); throw new AppError("GITHUB_MOVED", "This repository moved. Open its current GitHub URL and try again.", 409); }
    if (response.status === 404 || response.status === 410) { void response.body?.cancel().catch(() => undefined); throw new AppError("GITHUB_NOT_FOUND", "This GitHub repository is missing or inaccessible.", 404); }
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new AppError("GITHUB_ERROR", `GitHub returned HTTP ${response.status}.`, 502, response.status >= 500); }
    if (Number(response.headers.get("content-length") ?? 0) > maxBytes) { void response.body?.cancel().catch(() => undefined); throw new AppError("RESPONSE_TOO_LARGE", "This GitHub response exceeds the repository briefing budget.", 413); }
    const raw = await response.text();
    if (Buffer.byteLength(raw) > maxBytes) throw new AppError("RESPONSE_TOO_LARGE", "This GitHub response exceeds the repository briefing budget.", 413);
    try { return { status: response.status, data: JSON.parse(raw) }; }
    catch { throw new AppError("GITHUB_INVALID_RESPONSE", "GitHub returned invalid JSON.", 502, true); }
  }

  async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    this.report("Checking public repository access");
    const repository = object((await this.request(this.prefix)).data);
    if (repository.private !== false) throw new AppError("PERMISSION_DENIED", "Repository briefings currently support public GitHub repositories only.", 403);
    if (text(repository.full_name).toLowerCase() !== this.fullName.toLowerCase()) throw new AppError("PERMISSION_DENIED", "GitHub returned a different repository.", 403);
    const branch = text(repository.default_branch, 250);
    if (!branch) throw new AppError("EMPTY_REPOSITORY", "This repository has no default branch.", 422);
    this.metadata = {
      name: text(repository.name, 200) || this.ref.repo,
      description: text(repository.description, 600) || null,
      language: text(repository.language, 100) || null,
      stars: integer(repository.stargazers_count),
      topics: Array.isArray(repository.topics) ? repository.topics.filter((topic): topic is string => typeof topic === "string").slice(0, 20) : [],
      license: repository.license ? text(object(repository.license).spdx_id, 80) || null : null,
    };
    this.sources.push({
      id: "repository:metadata", kind: "repository", label: this.fullName, url: this.ref.url,
      excerpt: `Name: ${this.metadata.name}\nDescription: ${this.metadata.description ?? "none"}\nPrimary language: ${this.metadata.language ?? "unknown"}\nStars: ${this.metadata.stars}\nTopics: ${this.metadata.topics.join(", ") || "none"}\nLicense: ${this.metadata.license ?? "unknown"}`,
    });

    this.report("Pinning the default branch");
    const branchData = object((await this.request(`${this.prefix}/branches/${encodeURIComponent(branch)}`)).data);
    const commit = object(branchData.commit);
    const commitSha = gitSha(commit.sha);
    const rootTreeSha = gitSha(object(object(commit.commit).tree).sha);
    this.snapshot = { id: "", commitSha, branch, fetchedAt: new Date().toISOString() };

    this.report("Reading the README and project manifest");
    const [treeResult, readmeResult, packageResult] = await Promise.all([
      this.request(`${this.prefix}/git/trees/${rootTreeSha}`, 1_000_000),
      this.request(`${this.prefix}/readme?ref=${commitSha}`, 180_000, true),
      this.request(`${this.prefix}/contents/package.json?ref=${commitSha}`, 80_000, true),
    ]);
    const tree = object(treeResult.data);
    const entries = Array.isArray(tree.tree) ? tree.tree.map(object) : [];
    const paths = entries.map(entry => text(entry.path, 500)).filter(Boolean).slice(0, ROOT_PATH_LIMIT);
    this.coverage.pathsDiscovered = paths.length;
    this.coverage.treeTruncated = tree.truncated === true || entries.length > ROOT_PATH_LIMIT;
    if (this.coverage.treeTruncated) this.coverage.limits.push("Only the first part of the repository root was included.");

    if (readmeResult.status === 200) {
      const value = object(readmeResult.data);
      const path = text(value.path, 500) || "README.md";
      const readme = numbered(decodeContent(value, README_LIMIT));
      this.sources.push({ id: "readme:root", kind: "readme", label: `${path}:1–${readme.lineEnd}`, url: `https://github.com/${this.fullName}/blob/${commitSha}/${path}`, path, lineStart: 1, lineEnd: readme.lineEnd, excerpt: readme.excerpt });
      this.coverage.filesRead += 1;
      if (readme.excerpt.length >= README_LIMIT) this.coverage.limits.push("The README was shortened to the first 32,000 characters.");
    } else this.coverage.limits.push("No README was found on the default branch.");

    let packageJson: JsonObject | null = null;
    if (packageResult.status === 200) {
      const value = object(packageResult.data);
      const packageText = decodeContent(value, MANIFEST_LIMIT);
      try { packageJson = object(JSON.parse(packageText)); }
      catch { this.coverage.limits.push("package.json could not be parsed, so automatic launch is unavailable."); }
      const manifest = numbered(packageText);
      this.sources.push({ id: "file:package.json", kind: "file", label: `package.json:1–${manifest.lineEnd}`, url: `https://github.com/${this.fullName}/blob/${commitSha}/package.json`, path: "package.json", lineStart: 1, lineEnd: manifest.lineEnd, excerpt: manifest.excerpt });
      this.coverage.filesRead += 1;
    }

    this.configureLaunch(packageJson, new Set(paths), commitSha);
    this.snapshot.id = createHash("sha256").update(JSON.stringify({ repository: repositoryKey(this.ref), commitSha, sources: this.sources.map(source => [source.id, source.excerpt]) })).digest("hex").slice(0, 20);
    this.bootstrapped = true;
    this.report("Repository context ready");
  }

  private configureLaunch(packageJson: JsonObject | null, paths: Set<string>, commitSha: string): void {
    const scriptsValue = packageJson?.scripts;
    const scripts = scriptsValue && typeof scriptsValue === "object" && !Array.isArray(scriptsValue) ? scriptsValue as JsonObject : {};
    const script = ["dev", "start", "serve", "preview"].find(name => typeof scripts[name] === "string" && scripts[name]);
    if (!packageJson || !script) return;
    const installArgs = paths.has("package-lock.json") || paths.has("npm-shrinkwrap.json") ? ["ci"] : ["install"];
    const proposal: LocalLaunchProposal = {
      status: this.options.localExecutionEnabled ? "available" : "disabled",
      runtime: "Node.js + npm",
      commands: [
        `git clone --filter=blob:none --no-checkout https://github.com/${this.fullName}.git <temporary-workspace>`,
        `git -C <temporary-workspace> fetch --depth 1 origin ${commitSha}`,
        "git -C <temporary-workspace> checkout --detach FETCH_HEAD",
        `npm ${installArgs.join(" ")}`,
        `npm run ${script}`,
      ],
      reason: this.options.localExecutionEnabled
        ? "RepoLens can clone this exact snapshot into a temporary folder, install its npm dependencies, and start its documented package script."
        : "Local execution is disabled on this RepoLens server. Set ENABLE_LOCAL_EXECUTION=true and restart it to offer the controlled launcher.",
      requiresApproval: true,
    };
    this.proposal = proposal;
    this.recipe = {
      repository: this.ref, commitSha, cloneUrl: `https://github.com/${this.fullName}.git`, proposal,
      install: { command: "npm", args: installArgs, display: `npm ${installArgs.join(" ")}`, cwd: "repository" },
      start: { command: "npm", args: ["run", script], display: `npm run ${script}`, cwd: "repository" },
    };
  }

  evidence(): string {
    if (!this.bootstrapped || !this.snapshot) throw new AppError("NOT_READY", "Load this repository before producing its briefing.", 409);
    return JSON.stringify({ repository: this.ref, metadata: this.metadata, snapshot: this.snapshot, rootPaths: this.coverage.pathsDiscovered, sources: this.sources.map(({ id, kind, label, path, lineStart, lineEnd, excerpt }) => ({ id, kind, label, path, lineStart, lineEnd, excerpt })) });
  }
}
