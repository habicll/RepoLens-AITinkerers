import { describe, expect, it } from "vitest";
import { issueKey, parseIssueUrl } from "../shared/contracts.js";

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
