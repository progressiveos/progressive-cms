# Include documentation and the official Skill in a release

The release includes ordinary Markdown under `docs/`, preserving `reference/` and `skills/`. The official `progressive-cms-site-builder`, `progressive-cms-152fz` and `progressive-cms-seo` folders are also shipped at source-release root `skills/`, identical to their docs copies and self-contained for separate agent installation. The Russian documentation under `ru/` is partial.

The release-source preparation tool `scripts/public-docs.mjs` takes the product version selected by the existing CMS release process:

```sh
node scripts/public-docs.mjs prepare --release-version "$RELEASE_VERSION" --out "$DOCS_OVERLAY"
```

The new output directory contains `docs/`, root `skills/` with those three standalone Skills and the same check tool. Include it in the isolated release source export, deliberately replacing older same-id official Skill folders rather than merging files. Keep other runtime Skills. Before Core's existing build, validate the actual staging paths and selected version:

```sh
node scripts/public-docs.mjs check --docs-dir "$RELEASE_SOURCE/docs" --skills-dir "$RELEASE_SOURCE/skills" --release-version "$RELEASE_VERSION"
```

The check fails on a version mismatch, unmanaged release numbers, missing links/resources or root/docs Skill drift. Preparation updates only marked current-release text, preserving historical provenance and minimum compatibility ranges. It cannot certify new Core behavior; review changed contracts separately. Root development package versions/tags are not installed release authority.

Pass the prepared docs folder to Core's existing `--docs-dir`; its builder already includes/validates root `skills/`. No documentation archive, file-inventory manifest or independent docs release is needed. Do not mount docs automatically on customer sites or publish public repositories as a side effect.
