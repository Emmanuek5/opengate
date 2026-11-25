import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import type { Part } from "./types";

/** Images a message can carry, by file extension. */
export const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGES = 8;

export type ImagePart = Extract<Part, { type: "image" }>;

/** Read an image file as a message part, or explain why not. */
export function imageFromFile(path: string): ImagePart | string {
  const type = IMAGE_TYPES[extname(path).toLowerCase()];
  if (!type) return `${path} isn't a PNG, JPEG, GIF or WebP image`;
  if (!existsSync(path)) return `no such file: ${path}`;
  const size = statSync(path).size;
  if (size > MAX_IMAGE_BYTES) return `${path} is too big (${Math.round(size / 1024 / 1024)} MB; the limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`;
  return { type: "image", mediaType: type, data: readFileSync(path).toString("base64") };
}

/**
 * Image file paths written in a message: plain or quoted (dragging a file into a terminal pastes
 * its path, often in quotes), or as @mentions. Only files that exist count.
 */
export function imagePathsIn(text: string, cwd: string): string[] {
  const found: string[] = [];
  const re = /"([^"\r\n]+\.(?:png|jpe?g|gif|webp))"|'([^'\r\n]+\.(?:png|jpe?g|gif|webp))'|@?((?:[A-Za-z]:)?[^\s"'`]+\.(?:png|jpe?g|gif|webp))/gi;
  for (const m of text.matchAll(re)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\ /g, " ");
    if (!raw) continue;
    const p = isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) ? raw : resolve(cwd, raw.replace(/^~(?=[\\/])/, process.env.HOME ?? process.env.USERPROFILE ?? "~"));
    if (existsSync(p) && !found.includes(p)) found.push(p);
    if (found.length >= MAX_IMAGES) break;
  }
  return found;
}

/**
 * The image on the clipboard as PNG bytes, if there is one. Windows: PowerShell (also an image
 * file copied in Explorer); macOS: osascript; Linux: wl-paste or xclip.
 */
export function clipboardImage(): { data: Buffer; mediaType: string } | { error: string } {
  const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 10_000, windowsHide: true });
  if (process.platform === "win32") {
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms, System.Drawing;",
      "$img = [System.Windows.Forms.Clipboard]::GetImage();",
      "if (-not $img) { $f = [System.Windows.Forms.Clipboard]::GetFileDropList() | Where-Object { $_ -match '\\.(png|jpe?g|gif|webp)$' } | Select-Object -First 1; if ($f) { $img = [System.Drawing.Image]::FromFile($f) } }",
      "if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [Console]::Out.Write([Convert]::ToBase64String($ms.ToArray())) }",
    ].join(" ");
    for (const exe of ["powershell.exe", "pwsh"]) {
      const r = run(exe, ["-NoProfile", "-NonInteractive", "-STA", "-Command", ps]);
      if (r.error) continue;
      const b64 = r.stdout.toString("utf8").trim();
      if (b64) return { data: Buffer.from(b64, "base64"), mediaType: "image/png" };
      return { error: "there's no image on the clipboard" };
    }
    return { error: "couldn't run PowerShell to read the clipboard" };
  }
  if (process.platform === "darwin") {
    const dir = mkdtempSync(join(tmpdir(), "og-clip-"));
    const out = join(dir, "clip.png");
    try {
      const r = run("osascript", ["-e", `set f to open for access POSIX file "${out}" with write permission`, "-e", "write (the clipboard as «class PNGf») to f", "-e", "close access f"]);
      if (r.status === 0 && existsSync(out) && statSync(out).size > 0) return { data: readFileSync(out), mediaType: "image/png" };
      return { error: "there's no image on the clipboard" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const tries: [string, string[]][] = process.env.WAYLAND_DISPLAY ? [["wl-paste", ["--no-newline", "--type", "image/png"]], ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]]] : [["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]], ["wl-paste", ["--no-newline", "--type", "image/png"]]];
  let ran = false;
  for (const [cmd, args] of tries) {
    const r = run(cmd, args);
    if (r.error) continue;
    ran = true;
    if (r.status === 0 && r.stdout.length > 8 && r.stdout.subarray(1, 4).toString() === "PNG") return { data: r.stdout, mediaType: "image/png" };
  }
  return { error: ran ? "there's no image on the clipboard" : "install wl-clipboard (Wayland) or xclip (X11) to paste images" };
}
