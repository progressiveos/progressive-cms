// Image Generation v2 (plan T1.4): Runware model catalog — modelSearch task
// shaping/error parsing and the docs-catalog air↔slug mapping. The HTML
// sample mirrors the real runware.ai/docs/models `data-model` attributes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "@pcms/media";
import {
  fetchDocsCatalog,
  modelSearchTask,
  parseDocsCatalog,
  runwareModelSearch,
  slugForAir,
} from "../../extensions/progressive-media-runware/src/catalog.js";

test("modelSearch task shaping: filters and limit only when set", () => {
  const task = modelSearchTask({
    search: "nano banana",
    capabilities: ["io:text-to-image"],
    source: "curated",
    limit: 6,
  });
  assert.equal(task.taskType, "modelSearch");
  assert.equal(task.search, "nano banana");
  assert.deepEqual(task.capabilities, ["io:text-to-image"]);
  assert.equal(task.source, "curated");
  assert.equal(task.limit, 6);
  assert.match(String(task.taskUUID), /^[0-9a-f-]{36}$/);
});

test("modelSearch: results map to provider-neutral summaries", async () => {
  const post = async () => ({
    data: [
      {
        taskType: "modelSearch",
        totalResults: 4,
        results: [
          {
            air: "google:4@2",
            name: "Nano Banana Pro",
            capabilities: ["io:text-to-image", "io:image-to-image", "op:edit"],
            heroImage: "https://assets.runware.ai/covers/pro.jpg",
          },
          { air: "google:4@1", name: "Nano Banana", capabilities: ["io:text-to-image"] },
          { name: "airless entry is skipped" },
        ],
      },
    ],
  });
  const page = await runwareModelSearch(post, { search: "nano" });
  assert.equal(page.totalResults, 4);
  assert.equal(page.results.length, 2);
  assert.equal(page.results[0]!.model, "google:4@2");
  assert.equal(page.results[0]!.displayName, "Nano Banana Pro");
  assert.equal(page.results[0]!.thumbnail, "https://assets.runware.ai/covers/pro.jpg");
});

test("modelSearch: provider contract errors surface allowedValues", async () => {
  const post = async () => ({
    data: [],
    errors: [
      {
        code: "invalidSource",
        message: "Invalid value for 'source' parameter.",
        parameter: "source",
        allowedValues: ["curated", "community", "merged"],
      },
    ],
  });
  await assert.rejects(
    () => runwareModelSearch(post, { search: "x" }),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.code === "PROVIDER_INVALID_REQUEST" &&
      /curated.*community.*merged/.test(error.message),
  );
});

const DOCS_HTML_SAMPLE =
  '<li><a href="/docs/models/alibaba-z-image-turbo" data-model="{&quot;model&quot;:&quot;alibaba-z-image-turbo&quot;,&quot;air&quot;:&quot;runware:z-image@turbo&quot;,&quot;title&quot;:&quot;Z-Image-Turbo&quot;,&quot;capabilities&quot;:[&quot;io:text-to-image&quot;],&quot;status&quot;:&quot;live&quot;,&quot;weight&quot;:3}"><span>Z-Image-Turbo</span></a></li>' +
  '<li><a href="/docs/models/google-nano-banana-pro" data-model="{&quot;model&quot;:&quot;google-nano-banana-pro&quot;,&quot;air&quot;:&quot;google:4@2&quot;,&quot;title&quot;:&quot;Nano Banana Pro&quot;,&quot;status&quot;:&quot;live&quot;}"><span>Nano Banana Pro</span></a></li>' +
  '<a href="/docs/models/broken" data-model="{not json">x</a>';

test("docs catalog: parses data-model attributes, skips malformed, maps air→slug", async () => {
  const catalog = await fetchDocsCatalog(async () => DOCS_HTML_SAMPLE);
  assert.equal(catalog.entries.length, 2);
  assert.equal(catalog.entries[0]!.air, "runware:z-image@turbo");
  assert.equal(catalog.entries[0]!.slug, "alibaba-z-image-turbo");
  assert.equal(slugForAir(catalog, "google:4@2"), "google-nano-banana-pro");
  assert.equal(slugForAir(catalog, "unknown:9@9"), null);
});

test("docs catalog: unusable response falls back to the previous catalog", async () => {
  const good = await fetchDocsCatalog(async () => DOCS_HTML_SAMPLE);
  const fallback = await fetchDocsCatalog(async () => "<html></html>", good);
  assert.equal(fallback, good); // same object — previous kept, not emptied
  await assert.rejects(
    () => fetchDocsCatalog(async () => "<html></html>"),
    (error: unknown) => error instanceof ProviderError,
  );
});
