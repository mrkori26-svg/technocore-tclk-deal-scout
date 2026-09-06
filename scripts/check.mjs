import { readFileSync } from "node:fs";

const required = [
  "index.html",
  "src/app.mjs",
  "src/client.mjs",
  "src/core.mjs",
  "src/styles.css",
  "dist/app.js",
  "SKILL.md",
  "SECURITY.md",
  "docs/COMPATIBILITY.md",
  "schema/deal-scout-report.v1.schema.json",
  "vendor/tclk/UPSTREAM.md",
];

for (const file of required) readFileSync(file, "utf8");

const html = readFileSync("index.html", "utf8");
if (!html.includes('src="dist/app.js"')) throw new Error("index.html must load dist/app.js");
const browserSource = `${readFileSync("src/app.mjs", "utf8")}\n${readFileSync("src/client.mjs", "utf8")}`;
if (/fetch\([^)]*,\s*\{[^}]*method:\s*["']POST/i.test(browserSource)) {
  throw new Error("Browser application must not contain POST requests");
}

const schema = JSON.parse(readFileSync("schema/deal-scout-report.v1.schema.json", "utf8"));
if (schema.properties?.schema?.const !== "technocore.tclk.deal-scout.v1") {
  throw new Error("Report schema id drifted");
}

console.log("Static checks passed: read-only entrypoint, security docs, report schema, skill, and vendored provenance present.");
