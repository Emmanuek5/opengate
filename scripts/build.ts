// Build standalone binaries (no Bun or Node needed to run them).
// usage: bun scripts/build.ts [target ...]   e.g. bun scripts/build.ts linux-x64 windows-x64
import { mkdirSync } from "node:fs";

const ALL = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"];
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
mkdirSync("dist", { recursive: true });

for (const t of wanted) {
  if (!ALL.includes(t)) throw new Error(`unknown target ${t}; one of ${ALL.join(", ")}`);
  const out = `dist/opengate-${t}${t.startsWith("windows") ? ".exe" : ""}`;
  const r = await Bun.build({
    entrypoints: ["src/cli.ts"],
    compile: { target: `bun-${t}` as any, outfile: out },
    minify: true,
  });
  if (!r.success) {
    for (const l of r.logs) console.error(l);
    process.exit(1);
  }
  console.log(`built ${out}`);
}
