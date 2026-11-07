const fs = require("fs");
const g1 = JSON.parse(fs.readFileSync("tests/golden.json", "utf8"));
const g2 = JSON.parse(fs.readFileSync("tests/golden_block2.json", "utf8"));
const codeFiles = [
  "worker/telegramAssistant.ts",
  "worker/aiAdapter.ts",
  "worker/dateLexicon.ts",
  "worker/capabilityManifest.ts"
];

let matched = [];
for (const file of codeFiles) {
  const content = fs.readFileSync(file, "utf8").toLowerCase();
  for (const item of [...g1, ...g2]) {
    const inp = (item.input || "").trim().toLowerCase();
    // Exclude meta keywords like 'privacy' which is a test group label
    if (inp.length > 8 && content.includes(inp)) {
      matched.push({ file, id: item.id, input: inp });
    }
  }
}
console.log("Matched overfit inputs count:", matched.length);
if (matched.length > 0) {
  console.log(matched);
} else {
  console.log("OVERFIT CHECK PASSED: 0 golden/eval inputs appear in prompts, few-shots, or lexicon.");
}
