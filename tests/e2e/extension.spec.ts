import { chromium, expect, test, type Page } from "@playwright/test";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

const firstIssue = "https://github.com/test-owner/test-repo/issues/184";
const slowIssue = "https://github.com/test-owner/test-repo/issues/999";
const nextIssue = "https://github.com/test-owner/test-repo/issues/185";

test("packaged MV3 extension detects GitHub tabs and keeps CopilotKit results scoped to the current issue", async ({}, testInfo) => {
  test.setTimeout(45_000);
  const extensionPath = resolve("dist-extension");
  await access(resolve(extensionPath, "manifest.json")); // Run npm run build before this spec.
  const context = await chromium.launchPersistentContext(testInfo.outputPath("chromium-profile"), {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    viewport: { width: 1280, height: 900 },
  });
  const runtimeErrors: string[] = [];
  const cspErrors: string[] = [];
  const unexpectedRequests: string[] = [];
  const runs: { forwardedProps: { intent: string; issue: { url: string } }; context?: { description: string; value: string }[]; threadId: string }[] = [];
  context.on("weberror", error => runtimeErrors.push(error.error().message));
  context.on("console", message => {
    if (/content security policy|\bCSP\b|refused to (?:execute|load|connect)/i.test(message.text())) cspErrors.push(message.text());
  });
  context.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/copilotkit/agent/repolens/run") {
      runs.push(request.postDataJSON());
    }
  });
  await context.addInitScript(() => {
    const state = window as Window & { __extensionCspViolations?: string[] };
    state.__extensionCspViolations = [];
    document.addEventListener("securitypolicyviolation", event => {
      state.__extensionCspViolations!.push(`${event.violatedDirective}: ${event.blockedURI}`);
    });
  });
  // Only GitHub's page HTML is replaced. Extension APIs, the MV3 worker, local
  // HTTP transport, CopilotKit runtime and AG-UI events all run normally.
  await context.route(/^https?:\/\//, async route => {
    const url = new URL(route.request().url());
    if (url.hostname === "github.com") {
      await route.fulfill({ contentType: "text/html", body: "<!doctype html><html><head><title>GitHub issue fixture</title></head><body><h1>GitHub issue fixture</h1><p>This page intentionally supplies no issue context to RepoLens.</p></body></html>" });
    } else if (url.origin === "http://127.0.0.1:3001" || url.origin === "http://127.0.0.1:5173") {
      await route.continue();
    } else {
      unexpectedRequests.push(url.origin + url.pathname);
      await route.abort();
    }
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    expect(worker.url()).toMatch(/^chrome-extension:\/\/[a-p]{32}\/background\.js$/);
    const extensionId = new URL(worker.url()).hostname;
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe("RepoLens");
    expect(manifest.content_security_policy).toMatchObject({ extension_pages: expect.stringContaining("script-src 'self'") });
    await expect.poll(() => worker.evaluate(async () => (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick)).toBe(true);
    expect(await worker.evaluate(async () => (await chrome.sidePanel.getOptions({})).path)).toBe("index.html");

    const github = context.pages()[0] ?? await context.newPage();
    await github.goto(firstIssue);
    await github.bringToFront();
    const panelCreated = context.waitForEvent("page");
    // Playwright cannot operate the browser toolbar. Load the real panel bundle
    // in an inactive extension tab so GitHub remains the actual active tab.
    // This verifies the packaged panel and worker, not Chrome's toolbar gesture.
    await worker.evaluate(async url => { await chrome.tabs.create({ url, active: false }); }, `chrome-extension://${extensionId}/index.html`);
    const panel: Page = await panelCreated;
    await panel.waitForLoadState("domcontentloaded");
    await panel.setViewportSize({ width: 430, height: 900 });
    expect(panel.url()).toBe(`chrome-extension://${extensionId}/index.html`);
    await expect(panel.getByText("CONNECTED TO YOUR TAB", { exact: true })).toBeVisible();
    await expect(panel.locator(".detected-issue")).toContainText("test-owner/test-repo");
    await expect(panel.locator(".detected-issue")).toContainText("Issue #184");
    await expect(panel.getByRole("textbox", { name: "GitHub issue URL" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Understand", exact: true })).toBeEnabled();
    await expect(panel.getByRole("heading", { name: "The problem", exact: true })).toHaveCount(0);

    await panel.getByRole("button", { name: "Understand", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "The problem", exact: true })).toBeVisible();
    await expect(panel.locator(".issue-reference")).toContainText("#184");
    await expect(panel.getByText("The OAuth callback succeeds, but the session is rejected immediately after sign-in.")).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Proposed solution", exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "Read source: Comment #21", exact: true }).first().click();
    await expect(panel.getByRole("dialog").getByText(/I verified the callback URL/)).toBeVisible();
    await expect(panel.getByRole("link", { name: "View on GitHub" })).toHaveAttribute("href", `${firstIssue}#issuecomment-21`);
    await panel.getByRole("button", { name: "Close source" }).click();
    await panel.getByRole("button", { name: /Propose a solution/ }).click();
    await expect(panel.getByRole("heading", { name: "Proposed solution", exact: true })).toBeVisible();
    await panel.screenshot({ path: testInfo.outputPath("extension-solution.png"), fullPage: true });

    await github.goto(slowIssue);
    await expect(panel.locator(".detected-issue")).toContainText("Issue #999");
    await expect(panel.getByRole("heading", { name: "The problem", exact: true })).toHaveCount(0);
    await expect(panel.getByRole("heading", { name: "Proposed solution", exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "Understand", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Stop", exact: true })).toBeVisible();

    // GitHub also navigates without full reloads. Let Chromium's native tab URL
    // events detect a History API change while the previous analysis is running.
    await github.evaluate(url => history.pushState({}, "", url), nextIssue);
    await expect(panel.locator(".detected-issue")).toContainText("Issue #185");
    await expect(panel.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect(panel.getByRole("heading", { name: "The problem", exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "Understand", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "The problem", exact: true })).toBeVisible();
    await expect(panel.locator(".issue-reference")).toContainText("#185");
    // The fixture's previous run completes after 4 s unless cleanup cancels it.
    await panel.waitForTimeout(4_100);
    await expect(panel.locator(".issue-reference")).toContainText("#185");
    await expect(panel.getByRole("heading", { name: "Proposed solution", exact: true })).toHaveCount(0);
    await panel.screenshot({ path: testInfo.outputPath("extension-briefing.png"), fullPage: true });

    expect(runs.map(run => [run.forwardedProps.intent, run.forwardedProps.issue.url])).toEqual([
      ["understand", firstIssue], ["propose_solution", firstIssue], ["understand", slowIssue], ["understand", nextIssue],
    ]);
    for (const run of runs) {
      const currentIssue = run.context?.find(item => item.description === "Current GitHub issue");
      expect(currentIssue).toBeDefined();
      expect(JSON.parse(currentIssue!.value).url).toBe(run.forwardedProps.issue.url);
    }
    expect(runs[0].threadId).not.toBe(runs[3].threadId);
    expect(await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.url)).toBe(nextIssue);
    expect(await panel.evaluate(() => (window as Window & { __extensionCspViolations?: string[] }).__extensionCspViolations ?? [])).toEqual([]);
    expect(cspErrors).toEqual([]);
    expect(runtimeErrors).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
  } finally {
    await context.close();
  }
});
