import fs from "node:fs";
import path from "node:path";

const file = path.resolve("build/server/index.js");
if (!fs.existsSync(file)) process.exit(0);

let src = fs.readFileSync(file, "utf8");

const re = /import\s*\{\s*([\s\S]*?)\s*\}\s*from\s*["']react-router["'];/m;
const m = src.match(re);
if (!m) process.exit(0);

const raw = m[1];
const parts = raw
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const filtered = parts.filter(
  (p) =>
    p !== "json" &&
    !p.startsWith("json as ") &&
    p !== "defer" &&
    !p.startsWith("defer as ")
);

const replacement = `import { ${filtered.join(", ")} } from "react-router";`;
src = src.replace(re, replacement);

fs.writeFileSync(file, src, "utf8");
console.log("[postbuild] patched build/server/index.js (removed json/defer import)");
