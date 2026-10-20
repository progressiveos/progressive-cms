import assert from "node:assert/strict";
import { test } from "node:test";
import * as sdk from "@pcms/extensions";

test("the root package exposes only the stable Extension SDK runtime allowlist", () => {
  assert.deepEqual(Object.keys(sdk).sort(), [
    "EXTENSION_CONTRACT_VERSION",
    "EXTENSION_ERROR_CODES",
    "EXTENSION_MANIFEST_ISSUE_CODES",
    "EXTENSION_MANIFEST_MAX_BYTES",
    "EXTENSION_MANIFEST_SCHEMA",
    "EXTENSION_PROVIDER_REGISTRIES",
    "EXTENSION_VALIDATOR_POINTS",
    "ExtensionError",
    "PACKAGE_NAME",
    "createExtensionFetchClient",
    "createExtensionFetchClientFromConfig",
    "isTransportFailure",
    "parseOutboundPolicy",
    "validateExtensionManifest",
  ]);
  assert.equal(sdk.EXTENSION_CONTRACT_VERSION, "2.0");
  assert.equal("createExtensionCatalog" in sdk, false);
  assert.equal("createExtensionPlatformServices" in sdk, false);
});
