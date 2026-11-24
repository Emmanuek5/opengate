// Render the README artwork from art/*.html to .github/assets/*.png at 2x with headless Chromium.
// usage: CHROME=/path/to/chrome bun art/render.ts [name ...]
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SIZES: Record<string, [number, number]> = {
  hero: [1280, 600],
  "two-ways": [1280, 640],
  "how-it-works": [1280, 430],
  "social-preview": [1280, 640],
};

function findChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  for (const c of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    const p = Bun.which(c);
    if (p) return p;
  }
  const pw = join(homedir(), ".cache", "ms-playwright");
  if (existsSync(pw))
    for (const d of readdirSync(pw).filter((d) => d.startsWith("chromium")).sort().reverse()) {
      for (const sub of ["chrome-linux/headless_shell", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        const p = join(pw, d, sub);
        if (existsSync(p)) return p;
      }
    }
  throw new Error("no Chromium found; set CHROME=/path/to/chrome");
}

const chrome = findChrome();
const outDir = resolve(import.meta.dir, "..", ".github", "assets");
mkdirSync(outDir, { recursive: true });
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SIZES);

for (const name of names) {
  const size = SIZES[name];
  if (!size) throw new Error(`unknown art ${name}`);
  const src = resolve(import.meta.dir, `${name}.html`);
  const out = join(outDir, `${name}.png`);
  const p = Bun.spawnSync([
    chrome,
    "--headless",
    "--no-sandbox",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    `--window-size=${size[0]},${size[1]}`,
    "--virtual-time-budget=10000",
    "--run-all-compositor-stages-before-draw",
    "--allow-file-access-from-files",
    `--screenshot=${out}`,
    `file://${src}`,
  ]);
  if (p.exitCode !== 0) throw new Error(`${name}: ${p.stderr.toString().slice(-400)}`);
  console.log(`rendered ${out}`);
}
