const assert = require("node:assert/strict");
const test = require("node:test");
const { value } = require("../src/value.js");

test("producer value remains callable", () => {
  assert.equal(typeof value, "function");
});
