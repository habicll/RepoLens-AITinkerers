import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import dotenv from "dotenv";

dotenv.config({ quiet: true });
const backend = new URL(process.env.VITE_API_URL || "http://127.0.0.1:3001");
if (!["http:", "https:"].includes(backend.protocol) || backend.username || backend.password) {
  throw new Error("VITE_API_URL must be an HTTP(S) origin without credentials.");
}
await rm("dist-extension", { recursive: true, force: true });
await mkdir("dist-extension", { recursive: true });
await cp("dist", "dist-extension", { recursive: true });
await cp("extension/background.js", "dist-extension/background.js");
await cp("extension/content.js", "dist-extension/content.js");
const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
manifest.host_permissions = ["https://github.com/*", `${backend.protocol}//${backend.hostname}/*`];
manifest.content_security_policy.extension_pages = `script-src 'self'; object-src 'none'; connect-src 'self' ${backend.origin}`;
await writeFile("dist-extension/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log("Chrome extension built in dist-extension/");
