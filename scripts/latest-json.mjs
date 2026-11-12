// Writes the updater manifest (latest.json) for a release.
// Usage: node scripts/latest-json.mjs <version> <dir-with-.sig-files> <out-file>
// The .sig files are named after the release assets they sign, e.g.
// "Usage-Float_0.3.1_universal.app.tar.gz.sig", "Usage.Float_0.3.1_x64-setup.exe.sig".
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [version, dir, out] = process.argv.slice(2);
if (!version || !dir || !out) throw new Error("usage: latest-json.mjs <version> <sig-dir> <out>");
const base = `https://github.com/xiaoxing1617/usage-float/releases/download/v${version}/`;

// Release notes: this version's section of CHANGELOG.md.
const log = readFileSync("CHANGELOG.md", "utf8");
const start = log.indexOf(`## [${version}]`);
let notes = "";
if (start >= 0) {
  const rest = log.slice(start).split("\n").slice(1).join("\n");
  notes = rest.split(/\n## \[/)[0].trim();
}

const platforms = {};
for (const f of readdirSync(dir)) {
  if (!f.endsWith(".sig")) continue;
  const asset = f.slice(0, -4);
  const entry = { signature: readFileSync(join(dir, f), "utf8").trim(), url: base + encodeURIComponent(asset) };
  if (asset.endsWith(".app.tar.gz")) {
    // One universal build serves both Mac architectures.
    platforms["darwin-aarch64"] = entry;
    platforms["darwin-x86_64"] = entry;
  } else if (asset.endsWith("-setup.exe")) {
    platforms["windows-x86_64"] = entry;
  }
}
if (!Object.keys(platforms).length) throw new Error("no signatures found in " + dir);
writeFileSync(out, JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms }, null, 2) + "\n");
console.log("platforms:", Object.keys(platforms).join(", "));
