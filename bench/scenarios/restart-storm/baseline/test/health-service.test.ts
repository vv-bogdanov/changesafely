import assert from "node:assert/strict";
import test from "node:test";

import { type DatabaseHealth, HealthService, type ProcessState } from "../src/health-service.js";

class MutableDatabase implements DatabaseHealth {
  available = true;
  async isAvailable(): Promise<boolean> {
    return this.available;
  }
}

test("reports all probes healthy for a started process", async () => {
  const service = new HealthService(new MutableDatabase(), { running: true, started: true });

  assert.equal(await service.liveness(), true);
  assert.equal(await service.readiness(), true);
  assert.equal(await service.startup(), true);
});

test("removes a stopped process from health", async () => {
  const service = new HealthService(new MutableDatabase(), { running: false, started: true });

  assert.equal(await service.liveness(), false);
  assert.equal(await service.readiness(), false);
  assert.equal(await service.startup(), false);
});

test("tracks startup independently for a live process", async () => {
  const processState: ProcessState = { running: true, started: false };
  const service = new HealthService(new MutableDatabase(), processState);
  assert.equal(await service.startup(), false);

  processState.started = true;
  assert.equal(await service.startup(), true);
});
