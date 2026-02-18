import fs from "node:fs";
import path from "node:path";

const file = path.resolve("build/server/index.js");
if (!fs.existsSync(file)) process.exit(0);

let src = fs.readFileSync(file, "utf8");

/**
 * Βρες το import από react-router
 */
const re = /import\s*\{\s*([\s\S]*?)\s*\}\s*from\s*["']react-router["'];/m;
const m = src.match(re);
if (!m) process.exit(0);

const raw = m[1];

const parts = raw
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Κρατάμε ΤΑ ΠΑΝΤΑ εκτός από defer
 * ⚠️ ΔΕΝ πειράζουμε το json
 */
const filtered = parts.filter(
  (p) =>
    p !== "defer" &&
    !p.startsWith("defer as ")
);

/**
 * Αν δεν υπάρχει defer δεν κάνουμε rewrite
 */
if (filtered.length === parts.length) {
  console.log("[postbuild] no defer import found — skip patch");
  process.exit(0);
}

const replacement = `import { ${filtered.join(", ")} } from "react-router";`;

src = src.replace(re, replacement);

fs.writeFileSync(file, src, "utf8");

console.log("[postbuild] patched build/server/index.js (removed defer only)");
