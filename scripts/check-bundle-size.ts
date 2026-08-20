// Catch accidental large dependencies while keeping LAN delivery lightweight.

const BUDGET = 85_000;

if (!import.meta.main) process.exit(0);

const files = await Array.fromAsync(new Bun.Glob("dist/ui/assets/*.js").scan());
if (files.length === 0) {
  console.error("Bundle size gate: no JavaScript assets found in dist/ui/assets");
  process.exit(1);
}

const sizes = await Promise.all(files.sort().map(async (file) => {
  const compressed = Bun.gzipSync(await Bun.file(file).arrayBuffer(), { level: 9 });
  return { file, bytes: compressed.byteLength };
}));
const total = sizes.reduce((sum, item) => sum + item.bytes, 0);

console.log("Gzipped JavaScript assets:");
for (const { file, bytes } of sizes) console.log(`${String(bytes).padStart(8)} B  ${file}`);
console.log(`${String(total).padStart(8)} B  TOTAL (budget ${BUDGET} B)`);

if (total > BUDGET) {
  console.error(`Bundle size gate FAILED: ${total} B gz exceeds the ${BUDGET} B budget by ${total - BUDGET} B.`);
  process.exit(1);
}
console.log(`Bundle size gate passed: ${total} B gz is under the ${BUDGET} B budget.`);
