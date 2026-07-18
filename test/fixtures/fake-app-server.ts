import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";

interface Message {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

let threadNumber = 0;
let turnNumber = 0;
const lines = createInterface({ input: process.stdin });
const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

async function structuredOutput(prompt: string): Promise<unknown> {
  if (prompt.includes("[SAFECHANGE_ROLE:discovery]")) {
    return {
      summary: "Small TypeScript fixture with one source file.",
      facts: [
        {
          id: "F1",
          claim: "The source is under src.",
          references: [{ path: "src/value.ts", detail: "exports the current value" }],
        },
      ],
      commands: [{ name: "test", argv: ["npm", "test"], purpose: "Run tests" }],
      testGaps: ["Requested behavior has no acceptance test."],
      constraints: ["Keep the public function stable."],
      assumptions: [],
      unknowns: [],
    };
  }
  if (prompt.includes("[SAFECHANGE_ROLE:contract]")) {
    return {
      goal: "Add the requested behavior with a minimal verified change.",
      acceptanceCriteria: [{ id: "AC1", statement: "Requested behavior is observable." }],
      protectedInvariants: [{ id: "INV1", statement: "Public API remains stable." }],
      nonGoals: ["No dependency changes."],
      allowedPathPrefixes: ["src", "test"],
      approvalRequiredChanges: ["New production dependencies"],
      evidenceGaps: ["Acceptance test is missing."],
      risks: ["Behavioral regression."],
      unknowns: [],
    };
  }
  if (prompt.includes("[SAFECHANGE_ROLE:planner]")) {
    const planId = prompt.match(/planner (plan-\d+)/)?.[1] ?? "plan-1";
    const lens = prompt.match(/lens is: ([a-z-]+)/)?.[1] ?? "minimal-change";
    return {
      planId,
      lens,
      title: `${lens} fixture plan`,
      approach: `Use the ${lens} approach in the existing module.`,
      rationale: "It is bounded and directly testable.",
      acceptanceCoverage: [{ id: "AC1", strategy: "Add an acceptance test." }],
      invariantProtection: [{ id: "INV1", strategy: "Keep the exported signature." }],
      files: [
        { path: "test/value.test.ts", purpose: "Acceptance coverage" },
        { path: "src/value.ts", purpose: "Implementation" },
      ],
      steps: [
        { id: "S1", description: "Add the failing acceptance test.", paths: ["test/value.test.ts"] },
        { id: "S2", description: "Implement the behavior.", paths: ["src/value.ts"] },
      ],
      safetyTests: [{ name: "acceptance", proves: "AC1 and INV1", argv: ["npm", "test"] }],
      verificationCommands: [{ name: "test", argv: ["npm", "test"], purpose: "Verify behavior" }],
      dependencies: [],
      migrations: [],
      approvalRequiredChanges: [],
      risks: ["Local behavior may change."],
      assumptions: [],
      unknowns: [],
      recovery: ["Revert the implementation commit."],
      rejectionReasons: [],
    };
  }
  if (prompt.includes("[SAFECHANGE_ROLE:judge]")) {
    return {
      winnerPlanId: "plan-1",
      reason: "It is the smallest admissible plan.",
      rejectedPlans: [
        { planId: "plan-2", reason: "Less direct." },
        { planId: "plan-3", reason: "Larger risk focus than needed." },
      ],
      tradeoffs: ["Uses the existing module."],
      residualRisks: ["Only fixture evidence is available."],
      humanDecisionRequired: false,
      humanDecisionReason: "",
    };
  }
  if (prompt.includes("[SAFECHANGE_ROLE:test-author]")) {
    await mkdir("test", { recursive: true });
    await writeFile(
      "test/value.test.ts",
      `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "../src/value.ts";\n\ntest("requested value", () => {\n  assert.equal(value, 2);\n});\n`,
      "utf8",
    );
    return {
      summary: "Added a failing acceptance test for the requested value.",
      testPaths: ["test/value.test.ts"],
      fixturePaths: [],
      targetedCommand: {
        name: "targeted acceptance",
        argv: ["node", "--test", "test/value.test.ts"],
        purpose: "Prove the requested behavior is missing on baseline",
      },
      expectedBaselineOutcome: "fail",
      expectedFailure: "Expected values to be strictly equal",
      protectedPaths: ["test/value.test.ts"],
    };
  }
  if (prompt.includes("[SAFECHANGE_ROLE:implementer]")) {
    await writeFile("src/value.ts", "export const value = 2;\n", "utf8");
    return {
      summary: "Changed the existing value implementation within selected scope.",
      changedPaths: ["src/value.ts"],
      testsAdded: [],
      scopeNotes: ["Protected safety test was not changed."],
      residualRisks: [],
    };
  }
  if (prompt.includes("[SAFECHANGE_ROLE:verifier]")) {
    return {
      verdict: "accept",
      contractFulfilled: true,
      invariantsPreserved: true,
      scopeConformant: true,
      evidenceSufficient: true,
      reason: "Actual diff is scoped and deterministic tests pass.",
      findings: [],
      residualRisks: ["Fixture verification covers only the requested value."],
    };
  }
  return { kind: "smoke", message: "ok" };
}

lines.on("line", async (line) => {
  const message = JSON.parse(line) as Message;
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        userAgent: "fake-app-server",
        codexHome: "/tmp/fake-codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    return;
  }

  if (message.method === "thread/start" || message.method === "thread/fork") {
    threadNumber += 1;
    send({ id: message.id, result: { thread: { id: `thread-${threadNumber}` } } });
    return;
  }

  if (message.method === "turn/start") {
    turnNumber += 1;
    const turnId = `turn-${turnNumber}`;
    const threadId = String(message.params?.threadId ?? "thread-unknown");
    const input = message.params?.input as Array<{ type: string; text?: string }> | undefined;
    const prompt = input?.find((item) => item.type === "text")?.text ?? "";
    const text = JSON.stringify(await structuredOutput(prompt));
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        completedAtMs: Date.now(),
        item: {
          type: "agentMessage",
          id: `item-${turnNumber}`,
          text,
          phase: null,
          memoryCitation: null,
        },
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: turnId,
          items: [],
          itemsView: { type: "full" },
          status: "completed",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: 1,
        },
      },
    });
    return;
  }

  if (message.id !== undefined) send({ id: message.id, result: {} });
});
