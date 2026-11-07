import * as fs from "fs";
import * as path from "path";

const visited = new Set<string>();
const aiForbidden = ["aiadapter", "aiprompt", "aiexecution", "aicontext", "groq", "gemini", "workers_ai", "openai"];

function checkImports(filePath: string) {
  if (visited.has(filePath)) return;
  visited.add(filePath);

  const content = fs.readFileSync(filePath, "utf8");
  const importLines = content.match(/from\s+['"](\.[^'"]+)['"]/g) || [];

  for (const line of importLines) {
    const m = line.match(/from\s+['"](\.[^'"]+)['"]/);
    if (!m) continue;
    let resolved = path.resolve(path.dirname(filePath), m[1]);
    if (!resolved.endsWith(".ts")) resolved += ".ts";

    const base = path.basename(resolved).toLowerCase();
    for (const bad of aiForbidden) {
      if (base.includes(bad)) {
        console.error("VIOLATION: scheduler imports AI module transitively:", resolved);
        process.exit(1);
      }
    }
    if (fs.existsSync(resolved)) {
      checkImports(resolved);
    }
  }
}

checkImports(path.resolve("worker/scheduler.ts"));
console.log(`Transitive imports checked: ${visited.size} files.`);
for (const f of visited) {
  console.log("  •", path.relative(process.cwd(), f));
}
console.log("\nINVARIANT VERIFIED: ZERO AI MODULES IN TRANSITIVE IMPORT GRAPH!");
