import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "og-skills-"));
const home = join(root, "home");
const ogHome = join(root, "og");
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.OPENGATE_HOME = ogHome;

const skills = await import("../src/skills");
const { configDir } = await import("../src/config");
const ext = await import("../src/ext");

const skill = (dir: string, name: string, description: string, body = `Body of ${name}.`) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
};

const project = join(root, "proj");
mkdirSync(join(project, ".git"), { recursive: true });
const sub = join(project, "packages", "app");
mkdirSync(sub, { recursive: true });

// Same name in many places: the precedence decides which wins.
skill(join(home, ".codex", "skills", ".system", "dup"), "dup", "codex system");
skill(join(home, ".codex", "skills", "dup"), "dup", "codex user");
skill(join(home, ".claude", "skills", "dup"), "dup", "claude user");
skill(join(home, ".agents", "skills", "dup"), "dup", "agents user");
skill(join(configDir(), "skills", "dup"), "dup", "opengate user");
skill(join(project, ".claude", "skills", "dup"), "dup", "claude project");
skill(join(project, ".opengate", "skills", "dup"), "dup", "opengate project");
// Others
skill(join(home, ".claude", "skills", "synced", "abc_123", "pdf"), "pdf", "Work with PDF files");
skill(join(home, ".claude", "skills", ".trash", "gone"), "gone", "deleted");
skill(join(home, ".codex", "skills", ".system", "imagegen"), "imagegen", "Make images");
skill(join(home, ".codex", "skills", "imagegen"), "imagegen", "Codex user imagegen");
skill(join(home, ".claude", "skills", "imagegen"), "imagegen", "Claude imagegen");
skill(join(project, ".agents", "skills", "proj-only"), "proj-only", "A project skill");
writeFileSync(join(project, ".agents", "skills", "proj-only", "run.py"), "print(1)\n");
mkdirSync(join(project, ".agents", "skills", "proj-only", "references"), { recursive: true });
writeFileSync(join(project, ".agents", "skills", "proj-only", "references", "a.md"), "ref\n");

describe("skills", () => {
  test("frontmatter: quoted, folded, block, nested maps, CRLF, BOM", () => {
    const { meta, body } = skills.parseFrontmatter(
      "\uFEFF" + '---\r\nname: docx\r\ndescription: "Use for Word: docs, \\"quotes\\""\r\nlicense: MIT\r\nmetadata:\r\n  short-description: x\r\n---\r\n# Title\r\nText',
    );
    expect(meta).toEqual({ name: "docx", description: 'Use for Word: docs, "quotes"', license: "MIT" });
    expect(body).toBe("# Title\r\nText");
    expect(skills.parseFrontmatter("---\nname: a\ndescription: >\n  one\n  two\n---\nb").meta.description).toBe("one two");
    expect(skills.parseFrontmatter("---\nname: a\ndescription: |\n  one\n  two\n---\nb").meta.description).toBe("one\ntwo");
    expect(skills.parseFrontmatter("---\nname: a\ndescription: starts here\n  and continues\n---\n").meta.description).toBe("starts here and continues");
    expect(skills.parseFrontmatter("---\nname: 'it''s'\n---\n").meta.name).toBe("it's");
    expect(skills.parseFrontmatter("no frontmatter").body).toBe("no frontmatter");
  });

  test("discovery: project beats user; opengate > .agents > Claude > Codex; synced layout; .trash skipped", () => {
    const found = skills.discoverSkills(sub);
    const by = Object.fromEntries(found.map((s) => [s.name, s]));
    expect(by.dup.description).toBe("opengate project");
    expect(by.dup.scope).toBe("project");
    expect(by.imagegen.description).toBe("Claude imagegen");
    expect(by.pdf.dir).toBe(join(home, ".claude", "skills", "synced", "abc_123", "pdf"));
    expect(by.pdf.source).toBe(join("~", ".claude", "skills", "synced"));
    expect(by["proj-only"].scope).toBe("project");
    expect(by.gone).toBeUndefined();
    expect(found.map((s) => s.name)).toEqual(["dup", "imagegen", "pdf", "proj-only"]);

    // Outside the project only user skills apply, in user precedence order.
    const elsewhere = Object.fromEntries(skills.discoverSkills(join(root, "other")).map((s) => [s.name, s.description]));
    expect(elsewhere.dup).toBe("opengate user");
    expect(elsewhere["proj-only"]).toBeUndefined();
  });

  test("the cache notices edits", async () => {
    const dir = join(home, ".agents", "skills", "edited");
    skill(dir, "edited", "first");
    expect(skills.findSkill(root, "edited")?.description).toBe("first");
    await Bun.sleep(20);
    skill(dir, "edited", "second");
    expect(skills.findSkill(root, "edited")?.description).toBe("second");
  });

  test("the prompt section lists skills, cuts long descriptions and stays under the cap", () => {
    const text = skills.renderSkillsSection(skills.discoverSkills(sub))!;
    expect(text).toContain("# Skills");
    expect(text).toContain("`skill` tool");
    expect(text).toContain("- pdf: Work with PDF files");
    expect(skills.renderSkillsSection([])).toBeNull();

    const many = Array.from({ length: 200 }, (_, i) => ({ name: `skill-${i}`, description: "d".repeat(1000), dir: "", file: "", source: "", scope: "user" as const }));
    const big = skills.renderSkillsSection(many)!;
    expect(big.length).toBeLessThanOrEqual(skills.SECTION_CAP);
    expect(big).toContain("skill-0: ");
    expect(big).toMatch(/more skills not listed|Also:/);
    const few = skills.renderSkillsSection(many.slice(0, 3))!;
    expect(few).toContain(`skill-0: ${"d".repeat(299)}…`);
    expect(few).not.toContain("d".repeat(300));
  });

  test("the skill tool returns the body, folder, files and the tool-name note", async () => {
    const events: any[] = [];
    const ctx = { cwd: sub, readFiles: new Map(), ui: { event: (e: any) => events.push(e) } as any };
    const r = await skills.skillTool.run({ name: "proj-only" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain("Body of proj-only.");
    expect(r.output).not.toContain("description: A project skill");
    expect(r.output).toContain(`Folder: ${join(project, ".agents", "skills", "proj-only")}`);
    expect(r.output).toContain("- SKILL.md");
    expect(r.output).toContain("- run.py");
    expect(r.output).toContain("- references/a.md");
    expect(r.output).toContain("Bash→shell");
    expect(events).toEqual([{ type: "skill", action: "loaded", name: "proj-only" }]);
    expect(skills.skillTool.asks("ask")).toBe(false);
    expect(skills.skillTool.parallel).toBe(true);

    const missing = await skills.skillTool.run({ name: "nope" }, ctx);
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain("proj-only");
  });

  test("/skills lists skills with their source", async () => {
    let out = "";
    const session = { data: { cwd: sub } } as any;
    await ext.getCommand("skills")!.run({ session, args: "", print: (t) => (out += t), ui: {} as any });
    expect(out).toContain("pdf");
    expect(out).toContain(join("~", ".claude", "skills", "synced"));
  });
});
