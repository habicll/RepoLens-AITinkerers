import { describe, expect, it } from "vitest";
import { issueKey, parseIssueUrl, parseRepositoryUrl, repositoryKey } from "../shared/contracts.js";

describe("GitHub issue identity", () => {
  it("normalizes parameters and anchors while preserving the issue", () => {
    const ref = parseIssueUrl("https://github.com/ExpressJS/express/issues/7350?foo=bar#issuecomment-2")!;
    expect(ref.url).toBe("https://github.com/ExpressJS/express/issues/7350");
    expect(issueKey(ref)).toBe("expressjs/express#7350");
  });
  it.each([
    "https://github.com.evil.test/owner/repo/issues/1",
    "https://github.com@evil.test/owner/repo/issues/1",
    "https://user:pass@github.com/owner/repo/issues/1",
    "https://github.com:8443/owner/repo/issues/1",
    "http://github.com/owner/repo/issues/1",
    "https://github.com/owner/repo/pull/1",
    "https://github.com/owner/repo/issues/new",
    "https://github.com/owner/repo/issues/1/comments",
    "https://github.com/owner/repo/issues/99999999999999999",
  ])("rejects unsupported or misleading URL %s", (url) => expect(parseIssueUrl(url)).toBeNull());
});

describe("GitHub repository identity", () => {
  it("accepts only the repository root and normalizes its URL", () => {
    const ref = parseRepositoryUrl("https://github.com/OpenAI/openai-node/?tab=readme-ov-file#readme")!;
    expect(ref.url).toBe("https://github.com/OpenAI/openai-node");
    expect(repositoryKey(ref)).toBe("openai/openai-node");
  });
  it.each([
    "http://github.com/owner/repo", "https://github.com.evil.test/owner/repo", "https://github.com/owner/repo.git",
    "https://github.com/owner/repo/tree/main", "https://github.com/owner/repo/issues", "https://github.com/owner",
    "https://github.com/settings/profile", "https://github.com/marketplace/actions",
  ])("rejects unsupported repository URL %s", url => expect(parseRepositoryUrl(url)).toBeNull());
});
