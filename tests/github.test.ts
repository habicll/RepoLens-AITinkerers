import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubRepository } from "../server/github";
import type { IssueRef } from "../shared/contracts";

const ref: IssueRef = { owner: "demo", repo: "project", number: 12, url: "https://github.com/demo/project/issues/12" };
const hash = (value: string) => createHash("sha1").update(value).digest("hex");
const COMMIT = hash("fixed-commit");
interface MockOptions {
  private?: boolean;
  comments?: number;
  commentBody?: string;
  missingReadme?: boolean;
  truncated?: boolean;
  files?: Record<string, string | Uint8Array>;
  branch?: string;
  repositoryResponse?: Response;
  searchResults?: unknown[];
  oversizedRoot?: boolean;
}

function fixture(options: MockOptions = {}) {
  const files: Record<string, string | Uint8Array> = {
    "README.md": "# Demo\nRun npm install, then npm test.\n",
    "src/parser.ts": "export function parse(value: string) {\n  return value.trim();\n}\n",
    "tests/parser.test.ts": "// Regression test goes here.\n",
    ...options.files,
  };
  const branch = options.branch ?? "release/next";
  const requests: { url: URL; init: RequestInit | undefined }[] = [];
  const directories = new Map<string, Map<string, unknown>>([["", new Map()]]);
  for (const [path, body] of Object.entries(files)) {
    const segments = path.split("/");
    let directory = "";
    for (let i = 0; i < segments.length - 1; i++) {
      const parent = directory;
      directory = parent ? `${parent}/${segments[i]}` : segments[i];
      directories.get(parent)!.set(segments[i], { path: segments[i], mode: "040000", type: "tree", sha: hash(`tree:${directory}`) });
      if (!directories.has(directory)) directories.set(directory, new Map());
    }
    directories.get(directory)!.set(segments.at(-1)!, { path: segments.at(-1), mode: "100644", type: "blob", sha: hash(path), size: Buffer.byteLength(body) });
  }
  directories.get("")!.set("alias", { path: "alias", mode: "120000", type: "blob", sha: hash("alias"), size: 10 });
  directories.get("")!.set("submodule", { path: "submodule", mode: "160000", type: "commit", sha: hash("submodule") });
  const comments = Array.from({ length: options.comments ?? 0 }, (_, index) => ({
    id: index + 1, body: options.commentBody ?? `Attempt ${index + 1}: regression still reproduces.`,
    user: { login: `person-${index + 1}` }, created_at: "2026-09-12T08:00:00Z", updated_at: "2026-09-12T08:00:00Z",
    html_url: "https://untrusted.example/not-used",
  }));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const content = (path: string) => files[path] === undefined ? json({}, 404) : json({
    path, type: "file", sha: hash(path), size: Buffer.byteLength(files[path]), encoding: "base64",
    content: Buffer.from(files[path]).toString("base64"), download_url: "https://untrusted.example/never-fetch",
  });
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    requests.push({ url, init });
    expect(url.origin).toBe("https://api.github.com");
    if (url.pathname === "/repos/demo/project") {
      return options.repositoryResponse?.clone() ?? json({ full_name: "demo/project", private: options.private ?? false, default_branch: branch });
    }
    if (url.pathname === "/repos/demo/project/issues/12") return json({
      title: "Whitespace parsing regression", body: "The parser fails for a trailing newline.", state: "open", user: { login: "reporter" },
      labels: [{ name: "bug" }], assignees: [{ login: "dev" }], milestone: { title: "v2" }, comments: comments.length,
      created_at: "2026-09-11T10:00:00Z", updated_at: "2026-09-12T08:00:00Z",
    });
    if (url.pathname === `/repos/demo/project/branches/${encodeURIComponent(branch)}`) {
      return json({ commit: { sha: COMMIT, commit: { tree: { sha: hash("tree:") } } } });
    }
    if (url.pathname === "/repos/demo/project/issues/12/comments") {
      const page = Number(url.searchParams.get("page"));
      return json(comments.slice((page - 1) * 50, page * 50));
    }
    if (url.pathname === "/repos/demo/project/readme") return options.missingReadme ? json({}, 404) : content("README.md");
    if (url.pathname.startsWith("/repos/demo/project/git/trees/")) {
      const tree = url.pathname.split("/").at(-1);
      for (const [directory, children] of directories) {
        if (hash(`tree:${directory}`) === tree) {
          if (!directory && options.oversizedRoot) return new Response("", { headers: { "content-length": "2000000" } });
          return json({ sha: tree, tree: [...children.values()], truncated: !directory && options.truncated });
        }
      }
    }
    if (url.pathname.startsWith("/repos/demo/project/contents/")) {
      return content(url.pathname.slice("/repos/demo/project/contents/".length).split("/").map(decodeURIComponent).join("/"));
    }
    if (url.pathname === "/search/code") return json({ items: options.searchResults ?? [], incomplete_results: false });
    throw new Error(`Unexpected mock route: ${url.pathname}`);
  }) as typeof fetch;
  const make = (extra: { token?: string; allowedRepos?: string[] } = {}) => new GitHubRepository(ref, { ...extra, fetch: fetcher }, new AbortController().signal, () => undefined);
  return { make, requests, fetcher };
}

