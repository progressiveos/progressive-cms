import assert from "node:assert/strict";
import { test } from "node:test";

import { PACKAGE_NAME as CORE } from "@pcms/core";

test("workspace package resolution works", () => {
  assert.equal(CORE, "@pcms/core");
});
