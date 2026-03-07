import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});
const {
  registerSelfImprovementLogTool,
  registerSelfImprovementExtractSkillTool,
} = jiti("../src/tools.ts");
const { appendSelfImprovementEntry } = jiti("../src/self-improvement-files.ts");
const { extractReflectionLessons, extractReflectionMappedMemories } = jiti("../src/reflection-slices.ts");

function createToolHarness(workspaceDir) {
  const factories = new Map();
  const api = {
    registerTool(factory, meta) {
      factories.set(meta?.name || "", factory);
    },
  };

  const context = {
    workspaceDir,
    retriever: {},
    store: {},
    scopeManager: {},
    embedder: {},
    mdMirror: null,
  };

  registerSelfImprovementLogTool(api, context);
  registerSelfImprovementExtractSkillTool(api, context);

  return {
    tool(name, toolCtx = {}) {
      const factory = factories.get(name);
      assert.ok(factory, `tool not registered: ${name}`);
      return factory(toolCtx);
    },
  };
}

describe("self-improvement", () => {
  describe("tool file-write flow", () => {
    let workspaceDir;

    beforeEach(() => {
      workspaceDir = mkdtempSync(path.join(tmpdir(), "self-improvement-test-"));
    });

    afterEach(() => {
      rmSync(workspaceDir, { recursive: true, force: true });
    });

    it("extracts mapped reflection sections into preference/fact/decision memories", async () => {
      const reflectionText = [
        "## Context (session background)",
        "- (none captured)",
        "",
        "## Decisions (durable)",
        "- Always verify file evidence before reporting completion.",
        "",
        "## User model deltas (about the human)",
        "- Prefers concise direct answers without confirmation loops.",
        "",
        "## Agent model deltas (about the assistant/system)",
        "- Should label empty-state status as triage before calling it a failure.",
        "",
        "## Learning governance candidates (.learnings / promotion / skill extraction)",
        "- LRN candidate: require file evidence before saying a skill was updated.",
      ].join("\n");
      const mapped = extractReflectionMappedMemories(reflectionText);
      assert.deepEqual(mapped, [
        {
          text: "Prefers concise direct answers without confirmation loops.",
          category: "preference",
          heading: "User model deltas (about the human)",
        },
        {
          text: "Should label empty-state status as triage before calling it a failure.",
          category: "preference",
          heading: "Agent model deltas (about the assistant/system)",
        },
        {
          text: "LRN candidate: require file evidence before saying a skill was updated.",
          category: "fact",
          heading: "Learning governance candidates (.learnings / promotion / skill extraction)",
        },
        {
          text: "Always verify file evidence before reporting completion.",
          category: "decision",
          heading: "Decisions (durable)",
        },
      ]);
    });

    it("appends reflection lessons into LEARNINGS.md with structured entry ids", async () => {
      const reflectionText = [
        "## Context (session background)",
        "- (none captured)",
        "",
        "## Lessons & pitfalls (symptom / cause / fix / prevention)",
        "- Symptom: empty-state status looked like a failure. Cause: no explicit triage label. Fix: classify empty-state as triage first. Prevention: avoid calling it breakage without reproduction.",
        "- Symptom: reported done without file proof. Cause: conversation claim outran file verification. Fix: attach file evidence before declaring completion. Prevention: always verify real paths before reporting.",
      ].join("\n");
      const lessons = extractReflectionLessons(reflectionText);
      assert.deepEqual(lessons, [
        "Symptom: empty-state status looked like a failure. Cause: no explicit triage label. Fix: classify empty-state as triage first. Prevention: avoid calling it breakage without reproduction.",
        "Symptom: reported done without file proof. Cause: conversation claim outran file verification. Fix: attach file evidence before declaring completion. Prevention: always verify real paths before reporting.",
      ]);

      const appended = await appendSelfImprovementEntry({
        baseDir: workspaceDir,
        type: "learning",
        summary: "Reflection lessons & pitfalls from command:reset",
        details: lessons.map((line) => `- ${line}`).join("\n"),
        suggestedAction: "Review and promote stable rules when they recur.",
        source: "memory-lancedb-pro/reflection:test",
      });

      assert.match(appended.id, /^LRN-\d{8}-001$/);
      const learningsPath = path.join(workspaceDir, ".learnings", "LEARNINGS.md");
      const learningsBody = readFileSync(learningsPath, "utf-8");
      assert.match(learningsBody, /## \[LRN-\d{8}-001\] best_practice/);
      assert.match(learningsBody, /Reflection lessons & pitfalls from command:reset/);
      assert.match(learningsBody, /empty-state status looked like a failure/);
      assert.match(learningsBody, /attach file evidence before declaring completion/);
      assert.match(learningsBody, /Source: memory-lancedb-pro\/reflection:test/);
    });

    it("handles learning id validation and writes promoted skill scaffold with sanitized outputDir", async () => {
      const harness = createToolHarness(workspaceDir);
      const logTool = harness.tool("self_improvement_log");
      const extractTool = harness.tool("self_improvement_extract_skill");

      const logged = await logTool.execute("tc-1", {
        type: "learning",
        summary: "Use deterministic temp fixtures in tests.",
        details: "Nondeterministic fixture paths caused flaky assertions.",
        suggestedAction: "Always bind fixtures to test-local temp dirs.",
        category: "best_practice",
        area: "tests",
        priority: "high",
      });

      const learningId = logged?.details?.id;
      assert.match(learningId, /^LRN-\d{8}-001$/);

      const invalid = await extractTool.execute("tc-2", {
        learningId: "LRN-INVALID",
        skillName: "deterministic-fixtures",
      });
      assert.equal(invalid?.details?.error, "invalid_learning_id");

      const extracted = await extractTool.execute("tc-3", {
        learningId,
        skillName: "deterministic-fixtures",
        outputDir: "../../outside//skills",
      });

      assert.equal(extracted?.details?.action, "skill_extracted");
      const skillPath = extracted?.details?.skillPath;
      assert.ok(typeof skillPath === "string" && skillPath.length > 0);
      assert.ok(!skillPath.includes(".."), `skillPath must be sanitized: ${skillPath}`);
      assert.ok(!skillPath.startsWith("/"), `skillPath must stay relative: ${skillPath}`);

      const absSkillPath = path.resolve(workspaceDir, skillPath);
      assert.ok(
        absSkillPath.startsWith(path.resolve(workspaceDir) + path.sep),
        `skill file escaped workspace: ${absSkillPath}`
      );

      const skillContent = readFileSync(absSkillPath, "utf-8");
      assert.match(skillContent, /# Deterministic Fixtures/);
      assert.match(skillContent, new RegExp(`Learning ID: ${learningId}`));

      const learningsPath = path.join(workspaceDir, ".learnings", "LEARNINGS.md");
      const learningsBody = readFileSync(learningsPath, "utf-8");
      assert.match(learningsBody, /\*\*Status\*\*:\s*promoted_to_skill/);
      assert.match(learningsBody, /Skill-Path:\s*outside\/skills\/deterministic-fixtures/);
    });
  });
});
