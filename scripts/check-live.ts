import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { RunAgentInput } from "@ag-ui/core";
import { RepoLensAgent } from "../server/agent.js";
import { parseIssueUrl, type RepoLensState } from "../shared/contracts.js";

const issue = parseIssueUrl(process.argv[2] || "https://github.com/expressjs/express/issues/7350");
if (!issue) throw new Error("Pass a valid public GitHub issue URL.");
if (!process.env.OPENAI_API_KEY?.trim()) throw new Error("Configure OPENAI_API_KEY in .env first.");
const agent = new RepoLensAgent({ openaiApiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || "gpt-5.4", githubToken: process.env.GITHUB_TOKEN });
const threadId = randomUUID();

async function run(intent: "understand" | "propose_solution", analysisId?: string): Promise<RepoLensState> {
  const input: RunAgentInput = { threadId, runId: randomUUID(), state: {}, messages: [], tools: [],
    context: [{ description: "Current GitHub issue", value: JSON.stringify(issue) }],
    forwardedProps: { intent, issue, ...(analysisId ? { analysisId } : {}) },
  };
  return new Promise((resolve, reject) => {
    let result: RepoLensState | undefined;
    let phase = "";
    agent.run(input).subscribe({
      next(event) {
        if (event.type === "STATE_SNAPSHOT") {
          result = (event as unknown as { snapshot: RepoLensState }).snapshot;
          if (result.phase !== phase) { phase = result.phase; console.log(phase); }
        }
      },
      error: reject,
      complete() {
        if (!result || result.status !== "complete") reject(new Error(result?.error?.message || "No completed analysis."));
        else resolve(result);
      },
    });
  });
}

const analysis = await run("understand");
await mkdir("local-results", { recursive: true });
await writeFile("local-results/live-analysis.json", JSON.stringify(analysis, null, 2));
console.log(JSON.stringify({ issue: issue.url, summary: analysis.analysis?.summary, facts: analysis.analysis?.facts, files: analysis.analysis?.relevantFiles, coverage: analysis.coverage }, null, 2));
if (process.argv.includes("--solution")) {
  const solution = await run("propose_solution", analysis.analysisId!);
  await writeFile("local-results/live-solution.json", JSON.stringify(solution, null, 2));
  console.log(JSON.stringify({ approach: solution.solution?.approach, steps: solution.solution?.steps.length }, null, 2));
}
