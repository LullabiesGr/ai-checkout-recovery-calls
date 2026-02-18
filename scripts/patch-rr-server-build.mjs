import fs from "node:fs";
import path from "node:path";

const file = path.resolve("build/server/index.js");
if (!fs.existsSync(file)) process.exit(0);

let src = fs.readFileSync(file, "utf8");

// Finds: import { ... } from "react-router";
const re = /import\s*\{\s*([\s\S]*?)\s*\}\s*from\s*["']react-router["'];/m;
const m = src.match(re);
if (!m) {
  console.log("[postbuild] no react-router named import found — skip patch");
  process.exit(0);
}

const raw = m[1];
const parts = raw
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const banned = new Set(["json", "defer"]);

const filtered = parts.filter((p) => {
  // Handles: json, json as something, defer, defer as something
  const base = p.split(/\s+as\s+/i)[0]?.trim();
  return base && !banned.has(base);
});

const replacement = `import { ${filtered.join(", ")} } from "react-router";`;
if (replacement === m[0]) {
  console.log("[postbuild] import already clean — skip patch");
  process.exit(0);
}

src = src.replace(re, replacement);
fs.writeFileSync(file, src, "utf8");
console.log("[postbuild] patched build/server/index.js (removed json/defer import)");
