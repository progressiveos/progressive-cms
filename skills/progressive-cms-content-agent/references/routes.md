# Content Agent — Route safety (PCMS-SKILL-T004)

## Read before mutation

- The route of an entry is part of its public identity. Always read it
  first: `GET /entries/:entryId/route`; check availability for a proposed
  path with `GET /discovery/routing/check` (MCP: `cms_check_route_available`)
  before proposing it.
- **Title edit ≠ route edit.** Changing a title never justifies changing the
  route of an already-published entry. New entries may propose a route;
  slug policy is the site's, not the agent's invention.

## Published canonical changes are high-risk

- Changing the route of a published entry requires explicit
  `publication.publish`-class authority **and** an explicit task statement.
  Route moves go through changeset items with `route_operation` (declare
  `frees_path` where the move releases the old path).
- Redirect/canonical impact must be visible before apply: prefer a changeset
  preflight, which runs the routing validator over conflicts and freed
  paths. A conflict is never "forced through" — pick a free path or stop.

## Conflicts

- `ROUTE_CONFLICT` / stale-route results: re-check availability with the
  current tree, choose a different path, and surface the decision in the
  report. Never guess suffixes ("-2", "-copy") without saying so.
- Internal links, navigation and related-content references use **Entry
  IDs**, never hardcoded URLs — a route move then cannot break the site.
- Domain/DNS/TLS and reverse-proxy concerns are operator work: if discovery
  shows a missing primary domain binding, stop and report; do not try to
  fix public routing from a content task.
