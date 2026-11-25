import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { dataDir, loadConfig, VERSION } from "./config";

/**
 * Self-update from GitHub releases. Forks: set OPENGATE_REPO=you/opengate.
 * The running binary is replaced in place: on Linux and macOS by an atomic rename over it; on
 * Windows (where a running .exe can't be overwritten, but can be renamed) by moving the old one
 * aside as `opengate.exe.old`, which the next start deletes.
 */
export const REPO = () => process.env.OPENGATE_REPO || "Emmanuek5/opengate";

export interface Release {
  version: string;
  tag: string;
  url: string;
  assets: { name: string; url: string }[];
}

/** -1, 0 or 1: is a older, equal or newer than b ("0.2.1" style; a leading v is ignored). */
export function compareVersions(a: string, b: string): number {
  const p = (v: string) => v.replace(/^v/, "").split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const x = p(a);
  const y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const m = x[i] ?? 0;
    const n = y[i] ?? 0;
    if (m === n) continue;
    if (typeof m === "number" && typeof n === "number") return m < n ? -1 : 1;
    return String(m) < String(n) ? -1 : 1;
  }
  return 0;
}

/** The release asset for this machine, e.g. opengate-windows-x64.exe. */
export function assetName(platform = process.platform, arch = process.arch): string {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : "linux";
  const a = arch === "arm64" ? "arm64" : "x64";
  return `opengate-${os}-${a}${os === "windows" ? ".exe" : ""}`;
}

export async function latestRelease(fetchImpl: typeof fetch = fetch): Promise<Release> {
  let r: Response | null = null;
  // GitHub's API has the odd 5xx; try a few times before giving up.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      r = await fetchImpl(`https://api.github.com/repos/${REPO()}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": `opengate/${VERSION}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (r.status < 500) break;
    } catch (e) {
      if (attempt === 2) throw e;
    }
    await Bun.sleep(1000 * (attempt + 1));
  }
  if (!r) throw new Error(`couldn't reach GitHub for the latest release of ${REPO()}`);
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for the latest release of ${REPO()}`);
  const j: any = await r.json();
  return {
    tag: String(j.tag_name ?? ""),
    version: String(j.tag_name ?? "").replace(/^v/, ""),
    url: String(j.html_url ?? ""),
    assets: (Array.isArray(j.assets) ? j.assets : []).map((a: any) => ({ name: String(a.name), url: String(a.browser_download_url) })),
  };
}

/** True when running a compiled opengate binary (not `bun src/cli.ts`). */
export function isCompiledBinary(execPath = process.execPath): boolean {
  const name = basename(execPath).toLowerCase();
  return !/^(bun|bun\.exe|node|node\.exe)$/.test(name);
}

/** Delete the previous binary a Windows update left behind. Call at startup. */
export function cleanupOldBinary(execPath = process.execPath): void {
  const old = `${execPath}.old`;
  if (existsSync(old)) {
    try {
      rmSync(old, { force: true });
    } catch {}
  }
}

export interface UpdateResult {
  status: "updated" | "current" | "newer-than-release";
  from: string;
  to: string;
  path?: string;
}

/** Download the latest release for this machine, check its checksum, and swap it in. */
export async function selfUpdate(o: { fetchImpl?: typeof fetch; execPath?: string; log?: (s: string) => void; force?: boolean } = {}): Promise<UpdateResult> {
  const f = o.fetchImpl ?? fetch;
  const execPath = o.execPath ?? process.execPath;
  const log = o.log ?? (() => {});
  if (!isCompiledBinary(execPath)) throw new Error("this is running from source (bun src/cli.ts); update it with git pull instead");
  const rel = await latestRelease(f);
  const cmp = compareVersions(VERSION, rel.version);
  if (cmp === 0 && !o.force) return { status: "current", from: VERSION, to: rel.version };
  if (cmp > 0 && !o.force) return { status: "newer-than-release", from: VERSION, to: rel.version };

  const name = assetName();
  const asset = rel.assets.find((a) => a.name === name);
  if (!asset) throw new Error(`release ${rel.tag} has no build for this machine (${name})`);
  log(`Downloading ${name} ${rel.tag}…`);
  const res = await f(asset.url, { headers: { "User-Agent": `opengate/${VERSION}` }, signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1_000_000) throw new Error(`the download is too small (${bytes.length} bytes); not installing it`);

  const sums = rel.assets.find((a) => a.name === "SHA256SUMS");
  if (sums) {
    const text = await (await f(sums.url, { headers: { "User-Agent": `opengate/${VERSION}` } })).text();
    const want = text.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).find((p) => p[1]?.replace(/^\*/, "") === name)?.[0]?.toLowerCase();
    const got = createHash("sha256").update(bytes).digest("hex");
    if (want && want !== got) throw new Error("checksum mismatch; not installing the download");
    if (want) log("Checksum OK.");
  }

  const dir = dirname(execPath);
  const tmp = join(dir, `.${basename(execPath)}.${process.pid}.new`);
  try {
    writeFileSync(tmp, bytes);
  } catch (e) {
    throw new Error(`can't write to ${dir} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}). Re-run with permission to change that folder, or reinstall with the install script.`);
  }
  try {
    if (process.platform === "win32") {
      const old = `${execPath}.old`;
      rmSync(old, { force: true });
      renameSync(execPath, old); // a running .exe can be renamed, not overwritten
      try {
        renameSync(tmp, execPath);
      } catch (e) {
        renameSync(old, execPath); // put the old one back
        throw e;
      }
    } else {
      chmodSync(tmp, 0o755);
      renameSync(tmp, execPath);
    }
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Error(`couldn't replace ${execPath}: ${(e as Error).message}`);
  }
  return { status: "updated", from: VERSION, to: rel.version, path: execPath };
}

// ---------------- the once-a-day "update available" hint ----------------

const checkFile = () => join(dataDir(), "update-check.json");

/**
 * The newer version available, if the last check (at most daily, in the background) found one.
 * Returns what was known before this call and refreshes for next time; never blocks or throws.
 */
export function updateHint(fetchImpl: typeof fetch = fetch): string | null {
  if (loadConfig().updateCheck === false || !isCompiledBinary()) return null;
  let state: { at: number; latest: string } = { at: 0, latest: "" };
  try {
    state = JSON.parse(readFileSync(checkFile(), "utf8"));
  } catch {}
  if (Date.now() - state.at > 24 * 3600_000) {
    void latestRelease(fetchImpl)
      .then((r) => {
        mkdirSync(dataDir(), { recursive: true });
        writeFileSync(checkFile(), JSON.stringify({ at: Date.now(), latest: r.version }));
      })
      .catch(() => {});
  }
  return state.latest && compareVersions(state.latest, VERSION) > 0 ? state.latest : null;
}

/**
 * The newer version, if there is one: from the daily cache, or by asking GitHub when the cache is
 * older than a day. Never throws; null when up to date, offline, disabled or running from source.
 */
export async function checkForUpdate(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (loadConfig().updateCheck === false || !isCompiledBinary()) return null;
  let state: { at: number; latest: string } = { at: 0, latest: "" };
  try {
    state = JSON.parse(readFileSync(checkFile(), "utf8"));
  } catch {}
  if (Date.now() - state.at > 24 * 3600_000) {
    try {
      const r = await latestRelease(fetchImpl);
      state = { at: Date.now(), latest: r.version };
      mkdirSync(dataDir(), { recursive: true });
      writeFileSync(checkFile(), JSON.stringify(state));
    } catch {
      return null;
    }
  }
  return state.latest && compareVersions(state.latest, VERSION) > 0 ? state.latest : null;
}
