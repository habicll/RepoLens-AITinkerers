import { describe, expect, it, vi } from "vitest";
import { GitHubProject } from "../server/project.js";

const ref = { owner: "demo", repo: "readable", url: "https://github.com/demo/readable" } as const;
const commitSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const encoded = (value: string) => Buffer.from(value).toString("base64");

function githubFetch() {
  return vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/demo/readable") return json({ private: false, full_name: "demo/readable", name: "readable", description: "A small documented application", default_branch: "main", language: "TypeScript", stargazers_count: 42, topics: ["docs"], license: { spdx_id: "MIT" } });
    if (url.pathname === "/repos/demo/readable/branches/main") return json({ commit: { sha: commitSha, commit: { tree: { sha: treeSha } } } });
    if (url.pathname === `/repos/demo/readable/git/trees/${treeSha}`) return json({ truncated: false, tree: [{ path: "README.md", type: "blob" }, { path: "package.json", type: "blob" }, { path: "package-lock.json", type: "blob" }, { path: "src", type: "tree" }] });
    if (url.pathname === "/repos/demo/readable/readme") return json({ path: "README.md", encoding: "base64", content: encoded("# Readable\n\nRun the project with npm run dev.") });
    if (url.pathname === "/repos/demo/readable/contents/package.json") return json({ path: "package.json", encoding: "base64", content: encoded(JSON.stringify({ scripts: { dev: "vite" } }, null, 2)) });
    return json({ message: "not found" }, 404);
  });
}

describe("repository briefing collection", () => {
  it("pins README and manifest evidence to a commit and derives an npm recipe deterministically", async () => {
    const transport = githubFetch();
    const project = new GitHubProject(ref, { fetch: transport, localExecutionEnabled: true }, new AbortController().signal, () => {});
    await project.bootstrap();
    expect(project.snapshot).toMatchObject({ commitSha, branch: "main" });
    expect(project.sources.map(source => source.kind)).toEqual(["repository", "readme", "file"]);
    expect(project.sources.find(source => source.kind === "readme")?.excerpt).toContain("3: Run the project with npm run dev.");
    expect(project.proposal).toMatchObject({ status: "available", runtime: "Node.js + npm" });
    expect(project.recipe?.install.args).toEqual(["ci"]);
    expect(project.recipe?.start.args).toEqual(["run", "dev"]);
    expect(project.proposal.commands.at(-1)).toBe("npm run dev");
    expect(project.proposal.commands).toContain("cd readable");
    expect(project.proposal.commands.join("\n")).not.toContain("<temporary-workspace>");
    expect(JSON.parse(project.evidence())).toMatchObject({ repository: ref, snapshot: { commitSha } });
  });

  it("shows a deterministic disabled proposal without removing the verified commands", async () => {
    const project = new GitHubProject(ref, { fetch: githubFetch(), localExecutionEnabled: false }, new AbortController().signal, () => {});
    await project.bootstrap();
    expect(project.proposal.status).toBe("disabled");
    expect(project.proposal.commands).toContain("npm run dev");
    expect(project.proposal.commands[0]).toContain("git clone");
  });
});
