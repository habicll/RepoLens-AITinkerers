import { createHash } from "node:crypto";
import type { Coverage, IssueMetadata, IssueRef, Snapshot, Source } from "../shared/contracts";
import { IssueRefSchema, issueKey } from "../shared/contracts";
import { AppError } from "./errors";

const API = "https://api.github.com";
const API_VERSION = "2026-03-10";
const MAX_FILE_BYTES = 100_000;
const MAX_FILES = 6;
const MAX_LINES = 160;
const MAX_EXCERPT_CHARS = 12_000;
const MAX_TEXT_CHARS = 64_000;
const MAX_COMMENT_CHARS = 24_000;
const MAX_COMMENTS = 100;
const MAX_DIRECTORY_ENTRIES = 800;
const MAX_VISIBLE_PATHS = 120;
const MAX_DISCOVERED_PATHS = 5_000;
const MAX_TREE_REQUESTS = 14;
const MAX_API_REQUESTS = 36;
const CACHE_MAX_ENTRIES = 128;
const CACHE_MAX_BYTES = 8_000_000;
const PARTIAL_EXPLORATION = "Repository exploration is partial:";

type JsonObject = Record<string, unknown>;
interface TreeEntry { path: string; type: "blob" | "tree"; mode: string; sha: string; size?: number }
interface CacheEntry { data: unknown; expires: number; bytes: number }
interface FileResult {
  path: string;
  sourceId: string;
  sourceIds: string[];
  text: string;
  lineStart: number;
  lineEnd: number;
  lineCount: number;
  truncated: boolean;
  url: string;
}

