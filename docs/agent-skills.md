# Official Agent Skills: installation and compatibility

Skills provide guidance, not permissions. Three official self-contained Agent Skills are supplied:

| Skill | Purpose | Version |
|---|---|---|
| [progressive-cms-site-builder](skills/progressive-cms-site-builder/SKILL.md) | Build an editable site from a brief, using local workflow, API schemas, examples and theme assets | 1.3.1 |
| [progressive-cms-152fz](skills/progressive-cms-152fz/SKILL.md) | Technical personal-data readiness of an existing site: data flows, consent, access, retention and verified controls; owner-selected consent/retention and addressed tools; owner handles legal documents/RKN | 1.1.0 |
| [progressive-cms-seo](skills/progressive-cms-seo/SKILL.md) | Thorough applicable Google/Yandex SEO fixes, metadata/H1/duplicates, crawl/rendering and performance evidence | 1.0.1 |

These are portable instruction Skills, not executable CMS Extensions or an automatic legal/ranking certification. Each includes a CMS manifest, local references, selected API schemas and optional Codex UI metadata. The additional content-agent documentation distribution is **1.5.3**. The [catalogue](skills/catalog.json) and manifests declare compatibility independently of the product release. The specialist workflows and source annotations are in Russian.

## Install in an agent

Copy the whole selected Skill directory (`progressive-cms-site-builder`, `progressive-cms-152fz` or `progressive-cms-seo`) from the release's root `skills/` (or the identical `docs/skills/` copy), including references/assets/manifest. Choose the project's native skills location; the table uses site-builder as an example, and the two specialist IDs use the identical directory pattern:

| Agent | Project destination | Invocation |
|---|---|---|
| Codex CLI / IDE | `.agents/skills/progressive-cms-site-builder/` | `$progressive-cms-site-builder` |
| Claude Code | `.claude/skills/progressive-cms-site-builder/` | `/progressive-cms-site-builder` |
| GitHub Copilot | `.github/skills/progressive-cms-site-builder/` | Ask it to use `progressive-cms-site-builder` |

The same standard `SKILL.md` with YAML `name`/`description` is used for all three. Installation paths and discovery behavior follow the [Agent Skills specification](https://agentskills.io/specification), [official OpenAI documentation](https://learn.chatgpt.com/docs/build-skills), [Claude Code docs](https://code.claude.com/docs/en/skills) and [GitHub Copilot docs](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills). Host settings/workspace trust still apply; format compatibility is not a tested live session in every client.

For example, in a new Codex project destination:

```sh
PCMS_SKILL_SOURCE="<release-folder>/skills/progressive-cms-site-builder"
PCMS_SKILL_DEST=".agents/skills/progressive-cms-site-builder"
test ! -e "$PCMS_SKILL_DEST" || exit 1
mkdir -p .agents/skills
cp -R "$PCMS_SKILL_SOURCE" "$PCMS_SKILL_DEST"
```

If a version is already installed, compare manifests and replace it deliberately; do not merge stale files. For Claude/Copilot choose their table destination instead. No agent-host CLI/plugin installation, repository publication or global user configuration is performed by this copy.

Start with a prompt such as:

> Use progressive-cms-site-builder to build an editable company site from this brief. Use the authorized CMS origin, site and environment supplied for this task. Start with bootstrap and show any missing prerequisite. Publication is included only if explicitly authorized in the task.

For the specialist tasks:

> Use progressive-cms-152fz to technically prepare this existing site for personal-data processing under 152-FZ. Apply the approved operator data, documents and retention policy; verify controls and list unresolved technical blockers separately from the owner's legal actions.

> Use progressive-cms-seo to fix all applicable Google/Yandex SEO issues on this site. Check the complete URL/metadata inventory, duplicates and H1, crawl policy, public HTML, media and performance; report coverage and pending external evidence honestly.

The agent then follows the selected local Skill workflow, loading deeper references only for the operation needed. CLI, ordinary HTTP access or an already configured CMS MCP connection is required; the Skill does not install a CMS or create credentials.

## CMS manifest discovery is a separate path

The JSON manifest lets the CMS CLI evaluate versions/contracts/scopes. With the release Skill root available locally:

```sh
export PCMS_SKILLS_DIR="<release-folder>/skills"
cms skills list --json
cms skills show progressive-cms-site-builder --json
cms skills doc progressive-cms-site-builder --json
cms skills check progressive-cms-site-builder --json
```

For the additional content-agent docs distribution, point `PCMS_SKILLS_DIR` to `<release-folder>/docs/skills`; its workflow references the surrounding documentation. First-party IDs must not be sent to `cms skills install`, which is the community-package channel. A local root override changes client discovery, not server permissions. Bootstrap can list a separate runtime copy; compare its exact Skill version before use.

## Compatibility and acceptance

Minimum CMS ranges live in [152-FZ manifest](skills/progressive-cms-152fz/manifest.json), [SEO manifest](skills/progressive-cms-seo/manifest.json), [site-builder manifest](skills/progressive-cms-site-builder/manifest.json), [content-agent manifest](skills/progressive-cms-content-agent/manifest.json) and the catalogue. A historical lower bound is not the current product release. Use the actual Core resolver for prerelease matching; a higher-looking unrelated prerelease is not automatically compatible.

The deterministic release check validates metadata, resources and self-contained references. It does not prove live agent performance or installed site behavior. For actual use, record target compatibility, publication results and normal editor continuation separately; see the Skill's [checks](skills/progressive-cms-site-builder/references/checks.md).

[Documentation index](index.md)
