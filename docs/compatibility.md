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
| Introduction | Contract / evidence | Reviewed Core source |
|---|---|---|
| RC16 / RC18 | RichText v2 introduced / runtime became v2-only; retained historical compatibility boundary | Earlier accepted content contract |
| RC19 | Content/body-policy corrections, breadcrumbs and social-image inheritance; minimum for the supplied authoring workflows | Accepted Content Contract; baseline PostgreSQL 18.6 handoff evidence |
| Extension/Payments delta | Public extension and payment contracts | `88bbb3fedba9caf4d90d548d52ddd4889936df0b` |
| RC24 | Trusted Admin HTTP client | `8b426ba8088b91a6407da5aabaa9f78cc7c5222c` |
| RC25 | Periodic jobs, lifecycle obligations, update ordering and Admin screen continuity | `3a94b1f1e39419bfd717b603349dcb9e1778f01e` |
| RC26 | Analytics CSP diagnostics and typed site-ownership proof contract | `b5d59871b0aed1b64c5a2802666e33eedce0e1a5` |
| RC27 | Dedicated ownership tab/provider flow, network-rule removal/save permissions and Metrica checker CSP; canonical installer Registry default and live theme-recovery clarification | `8b0e659c091ae6107ccb8319dabdf3531501e86f`, `a50653f69ce7d4710d0035117f071d47c279ca58`, then `0731b0756cf2f3b202e9f17d3d95b59d5c05aa93` |

The baseline workflow minimum remains `>=1.0.0-rc.19 <2.0.0-0`; it is not a claim that RC19 is current. RichText generations before rc.18 and internal 0.1.x are outside this workflow. SemVer prerelease matching must use the actual Core resolver: same-tuple later RCs and stable 1.x may satisfy that range, while 2.x and unrelated future minor prereleases do not automatically qualify.
<!-- cms-history:end -->

The latest content review pin is `7740f9741fe6994b7e5a9b0822727cd792957e05`: owner-selected analytics consent lifecycle, archived-definition retention and addressed personal-data tools; includes the previously accepted theme-history cleanup and interface corrections. This is a source review, not a new product release announcement. Release preparation refreshes the current product label; it does not claim a new source-contract review or installed/vendor acceptance. Preserve the history and compatibility minimums when preparing another release.

Check actual ranges, migrations and rollback policy before an operation. See [Skills](agent-skills.md) and [release inclusion](release-copy.md).

[Documentation index](index.md)
