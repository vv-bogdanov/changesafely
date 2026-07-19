import type { ChangeContract, DetailedPlan, EvidenceArtifact } from "../../src/schemas.js";

export function validEvidence(overrides: Partial<EvidenceArtifact> = {}): EvidenceArtifact {
  return {
    summary: "Fixture repository",
    facts: [],
    commands: [],
    testGaps: [],
    constraints: [],
    assumptions: [],
    unknowns: [],
    ...overrides,
  };
}

export function validContract(overrides: Partial<ChangeContract> = {}): ChangeContract {
  return {
    goal: "Change behavior",
    acceptanceCriteria: [{ id: "AC1", statement: "Behavior changes" }],
    protectedInvariants: [{ id: "INV1", statement: "API is stable" }],
    nonGoals: [],
    allowedPathPrefixes: ["src", "test"],
    approvalRequiredChanges: [],
    evidenceGaps: [],
    risks: [],
    unknowns: [],
    ...overrides,
  };
}

export function validPlan(overrides: Partial<DetailedPlan> = {}): DetailedPlan {
  return {
    planId: "plan-1",
    lens: "minimal-change",
    title: "Small fixture plan",
    approach: "Change one existing module",
    rationale: "The change is direct and bounded.",
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
    safetyTests: [{ name: "acceptance", proves: "AC1", argv: ["npm", "test"] }],
    verificationCommands: [{ name: "test", argv: ["npm", "test"], purpose: "Verify behavior" }],
    dependencies: [],
    migrations: [],
    approvalRequiredChanges: [],
    risks: ["Local behavior may change."],
    assumptions: [],
    unknowns: [],
    recovery: ["Revert the implementation commit."],
    rejectionReasons: [],
    ...overrides,
  };
}