// Public data only. Separate transports also keep mock clients and independent hosts isolated.
const caches = new WeakMap<typeof fetch, Map<string, CacheEntry>>();
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("GITHUB_INVALID_RESPONSE", "GitHub returned an invalid response.", 502, true);
  }
  return value as JsonObject;
}
function string(value: unknown, max = 500): string { return typeof value === "string" ? value.slice(0, max) : ""; }
function count(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40,64}$/i.test(value)) {
    throw new AppError("GITHUB_INVALID_RESPONSE", "GitHub returned an invalid commit or tree identifier.", 502, true);
  }
  return value;
}
function login(value: unknown): string {
  return value && typeof value === "object" ? string((value as JsonObject).login, 100) : "unknown";
}
function encodedPath(path: string): string { return path.split("/").map(encodeURIComponent).join("/"); }
function validatePath(path: string, allowRoot = false): string {
  if (allowRoot && path === "") return path;
  if (typeof path !== "string" || !path || path.length > 500 || /[\\\u0000-\u001f\u007f]/.test(path)
    || path.split("/").some(segment => !segment || segment === "." || segment === "..")
    || path.split("/").length > 15) {
    throw new AppError("INVALID_PATH", "Use a repository-relative path without parent-directory segments.");
  }
  if (blockedPath(path)) throw new AppError("BLOCKED_PATH", "Secret, dependency and generated paths are excluded from analysis.");
  return path;
}
function blockedPath(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  return parts.some(part => /^(?:\.git|\.ssh|\.aws|\.azure|\.kube|node_modules|vendor|dist|build|coverage|\.next|\.venv|venv|__pycache__)$/.test(part)
    || /^\.env(?:\.|$)/.test(part)
    || /^(?:\.npmrc|\.pypirc|\.netrc|credentials(?:\.[\w-]+)?|secrets?(?:\.[\w-]+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/.test(part)
    || /\.(?:pem|key|p12|pfx|keystore|jks|lock|lockb)$/.test(part)
    || /^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(part));
}
function isTextPath(path: string): boolean {
  return !/\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|bz2|xz|7z|woff2?|ttf|eot|mp[34]|wav|ogg|mov|avi|sqlite3?|db|wasm|exe|dll|so|dylib|bin|class|jar|pyc)$/i.test(path);
}

export class GitHubRepository {
  public metadata: IssueMetadata | null = null;
  public snapshot: Snapshot | null = null;
  public sources: Source[] = [];
  public coverage: Coverage = {
    commentsTotal: 0, commentsRead: 0, commentsTruncated: false, filesRead: 0,
    pathsDiscovered: 0, treeTruncated: false, codeSearch: "not_used", limits: [],
  };
  private readonly transport: typeof fetch;
  private readonly prefix: string;
  private readonly fullName: string;
  private readonly cache: Map<string, CacheEntry>;
  private readonly entries = new Map<string, TreeEntry>();
  private readonly directories = new Map<string, TreeEntry[]>();
  private readonly files = new Map<string, string>();
  private readonly excerpts = new Map<string, FileResult>();
  private issueSource: Source | null = null;
  private comments: Source[] = [];
  private readme: FileResult | null = null;
  private readmePath: string | null = null;
  private rootTreeSha = "";
  private textChars = 0;
  private treeRequests = 0;
  private apiRequests = 0;
  private searchRequests = 0;
  private bootstrapped = false;

  constructor(
    private readonly ref: IssueRef,
    private readonly options: { token?: string; allowedRepos?: string[]; fetch?: typeof fetch },
    private readonly signal: AbortSignal,
    private readonly report: (label: string) => void,
  ) {
    const parsed = IssueRefSchema.safeParse(ref);
    if (!parsed.success || ref.repo === "." || ref.repo === "..") throw new AppError("INVALID_ISSUE", "Invalid GitHub issue reference.");
    this.fullName = `${ref.owner}/${ref.repo}`;
    if (options.allowedRepos?.length && !options.allowedRepos.some(repo => repo.toLowerCase() === this.fullName.toLowerCase())) {
      throw new AppError("PERMISSION_DENIED", "This repository is not enabled for this demo.", 403);
    }
    this.transport = options.fetch ?? globalThis.fetch;
    this.prefix = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
    let cache = caches.get(this.transport);
    if (!cache) { cache = new Map(); caches.set(this.transport, cache); }
    this.cache = cache;
  }

  private limit(message: string): void {
    if (!this.coverage.limits.includes(message)) this.coverage.limits.push(message);
  }
  private updateTreeCoverage(): void {
    this.coverage.pathsDiscovered = this.entries.size;
    const unvisited = [...this.entries.values()].filter(entry => entry.type === "tree" && !this.directories.has(entry.path)).length;
    this.coverage.limits = this.coverage.limits.filter(limit => !limit.startsWith(PARTIAL_EXPLORATION));
    if (unvisited) this.limit(`${PARTIAL_EXPLORATION} ${unvisited} discovered ${unvisited === 1 ? "directory remains" : "directories remain"} unvisited. The path count covers explored directories, not the complete repository.`);
  }
  private ensureReady(): void {
    if (!this.bootstrapped || !this.snapshot) throw new AppError("NOT_READY", "Load the GitHub issue before exploring its repository.", 409);
    this.signal.throwIfAborted();
  }

  private async request(path: string, ttl = 0, maxBytes = 1_500_000, version = ""): Promise<unknown> {
    this.signal.throwIfAborted();
    const key = `${path}|${version}`;
    const cached = ttl > 0 ? this.cache.get(key) : undefined;
    if (cached && cached.expires > Date.now()) return structuredClone(cached.data);
    if (cached) this.cache.delete(key);
    if (++this.apiRequests > MAX_API_REQUESTS) {
      this.limit("GitHub request budget reached; repository coverage is partial.");
      throw new AppError("CONTEXT_BUDGET", "The GitHub request budget for this analysis has been reached.", 429);
    }
    // Only fixed API routes built by this class. Never follow redirects carrying the token.
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
    } catch (error) {
      this.signal.throwIfAborted();
      throw new AppError("GITHUB_UNAVAILABLE", "Could not reach GitHub. Please retry.", 502, true);
    }
    if (response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")))) {
      void response.body?.cancel().catch(() => undefined);
      throw new AppError("GITHUB_RATE_LIMIT", "GitHub's rate limit has been reached. Wait before retrying.", 429, true);
    }
    if (response.status === 401 || response.status === 403) {
      void response.body?.cancel().catch(() => undefined);
      throw new AppError("PERMISSION_DENIED", "GitHub denied access. Check the server's GitHub token and repository permissions.", 403);
    }
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => undefined);
      throw new AppError("GITHUB_MOVED", "This GitHub resource moved. Open its current issue URL and try again.", 409);
    }
    if (response.status === 404 || response.status === 410) {
      void response.body?.cancel().catch(() => undefined);
      throw new AppError("GITHUB_NOT_FOUND", "This GitHub resource is missing or inaccessible.", 404);
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new AppError("GITHUB_ERROR", `GitHub returned HTTP ${response.status}.`, 502, response.status >= 500);
    }
    if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
      void response.body?.cancel().catch(() => undefined);
      throw new AppError("RESPONSE_TOO_LARGE", "This GitHub response exceeds the demo's retrieval budget.", 413);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AppError("GITHUB_INVALID_RESPONSE", "GitHub returned an empty response.", 502, true);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        this.signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxBytes) {
          void reader.cancel().catch(() => undefined);
          throw new AppError("RESPONSE_TOO_LARGE", "This GitHub response exceeds the demo's retrieval budget.", 413);
        }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    let data: unknown;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new AppError("GITHUB_INVALID_RESPONSE", "GitHub returned invalid JSON.", 502, true); }
    if (ttl > 0) {
      this.cache.set(key, { data: structuredClone(data), expires: Date.now() + ttl, bytes });
      let size = [...this.cache.values()].reduce((total, entry) => total + entry.bytes, 0);
      while (this.cache.size > CACHE_MAX_ENTRIES || size > CACHE_MAX_BYTES) {
        const oldest = this.cache.keys().next().value as string | undefined;
        if (!oldest) break;
        size -= this.cache.get(oldest)!.bytes;
        this.cache.delete(oldest);
      }
    }
    return data;
  }

  private addTextSource(source: Source, maxChars: number): Source | null {
    const available = Math.min(maxChars, MAX_TEXT_CHARS - this.textChars);
    if (available <= 0) { this.limit("Total source-text budget reached; some evidence was not read."); return null; }
    const excerpt = source.excerpt.slice(0, available);
    if (excerpt.length < source.excerpt.length) this.limit(`${source.label}: source text was shortened to fit the retrieval budget.`);
    const stored = { ...source, excerpt };
    this.sources.push(stored);
    this.textChars += excerpt.length;
    return stored;
  }

  async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    this.report("Checking public repository access");
    // Visibility is always rechecked live before any issue, comment, or cached code content.
    const repository = object(await this.request(this.prefix));
    if (repository.private !== false) throw new AppError("PERMISSION_DENIED", "The demo supports public GitHub repositories only.", 403);
    if (string(repository.full_name).toLowerCase() !== this.fullName.toLowerCase()) {
      throw new AppError("PERMISSION_DENIED", "GitHub returned a different repository. Open the issue's current URL.", 403);
    }
    const branch = string(repository.default_branch, 250);
    if (!branch) throw new AppError("EMPTY_REPOSITORY", "This repository has no default branch.", 422);
    this.report("Reading issue and fixing a code snapshot");
    const [issueResult, branchResult] = await Promise.allSettled([
      this.request(`${this.prefix}/issues/${this.ref.number}`, 15_000),
      this.request(`${this.prefix}/branches/${encodeURIComponent(branch)}`),
    ]);
    // Settle the wave before touching shared state or propagating failures.
    if (issueResult.status === "rejected") throw issueResult.reason;
    if (branchResult.status === "rejected") throw branchResult.reason;
    const issue = object(issueResult.value);
    const branchData = object(branchResult.value);
    if (issue.pull_request) throw new AppError("UNSUPPORTED_PAGE", "Open a GitHub issue. Pull request analysis is outside this demo.", 422);
    this.metadata = {
      title: string(issue.title, 500), state: string(issue.state, 30), author: login(issue.user),
      labels: Array.isArray(issue.labels) ? issue.labels.slice(0, 30).map(label => typeof label === "string" ? label.slice(0, 100) : string(object(label).name, 100)) : [],
      assignees: Array.isArray(issue.assignees) ? issue.assignees.slice(0, 20).map(login) : [],
      milestone: issue.milestone ? string(object(issue.milestone).title, 250) : null,
    };
    this.coverage.commentsTotal = count(issue.comments);
    this.issueSource = this.addTextSource({
      id: `issue:${this.ref.number}`, kind: "issue", url: `https://github.com/${this.fullName}/issues/${this.ref.number}`,
      label: `Issue #${this.ref.number}`, author: this.metadata.author, createdAt: string(issue.created_at, 40),
      excerpt: `${this.metadata.title}\nState: ${this.metadata.state}\nLabels: ${this.metadata.labels.join(", ")}\nAssignees: ${this.metadata.assignees.join(", ")}\nMilestone: ${this.metadata.milestone ?? "none"}\n\n${string(issue.body, 200_000)}`,
    }, 8_000);
    const commit = object(branchData.commit);
    const commitSha = sha(commit.sha);
    this.rootTreeSha = sha(object(object(commit.commit).tree).sha);
    this.snapshot = { id: "", commitSha, branch, fetchedAt: new Date().toISOString() };
    this.report("Reading discussion, README and repository structure");
    const [commentsResult, treeResult, readmeResult] = await Promise.allSettled([
      this.loadComments(string(issue.updated_at, 100)),
      this.loadDirectory("", this.rootTreeSha),
      this.request(`${this.prefix}/readme?ref=${commitSha}`, 600_000, 160_000),
    ]);
    if (commentsResult.status === "rejected") throw commentsResult.reason;
    if (treeResult.status === "rejected") throw treeResult.reason;
    this.snapshot.id = createHash("sha256").update(JSON.stringify({
      issue: issueKey(this.ref), updated: issue.updated_at, commitSha,
      evidence: this.sources.map(source => [source.id, source.excerpt]),
    })).digest("hex").slice(0, 20);
    this.bootstrapped = true;
    this.report("Verifying README against the code snapshot");
    try {
      // README retrieval overlaps the root tree, but verification and source-budget
      // mutations happen only after that tree and the comments have settled.
      if (readmeResult.status === "rejected") throw readmeResult.reason;
      const readmeData = object(readmeResult.value);
      const path = validatePath(string(readmeData.path, 501));
      const entry = await this.locate(path);
      this.readmePath = path;
      await this.loadTextFile(path, entry, readmeData);
      this.readme = this.makeFileExcerpt(path, 1, MAX_LINES);
    } catch (error) {
      if (error instanceof AppError && ["GITHUB_NOT_FOUND", "BLOCKED_PATH", "UNSUPPORTED_FILE", "FILE_TOO_LARGE", "RESPONSE_TOO_LARGE", "CONTEXT_BUDGET"].includes(error.code)) {
        this.limit(`README unavailable: ${error.message}`);
      } else throw error;
    }
    this.report("GitHub context ready");
  }

  private async loadComments(version: string): Promise<void> {
    if (!this.coverage.commentsTotal) return;
    this.report("Reading issue discussion");
    let chars = 0;
    let page = 1;
    let more = true;
    const seen = new Set<number>();
    while (more && this.coverage.commentsRead < MAX_COMMENTS && chars < MAX_COMMENT_CHARS) {
      const result = await this.request(`${this.prefix}/issues/${this.ref.number}/comments?per_page=50&page=${page}`, 15_000, 1_000_000, version);
      if (!Array.isArray(result)) throw new AppError("GITHUB_INVALID_RESPONSE", "GitHub returned invalid issue comments.", 502, true);
      more = result.length >= 50;
      for (const value of result.slice(0, 50)) {
        if (this.coverage.commentsRead >= MAX_COMMENTS || chars >= MAX_COMMENT_CHARS) break;
        const comment = object(value);
        const id = count(comment.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const body = string(comment.body, 200_000) || "[Empty comment]";
        const source = this.addTextSource({
          id: `comment:${id}`, kind: "comment", label: `Comment by ${login(comment.user)}`,
          url: `https://github.com/${this.fullName}/issues/${this.ref.number}#issuecomment-${id}`,
          author: login(comment.user), createdAt: string(comment.created_at, 40), excerpt: body,
        }, Math.min(4_000, MAX_COMMENT_CHARS - chars));
        if (!source) break;
        this.comments.push(source);
        chars += source.excerpt.length;
        this.coverage.commentsRead++;
        if (source.excerpt.length < body.length) this.coverage.commentsTruncated = true;
      }
      page++;
      if (page > 2) break;
    }
    if (this.coverage.commentsRead < this.coverage.commentsTotal) {
      this.coverage.commentsTruncated = true;
    }
    if (this.coverage.commentsTruncated) this.limit("Discussion coverage is partial: at most 100 chronological comments and 24,000 characters, with at most 4,000 characters per comment. Later discussion may be missing.");
  }

  getSeed(): unknown {
    this.ensureReady();
    return {
      issue: { ref: this.ref, metadata: this.metadata, sourceId: this.issueSource?.id, text: this.issueSource?.excerpt },
      comments: this.comments.map(source => ({ sourceId: source.id, author: source.author, createdAt: source.createdAt, text: source.excerpt })),
      repository: { fullName: this.fullName, snapshot: this.snapshot, overview: this.directoryView(""), readme: this.readme },
      coverage: structuredClone(this.coverage),
    };
  }

  private async loadDirectory(directory: string, treeSha: string): Promise<TreeEntry[]> {
    const existing = this.directories.get(directory);
    if (existing) return existing;
    if (++this.treeRequests > MAX_TREE_REQUESTS) {
      this.coverage.treeTruncated = true;
      this.limit("Directory exploration budget reached; the repository tree is incomplete.");
      throw new AppError("CONTEXT_BUDGET", "The directory exploration budget has been reached.", 429);
    }
    let data: JsonObject;
    try { data = object(await this.request(`${this.prefix}/git/trees/${sha(treeSha)}`, 600_000)); }
    catch (error) {
      if (error instanceof AppError && error.code === "RESPONSE_TOO_LARGE") {
        this.coverage.treeTruncated = true;
        this.limit(`Directory ${directory || "/"} exceeds the retrieval budget.`);
        this.directories.set(directory, []);
        this.updateTreeCoverage();
        return [];
      }
      throw error;
    }
    if (!Array.isArray(data.tree)) throw new AppError("GITHUB_INVALID_RESPONSE", "GitHub returned an invalid repository tree.", 502, true);
    if (data.truncated === true || data.tree.length > MAX_DIRECTORY_ENTRIES) {
      this.coverage.treeTruncated = true;
      this.limit(`Directory ${directory || "/"}: GitHub or the directory-size limit omitted some paths.`);
    }
    const entries: TreeEntry[] = [];
    for (const raw of data.tree.slice(0, MAX_DIRECTORY_ENTRIES)) {
      const entry = object(raw);
      const name = string(entry.path, 501);
      // Non-recursive trees contain basenames. Do not accept path tricks or follow symlinks/submodules.
      if (!name || name.includes("/") || name === "." || name === "..") continue;
      const path = directory ? `${directory}/${name}` : name;
      try { validatePath(path); } catch { continue; }
      if (!((entry.type === "tree" && entry.mode === "040000") || (entry.type === "blob" && ["100644", "100755"].includes(string(entry.mode))))) continue;
      if (this.entries.size >= MAX_DISCOVERED_PATHS) {
        this.coverage.treeTruncated = true;
        this.limit("Repository path budget reached; only discovered paths are searchable.");
        break;
      }
      const parsed: TreeEntry = { path, type: entry.type as "blob" | "tree", mode: string(entry.mode), sha: sha(entry.sha), size: typeof entry.size === "number" ? entry.size : undefined };
      entries.push(parsed);
      this.entries.set(path, parsed);
    }
    this.directories.set(directory, entries);
    this.updateTreeCoverage();
    return entries;
  }

  private async locate(path: string): Promise<TreeEntry> {
    validatePath(path);
    let directory = "";
    let treeSha = this.rootTreeSha;
    const parts = path.split("/");
    for (let index = 0; index < parts.length; index++) {
      await this.loadDirectory(directory, treeSha);
      const current = directory ? `${directory}/${parts[index]}` : parts[index];
      const entry = this.entries.get(current);
      if (!entry) throw new AppError("GITHUB_NOT_FOUND", "This path is absent from the inspected snapshot or excluded (symlink, submodule, or retrieval limit).", 404);
      if (index === parts.length - 1) return entry;
      if (entry.type !== "tree") throw new AppError("INVALID_PATH", "A file cannot be traversed as a directory.");
      directory = current;
      treeSha = entry.sha;
    }
    throw new AppError("INVALID_PATH", "Invalid repository path.");
  }

  private directoryView(directory: string): unknown {
    const entries = this.directories.get(directory) ?? [];
    const partial = entries.length > MAX_VISIBLE_PATHS;
    const unvisitedDirectories = entries.filter(entry => entry.type === "tree" && !this.directories.has(entry.path)).length;
    if (partial) {
      this.coverage.treeTruncated = true;
      this.limit(`Directory ${directory || "/"}: only ${MAX_VISIBLE_PATHS} paths are shown; search can query the discovered paths.`);
    }
    return {
      directory: directory || "/", commitSha: this.snapshot?.commitSha,
      entries: entries.slice(0, MAX_VISIBLE_PATHS).map(entry => ({ path: entry.path, type: entry.type === "tree" ? "directory" : "file", bytes: entry.size })),
      shown: Math.min(entries.length, MAX_VISIBLE_PATHS), discovered: entries.length,
      partial: partial || this.coverage.treeTruncated || unvisitedDirectories > 0,
      unvisitedDirectories,
      note: "Paths are candidates, not source evidence. Read a file before citing it. This is a shallow directory view; request overview(directory) to explore children.",
    };
  }

  async overview(directory = ""): Promise<unknown> {
    this.ensureReady();
    validatePath(directory, true);
    this.report(`Exploring ${directory || "repository root"}`);
    if (directory) {
      const entry = await this.locate(directory);
      if (entry.type !== "tree") throw new AppError("INVALID_PATH", "Use read_file for a file, or overview for a directory.");
      await this.loadDirectory(directory, entry.sha);
    }
    const result = this.directoryView(directory);
    return { result, coverage: structuredClone(this.coverage) };
  }

  async search(terms: string, pathPrefix = ""): Promise<unknown> {
    this.ensureReady();
    validatePath(pathPrefix, true);
    if (typeof terms !== "string" || terms.length > 300) throw new AppError("INVALID_QUERY", "Search with a short symbol, filename, or error term.");
    // Literal tokens only: model-provided qualifiers/operators never reach GitHub.
    const words = [...new Set(terms.match(/[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}/g) ?? [])].slice(0, 4);
    if (!words.length) throw new AppError("INVALID_QUERY", "Enter at least one searchable word.");
    this.report(`Searching for ${words.join(" ")}`);
    const scope = pathPrefix ? (await this.locate(pathPrefix)) : null;
    if (scope?.type === "tree") await this.loadDirectory(scope.path, scope.sha);
    if (!scope) {
      // Cheap, explicit fallback without downloading repository contents or building an index.
      const candidates = (this.directories.get("") ?? []).filter(entry => entry.type === "tree" && /^(?:src|lib|app|tests?|packages)$/.test(entry.path)).slice(0, 3);
      for (const entry of candidates) {
        if (this.treeRequests >= MAX_TREE_REQUESTS) break;
        await this.loadDirectory(entry.path, entry.sha);
      }
    }
    const inScope = (path: string) => !pathPrefix || path === pathPrefix || path.startsWith(`${pathPrefix}/`);
    const matches = [...this.entries.values()].filter(entry => inScope(entry.path)).map(entry => ({
      path: entry.path, type: entry.type === "tree" ? "directory" : "file",
      score: words.reduce((score, word) => score + (entry.path.toLowerCase().includes(word.toLowerCase()) ? 1 : 0), 0),
      via: "path" as string,
    })).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 20);
    if (!this.options.token) {
      this.coverage.codeSearch = "unavailable";
      this.limit("GitHub code search is unavailable without a server token. Search covers discovered paths only.");
    } else if (this.searchRequests >= 3) {
      this.limit("Code-search budget reached (3 queries). Remaining searches use discovered paths.");
    } else {
      this.searchRequests++;
      const q = `${words.map(word => `"${word}"`).join(" ")} repo:${this.fullName}`;
      try {
        const result = object(await this.request(`/search/code?q=${encodeURIComponent(q)}&per_page=10`, 30_000));
        this.coverage.codeSearch = "available";
        if (result.incomplete_results) this.limit("GitHub code search returned incomplete results.");
        if (!Array.isArray(result.items)) throw new AppError("GITHUB_INVALID_RESPONSE", "GitHub returned invalid code-search results.", 502, true);
        for (const value of result.items.slice(0, 10)) {
          const item = object(value);
          const repository = object(item.repository);
          if (string(repository.full_name).toLowerCase() !== this.fullName.toLowerCase()) continue;
          const path = string(item.path, 501);
          try { validatePath(path); } catch { continue; }
          if (!inScope(path) || !isTextPath(path)) continue;
          if (!matches.some(match => match.path === path)) matches.push({ path, type: "file", score: 0, via: "github_code_search" });
        }
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        this.coverage.codeSearch = "unavailable";
        this.limit(`Code search unavailable (${error.code}); using discovered paths only.`);
      }
    }
    return {
      terms: words, pathPrefix, matches: matches.slice(0, 25), commitSha: this.snapshot!.commitSha,
      note: "Search results are candidates, not evidence. GitHub searches its indexed default branch, which may differ from this snapshot. Read candidates at this run's fixed commit before citing them. No match does not establish absence.",
      coverage: structuredClone(this.coverage),
    };
  }

  private async loadTextFile(path: string, entry: TreeEntry, supplied?: JsonObject): Promise<void> {
    if (this.files.has(path)) return;
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode) || !isTextPath(path)) {
      throw new AppError("UNSUPPORTED_FILE", "Only regular text files can be read. Binaries, symlinks and submodules are excluded.", 422);
    }
    if (entry.size !== undefined && entry.size > MAX_FILE_BYTES) throw new AppError("FILE_TOO_LARGE", "Files larger than 100 KB are outside the demo's retrieval budget.", 413);
    if (this.files.size >= MAX_FILES) {
      this.limit("File budget reached: at most 6 files including README.");
      throw new AppError("CONTEXT_BUDGET", "The six-file budget, including README, has been reached.", 429);
    }
    if (this.textChars >= MAX_TEXT_CHARS) throw new AppError("CONTEXT_BUDGET", "The source-text budget has been reached.", 429);
    const data = supplied ?? object(await this.request(`${this.prefix}/contents/${encodedPath(path)}?ref=${this.snapshot!.commitSha}`, 600_000, 160_000));
    if (data.type !== "file" || data.encoding !== "base64" || data.sha !== entry.sha || data.path !== path || data.submodule_git_url || data.target) {
      throw new AppError("UNSUPPORTED_FILE", "The requested file could not be verified as regular text in the fixed snapshot.", 422);
    }
    if (count(data.size) > MAX_FILE_BYTES) throw new AppError("FILE_TOO_LARGE", "Files larger than 100 KB are outside the demo's retrieval budget.", 413);
    if (typeof data.content !== "string" || !/^[A-Za-z0-9+/=\r\n]*$/.test(data.content)) throw new AppError("UNSUPPORTED_FILE", "The file has unsupported content encoding.", 422);
    const bytes = Buffer.from(data.content, "base64");
    if (bytes.byteLength > MAX_FILE_BYTES) throw new AppError("FILE_TOO_LARGE", "Files larger than 100 KB are outside the demo's retrieval budget.", 413);
    if (bytes.includes(0)) throw new AppError("UNSUPPORTED_FILE", "Binary file content is excluded from analysis.", 422);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new AppError("UNSUPPORTED_FILE", "Only UTF-8 text files are supported in this demo.", 422); }
    this.files.set(path, text.replace(/\r\n/g, "\n"));
    this.coverage.filesRead = this.files.size;
  }

  private makeFileExcerpt(path: string, startLine = 1, endLine = startLine + MAX_LINES - 1): FileResult | null {
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
      throw new AppError("INVALID_RANGE", "Line ranges must contain positive integers, with endLine at or after startLine.");
    }
    const text = this.files.get(path)!;
    const lines = text.split("\n");
    if (startLine > lines.length) return null;
    const end = Math.min(endLine, startLine + MAX_LINES - 1, lines.length);
    const key = `${path}:${startLine}-${end}`;
    const existing = this.excerpts.get(key);
    if (existing) return existing;
    let remaining = Math.min(MAX_EXCERPT_CHARS, MAX_TEXT_CHARS - this.textChars);
    if (remaining < 20) {
      this.limit("Total source-text budget reached; some evidence was not read.");
      throw new AppError("CONTEXT_BUDGET", "The source-text budget has been reached.", 429);
    }
    const rendered: string[] = [];
    let actualEnd = startLine;
    let shortened = endLine > end && end < lines.length;
    for (let line = startLine; line <= end; line++) {
      const numbered = `${line}: ${lines[line - 1]}`;
      const separator = rendered.length ? 1 : 0;
      if (remaining <= separator) { shortened = true; break; }
      if (numbered.length + separator > remaining) {
        if (!rendered.length) { rendered.push(numbered.slice(0, remaining)); actualEnd = line; }
        shortened = true;
        break;
      }
      rendered.push(numbered);
      remaining -= numbered.length + separator;
      actualEnd = line;
    }
    const excerpt = rendered.join("\n");
    const url = `https://github.com/${this.fullName}/blob/${this.snapshot!.commitSha}/${encodedPath(path)}#L${startLine}-L${actualEnd}`;
    const source: Source = {
      id: `file:${path}:${startLine}-${actualEnd}:${createHash("sha256").update(excerpt).digest("hex").slice(0, 8)}`, kind: path === this.readmePath ? "readme" : "file", path,
      label: `${path}:${startLine}-${actualEnd}`, url, excerpt, lineStart: startLine, lineEnd: actualEnd,
    };
    if (!this.sources.some(existingSource => existingSource.id === source.id)) {
      this.sources.push(source);
      this.textChars += excerpt.length;
    }
    if (shortened) this.limit(`${path}: excerpt shortened to fit the line or text budget; unread lines are not evidence.`);
    const result: FileResult = { path, sourceId: source.id, sourceIds: [source.id], text: excerpt, lineStart: startLine, lineEnd: actualEnd, lineCount: lines.length, truncated: shortened || actualEnd < lines.length || startLine > 1, url };
    this.excerpts.set(key, result);
    return result;
  }

  async readFile(path: string, startLine = 1, endLine = startLine + MAX_LINES - 1): Promise<unknown> {
    this.ensureReady();
    validatePath(path);
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
      throw new AppError("INVALID_RANGE", "Line ranges must contain positive integers, with endLine at or after startLine.");
    }
    this.report(`Reading ${path}`);
    const entry = await this.locate(path);
    await this.loadTextFile(path, entry);
    const result = this.makeFileExcerpt(path, startLine, endLine);
    return { result, ...(result ? {} : { status: "out_of_range", path, lineCount: this.files.get(path)!.split("\n").length }), coverage: structuredClone(this.coverage) };
  }
}
