import "dotenv/config";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const secrets = [process.env.OPENAI_API_KEY, process.env.GITHUB_TOKEN].filter((value) => value && value.length > 10);
const tokenPattern = /(?<![A-Za-z0-9_-])(?:sk-(?:proj-)?[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const violations = [];
if (tracked.some((path) => /(^|\/)\.env(?:\.|$)/.test(path) && !path.endsWith(".env.example"))) violations.push("An environment file is tracked by Git.");

async function scan(path) {
  const content = await readFile(path, "utf8");
  if (secrets.some((key) => content.includes(key)) || tokenPattern.test(content)) violations.push(`Possible secret in ${path}`);
}
for (const path of new Set(files)) await scan(path);
async function scanBuild(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await scanBuild(path);
    else await scan(path);
  }
}
await scanBuild("dist");
await scanBuild("dist-extension");
const history = execFileSync("git", ["log", "-p", "--all"], { encoding: "utf8", maxBuffer: 100_000_000 });
if (secrets.some((key) => history.includes(key)) || tokenPattern.test(history)) violations.push("Possible secret in Git history.");
if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else console.log("Secret check passed: source files, builds and Git history are clean; .env is untracked.");
