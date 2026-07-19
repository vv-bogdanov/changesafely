import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

interface Message {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

let threadNumber = 0;
let turnNumber = 0;
let verifierNumber = 0;
const mode = process.argv[2] ?? "default";
const lines = createInterface({ input: process.stdin });
const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

interface PendingCompletion {
  threadId: string;
  turnId: string;
  text: string;
}

let pendingCompletion: PendingCompletion | undefined;

function completeTurn({ threadId, turnId, text }: PendingCompletion): void {
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
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: 1,
      },
    },
  });
}

async function structuredOutput(prompt: string): Promise<unknown> {
  if (prompt.includes("[SAFECHANGE_ROLE:discovery]")) {
    if (mode === "malformed") return { summary: "missing required fields" };
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
    if (mode === "out-of-order") {
      const delay = planId === "plan-1" ? 40 : planId === "plan-2" ? 20 : 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
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
        {
          id: "S1",
          description: "Add the failing acceptance test.",
          paths: ["test/value.test.ts"],
        },
        { id: "S2", description: "Implement the behavior.", paths: ["src/value.ts"] },
      ],
      safetyTests: [
        {
          name: "acceptance",
          proves: "AC1 and INV1",
          argv:
            mode === "planner-correction" && !prompt.includes("[SAFECHANGE_CORRECTION]")
              ? ["npm", "run", "typecheck"]
              : ["npm", "test"],
        },
      ],
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
    if (mode === "judge-correction" && !prompt.includes("[SAFECHANGE_CORRECTION]")) {
      return {
        winnerPlanId: "plan-1",
        reason: "The plan is eligible but a residual policy question remains.",
        rejectedPlans: [],
        tradeoffs: [],
        residualRisks: ["Fixture policy is intentionally narrow."],
        humanDecisionRequired: true,
        humanDecisionReason: "Confirm the existing fixture policy.",
      };
    }
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
        argv: ["npm", "test"],
        purpose: "Prove the requested behavior is missing on baseline",
      },
      expectedBaselineOutcome: "fail",
      expectedFailure: "Expected values to be strictly equal",
      protectedPaths: ["test/value.test.ts"],
    };
  }
  if (prompt.includes("[SAFECHANGE_ROLE:implementer]")) {
    const source =
      mode === "failed-command"
        ? "export const value = 3;\n"
        : mode === "repair"
          ? "export const value = 2; // verifier repair target\n"
          : "export const value = 2;\n";
    await writeFile("src/value.ts", source, "utf8");
    if (mode === "protected-edit") {
      await writeFile("test/value.test.ts", "// weakened\n", "utf8");
    }
    if (mode === "scope-expansion") {
      await writeFile("unexpected.ts", "export {};\n", "utf8");
    }
    if (mode === "protected-config") {
      await writeFile(".env", "SAFECHANGE_TEST_VALUE=changed\n", "utf8");
    }
    return {
      summary: "Changed the existing value implementation within selected scope.",
      changedPaths: ["src/value.ts"],
      testsAdded: [],
      scopeNotes: ["Protected safety test was not changed."],
      residualRisks: [],
    };
  }
  if (prompt.includes("[SAFECHANGE_ROLE:repair]")) {
    await writeFile("src/value.ts", "export const value = 2;\n", "utf8");
    return {
      summary: "Removed the concrete local defect reported by the Verifier.",
      changedPaths: ["src/value.ts"],
      testsAdded: [],
      scopeNotes: ["Repair stayed within the selected production path."],
      residualRisks: [],
    };
  }
  if (prompt.includes("[SAFECHANGE_ROLE:verifier]")) {
    verifierNumber += 1;
    if (mode === "repair" && verifierNumber === 1) {
      return {
        verdict: "reject",
        contractFulfilled: false,
        invariantsPreserved: false,
        scopeConformant: true,
        evidenceSufficient: true,
        reason: "A concrete local implementation defect remains.",
        findings: [
          {
            code: "LOCAL_DEFECT",
            severity: "error",
            message: "Remove the temporary implementation marker.",
            path: "src/value.ts",
          },
        ],
        residualRisks: [],
      };
    }
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
  if (mode === "server-request" && message.id === "approval-1" && !message.method) {
    if (message.error?.code !== -32601 || !pendingCompletion) process.exitCode = 1;
    else completeTurn(pendingCompletion);
    pendingCompletion = undefined;
    return;
  }
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

  if (message.method === "thread/resume") {
    send({
      id: message.id,
      result: { thread: { id: String(message.params?.threadId ?? "thread-unknown") } },
    });
    return;
  }

  if (message.method === "turn/start") {
    if (
      mode === "expect-spark" &&
      (message.params?.model !== "gpt-5.3-codex-spark" || message.params?.effort !== "low")
    ) {
      send({ id: message.id, error: { code: -32602, message: "model/effort mismatch" } });
      return;
    }
    if (
      mode === "expect-workflow-spark" &&
      (message.params?.model !== "gpt-5.3-codex-spark" || message.params?.effort !== "medium")
    ) {
      send({ id: message.id, error: { code: -32602, message: "model/effort mismatch" } });
      return;
    }
    turnNumber += 1;
    const turnId = `turn-${turnNumber}`;
    const threadId = String(message.params?.threadId ?? "thread-unknown");
    const input = message.params?.input as Array<{ type: string; text?: string }> | undefined;
    const prompt = input?.find((item) => item.type === "text")?.text ?? "";
    const text = JSON.stringify(await structuredOutput(prompt));
    send({ id: message.id, result: { turn: { id: turnId } } });
    if (mode === "malformed-notification") {
      send({ method: "item/completed", params: { turnId } });
      return;
    }
    if (mode === "server-request") {
      pendingCompletion = { threadId, turnId, text };
      send({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: {},
      });
      return;
    }
    completeTurn({ threadId, turnId, text });
    return;
  }

  if (message.id !== undefined) send({ id: message.id, result: {} });
});
