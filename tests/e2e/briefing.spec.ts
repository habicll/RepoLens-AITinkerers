import { expect, test, type Page } from "@playwright/test";

const issue = "https://github.com/test-owner/test-repo/issues/184";
async function understand(page: Page, url = issue) {
  await page.goto("/");
  await page.getByRole("textbox", { name: "GitHub repository or issue URL" }).fill(url);
  await page.getByRole("button", { name: "Understand", exact: true }).click();
}

test("real CopilotKit transport renders evidence and gates the solution", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Understand before/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Propose a solution/ })).toHaveCount(0);
  await understand(page);
  await expect(page.getByRole("heading", { name: "The problem", exact: true })).toBeVisible();
  await expect(page.getByText("The OAuth callback succeeds, but the session is rejected immediately after sign-in.")).toBeVisible();
  await expect(page.getByText("Working hypothesis", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Proposed solution", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Implement solution/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Read source: Comment #21", exact: true }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByText(/I verified the callback URL/)).toBeVisible();
  await expect(page.getByRole("link", { name: "View on GitHub" })).toHaveAttribute("href", `${issue}#issuecomment-21`);
  await page.getByRole("button", { name: "Close source" }).click();
  await page.getByRole("button", { name: /Propose a solution/ }).click();
  await expect(page.getByRole("heading", { name: "Proposed solution", exact: true })).toBeVisible();
  await expect(page.getByText("Normalize the OAuth identity before session validation.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Implement solution/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review the proposed patch" })).toHaveCount(0);
  await page.getByRole("button", { name: /Implement solution/ }).click();
  await expect(page.getByRole("heading", { name: "Review the proposed patch" })).toBeVisible();
  await expect(page.getByText("session.userId = identity.id", { exact: false })).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/briefing-desktop.png", fullPage: true });
});

test("permission denied is an explicit state", async ({ page }) => {
  await understand(page, "https://github.com/test-owner/test-repo/issues/403");
  await expect(page.getByRole("heading", { name: "This issue is not accessible" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Propose a solution/ })).toHaveCount(0);
});

test("a new issue cannot receive the previous run result", async ({ page }) => {
  await understand(page, "https://github.com/test-owner/test-repo/issues/999");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("textbox", { name: "GitHub repository or issue URL" }).fill("https://github.com/test-owner/test-repo/issues/185");
  await page.getByRole("button", { name: "Understand", exact: true }).click();
  await expect(page.getByRole("heading", { name: "The problem", exact: true })).toBeVisible();
  await expect(page.locator(".issue-reference")).toContainText("#185");
  await page.waitForTimeout(4100);
  await expect(page.locator(".issue-reference")).toContainText("#185");
});

test("repository root becomes a sourced README briefing before local execution", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "GitHub repository or issue URL" }).fill("https://github.com/test-owner/test-repo");
  await page.getByRole("button", { name: "Understand", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What this project is" })).toBeVisible();
  await expect(page.getByText("RepoLens turns GitHub context into a concise, source-backed engineering briefing.")).toBeVisible();
  await expect(page.getByText("Quick start from the README")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Launch this project on this computer" })).toBeVisible();
  await expect(page.getByText(/Local execution is disabled/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Launch project/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Read source: README.md" }).first().click();
  await expect(page.getByRole("dialog").getByText(/Run npm ci/)).toBeVisible();
  await page.getByRole("button", { name: "Close source" }).click();
  await page.screenshot({ path: "test-results/repository-briefing.png", fullPage: true });
});

test("narrow layout is usable without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await understand(page);
  await expect(page.getByRole("heading", { name: "The problem", exact: true })).toBeVisible();
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  await page.screenshot({ path: "test-results/briefing-panel.png", fullPage: true });
});

test("missing credentials and offline service are visible", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { status: "ok", openaiConfigured: false, githubConfigured: false, model: "test" } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Analysis is not configured yet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Understand", exact: true })).toBeDisabled();
  await page.unroute("**/api/health");
  await page.route("**/api/health", (route) => route.abort());
  await page.reload();
  await expect(page.getByRole("heading", { name: "The analysis service is offline" })).toBeVisible();
});