describe("GitHubRepository evidence retrieval", () => {
  it("refuses private repositories before fetching or exposing issue content", async () => {
    const { make, requests } = fixture({ private: true });
    const repository = make({ token: "server-only-token" });
    await expect(repository.bootstrap()).rejects.toMatchObject({ code: "PERMISSION_DENIED", status: 403 });
    expect(requests).toHaveLength(1);
    expect(repository.sources).toEqual([]);
    expect(repository.metadata).toBeNull();
  });

  it("enforces a configured repository allowlist before making network requests", () => {
    const { make, requests } = fixture();
    expect(() => make({ allowedRepos: ["team/other"] })).toThrow("not enabled");
    expect(requests).toEqual([]);
  });

  it("fixes branch and file reads to a commit and creates line-linked evidence only for read files", async () => {
    const { make, requests } = fixture();
    const repository = make();
    await repository.bootstrap();
    expect(repository.snapshot).toMatchObject({ branch: "release/next", commitSha: COMMIT });
    expect(repository.metadata).toMatchObject({ title: "Whitespace parsing regression", labels: ["bug"], milestone: "v2" });
    expect(repository.sources.filter(source => source.kind === "file")).toEqual([]);
    await repository.search("parser");
    expect(repository.sources.filter(source => source.kind === "file")).toEqual([]);
    const result = await repository.readFile("src/parser.ts", 2, 2) as { result: { sourceId: string; text: string } };
    const source = repository.sources.find(source => source.id === result.result.sourceId)!;
    expect(source).toMatchObject({ kind: "file", path: "src/parser.ts", lineStart: 2, lineEnd: 2 });
    expect(source.excerpt).toBe("2:   return value.trim();");
    expect(result.result.text).toBe(source.excerpt);
    expect(source.url).toBe(`https://github.com/demo/project/blob/${COMMIT}/src/parser.ts#L2-L2`);
    expect(requests.some(request => request.url.pathname.endsWith("/branches/release%2Fnext"))).toBe(true);
    for (const request of requests) {
      const headers = new Headers(request.init?.headers);
      expect(headers.get("X-GitHub-Api-Version")).toBe("2026-03-10");
      expect(request.init?.redirect).toBe("manual");
      if (/\/(?:readme|contents\/)/.test(request.url.pathname)) expect(request.url.searchParams.get("ref")).toBe(COMMIT);
    }
  });

  it("paginates discussion to 100 comments and explicitly reports missing later comments", async () => {
    const { make, requests } = fixture({ comments: 130 });
    const repository = make();
    await repository.bootstrap();
    expect(repository.coverage).toMatchObject({ commentsTotal: 130, commentsRead: 100, commentsTruncated: true });
    expect(requests.filter(request => request.url.pathname.endsWith("/comments")).map(request => request.url.searchParams.get("page"))).toEqual(["1", "2"]);
    const last = repository.sources.filter(source => source.kind === "comment").at(-1)!;
    expect(last.url).toBe("https://github.com/demo/project/issues/12#issuecomment-100");
    // A fast README response must not reorder source-budget allocation ahead of discussion pages.
    expect(repository.sources.slice(1, 101).every(source => source.kind === "comment")).toBe(true);
    expect(repository.sources.at(-1)?.kind).toBe("readme");
    expect(repository.coverage.limits.join(" ")).toContain("Later discussion may be missing");
  });

  it("does not label an exactly complete 100-comment discussion as truncated", async () => {
    const { make } = fixture({ comments: 100 });
    const repository = make();
    await repository.bootstrap();
    expect(repository.coverage).toMatchObject({ commentsRead: 100, commentsTruncated: false });
  });

  it("bounds long comments by a shared text budget rather than silently sending the whole thread", async () => {
    const { make, requests } = fixture({ comments: 100, commentBody: "x".repeat(6_000) });
    const repository = make();
    await repository.bootstrap();
    const comments = repository.sources.filter(source => source.kind === "comment");
    expect(comments).toHaveLength(6);
    expect(comments.reduce((sum, source) => sum + source.excerpt.length, 0)).toBe(24_000);
    expect(repository.coverage.commentsTruncated).toBe(true);
    expect(requests.filter(request => request.url.pathname.endsWith("/comments"))).toHaveLength(1);
    expect(JSON.stringify(repository.getSeed())).not.toContain("x".repeat(4_001));
  });

  it("continues without a README and records incomplete or oversized directory coverage", async () => {
    for (const options of [{ missingReadme: true, truncated: true }, { missingReadme: true, oversizedRoot: true }]) {
      const { make } = fixture(options);
      const repository = make();
      await repository.bootstrap();
      expect(repository.coverage.treeTruncated).toBe(true);
      expect(repository.coverage.filesRead).toBe(0);
      expect(repository.sources.filter(source => source.kind === "readme")).toEqual([]);
      expect(repository.coverage.limits.join(" ")).toContain("README unavailable");
      expect(repository.getSeed()).toBeDefined();
    }
  });

  it("distinguishes unexplored directories from a GitHub-truncated tree", async () => {
    const { make } = fixture();
    const repository = make();
    await repository.bootstrap();
    expect(repository.coverage.treeTruncated).toBe(false);
    expect(repository.coverage.limits.join(" ")).toContain("2 discovered directories remain unvisited");
    const root = await repository.overview() as { result: { partial: boolean; unvisitedDirectories: number } };
    expect(root.result).toMatchObject({ partial: true, unvisitedDirectories: 2 });
    await repository.overview("src");
    expect(repository.coverage.limits.join(" ")).toContain("1 discovered directory remains unvisited");
    await repository.overview("tests");
    expect(repository.coverage.limits.join(" ")).not.toContain("remain unvisited");
    expect(repository.coverage.treeTruncated).toBe(false);
  });

  it("does not follow secret paths, parent traversal, symlinks or submodules", async () => {
    const { make, requests } = fixture({ files: { ".env": "SECRET=not-for-model", ".npmrc": "token=secret", "credentials.json": "secret" } });
    const repository = make();
    await repository.bootstrap();
    const requestsBefore = requests.length;
    for (const path of [".env", ".npmrc", "credentials.json", "../README.md", "src/../../README.md", "src\\parser.ts", "alias", "submodule"]) {
      await expect(repository.readFile(path)).rejects.toBeDefined();
    }
    expect(requests).toHaveLength(requestsBefore);
    expect(JSON.stringify(repository.getSeed())).not.toContain("SECRET=");
    expect(repository.sources.map(source => source.path)).not.toContain("alias");
  });

  it("rejects large files before downloading and detects binary content after bounded retrieval", async () => {
    const { make, requests } = fixture({ files: { "large.ts": "x".repeat(100_001), "data.txt": new Uint8Array([65, 0, 66]) } });
    const repository = make();
    await repository.bootstrap();
    await expect(repository.readFile("large.ts")).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(requests.some(request => request.url.pathname.includes("/contents/large.ts"))).toBe(false);
    await expect(repository.readFile("data.txt")).rejects.toMatchObject({ code: "UNSUPPORTED_FILE" });
    expect(repository.coverage.filesRead).toBe(1);
  });

  it("limits file evidence to 160 lines and counts README in the six-file cap", async () => {
    const files: Record<string, string> = { "long.ts": Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join("\n") };
    for (let i = 0; i < 5; i++) files[`file${i}.ts`] = `export const value = ${i};`;
    const { make } = fixture({ files });
    const repository = make();
    await repository.bootstrap();
    await repository.readFile("long.ts", 1, 999);
    const source = repository.sources.find(source => source.path === "long.ts")!;
    expect(source.lineEnd).toBe(160);
    expect(source.excerpt).not.toContain("line 161");
    for (let i = 0; i < 4; i++) await repository.readFile(`file${i}.ts`);
    expect(repository.coverage.filesRead).toBe(6);
    await expect(repository.readFile("file4.ts")).rejects.toMatchObject({ code: "CONTEXT_BUDGET" });
    expect(repository.sources.filter(source => source.kind === "readme")).toHaveLength(1);
  });

  it("uses cached immutable content but rechecks repository visibility for every new analysis", async () => {
    const { make, requests } = fixture();
    const first = make();
    await first.bootstrap();
    await first.readFile("src/parser.ts");
    const second = make();
    await second.bootstrap();
    await second.readFile("src/parser.ts");
    expect(requests.filter(request => request.url.pathname === "/repos/demo/project")).toHaveLength(2);
    expect(requests.filter(request => request.url.pathname === "/repos/demo/project/contents/src/parser.ts")).toHaveLength(1);
    expect(requests.filter(request => request.url.pathname === "/repos/demo/project/readme")).toHaveLength(1);
    expect(first.snapshot!.id).toBe(second.snapshot!.id);
    expect(first.sources).not.toBe(second.sources);
  });

  it("contains outgoing code queries and incoming results to the current repository", async () => {
    const { make, requests } = fixture({ searchResults: [
      { path: "src/evil.ts", repository: { full_name: "evil/private" } },
      { path: "src/parser.ts", repository: { full_name: "demo/project" } },
      { path: ".env", repository: { full_name: "demo/project" } },
    ] });
    const repository = make({ token: "server-token" });
    await repository.bootstrap();
    const result = await repository.search('"parser" repo:evil/private') as { matches: { path: string }[] };
    const query = requests.find(request => request.url.pathname === "/search/code")!.url.searchParams.get("q")!;
    expect(query).toContain("repo:demo/project");
    expect(query.match(/repo:/g)).toHaveLength(1);
    expect(result.matches.map(match => match.path)).toContain("src/parser.ts");
    expect(result.matches.map(match => match.path)).not.toContain("src/evil.ts");
    expect(result.matches.map(match => match.path)).not.toContain(".env");
    expect(repository.sources.filter(source => source.kind === "file")).toEqual([]);
  });

  it("reports GitHub rate limits distinctly from missing access", async () => {
    const { make } = fixture({ repositoryResponse: new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }) });
    await expect(make().bootstrap()).rejects.toMatchObject({ code: "GITHUB_RATE_LIMIT", retryable: true });
  });
});
