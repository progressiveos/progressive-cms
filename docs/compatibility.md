# Versioning and compatibility

<!-- cms-current:start -->
Current Progressive CMS release: **RC29** (`1.0.0-rc.29`).
<!-- cms-current:end -->

This guide describes the current product behavior. Historical release introductions below explain provenance; they do not identify the current product or the installed server. Skill versions and minimum compatible CMS ranges are independent of the release label. The authoritative ranges live in the supplied Skill/theme manifests, not copied version numbers in instructions.

Read `server.cms_version` and `server.release_id` from `cms agent bootstrap --json`. Use the actual server version for theme validation and Skill compatibility. Do not infer it from development `package.json`, source Git tags or a documentation label. Guardian's immutable release metadata identifies release commits and artifacts separately from reviewed Core source SHAs.

| Contract | Documented boundary |
|---|---|
| REST / OpenAPI | 1.0.0 / 3.1.0 |
| Theme | 1.0, manifest v2 |
| Extension | 2.0 |
| RichText | AST v2 only |
| Block Document | envelope v1, independent of RichText |
| Skill manifest | v1 |
| MCP | 2024-11-05 |

## Historical introductions and source provenance

<!-- cms-history:start -->
| Introduction | Contract / public documentation |
|---|---|
| RC16 / RC18 | RichText v2 introduced / runtime became v2-only; retained historical compatibility boundary. See [RichText](richtext.md). |
| RC19 | Content/body-policy corrections, breadcrumbs and social-image inheritance; minimum for the supplied authoring workflows. See [Content Contract](content-contract.md), [Navigation](navigation.md), and [SEO](seo.md). |
| Extension/Payments delta | Public extension and payment contracts. See [Extensions](extensions.md) and [Payments](payments.md). |
| RC24 | Trusted Admin HTTP client. See [Admin](admin.md) and [Security](security.md). |
| RC25 | Periodic jobs, lifecycle obligations, update ordering and Admin screen continuity. See [Operations](operations.md) and [Admin](admin.md). |
| RC26 | Analytics CSP diagnostics and typed site-ownership proof contract. See [Admin](admin.md) and [SEO](seo.md). |
| RC27 | Dedicated ownership tab/provider flow, network-rule removal/save permissions and Metrica checker CSP; canonical installer Registry default and live theme-recovery clarification. See [SEO](seo.md), [Operations](operations.md), and [Themes](themes.md). |

The baseline workflow minimum remains `>=1.0.0-rc.19 <2.0.0-0`; it is not a claim that RC19 is current. RichText generations before rc.18 and internal 0.1.x are outside this workflow. SemVer prerelease matching must use the actual Core resolver: same-tuple later RCs and stable 1.x may satisfy that range, while 2.x and unrelated future minor prereleases do not automatically qualify.
<!-- cms-history:end -->

The current public documentation was checked against public Core source commit `4e40feafaaff9d08d228d906d4b4e1b5bb77e0b9`. The source commit and this documentation commit are separate pins. The managed release block above carries the current product version. This records source and document review; it does not claim live-site or vendor acceptance. Preserve the bounded history and compatibility minimums when preparing another release.

Check actual ranges, migrations and rollback policy before an operation. See [Skills](agent-skills.md) and [release inclusion](release-copy.md).

[Documentation index](index.md)
