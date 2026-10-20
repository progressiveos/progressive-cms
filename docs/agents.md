# MCP and Agents

Contract owner: Core MCP and auth.

The [complete MCP map](mcp-map.md) lists all built-in tools, exact argument schemas, result mappings, optional extension tools and supported protocol methods.

Begin with `cms agent bootstrap --json`: inspect target identity, actor, permissions, capabilities, contract versions and installed Skills. Follow with the specific discovery contracts needed for the task. Do not infer a site from a token or hostname.

Service accounts use scoped permissions. A Skill recommends scopes but cannot grant them; a broad token is not task authorization. Confirm both permission and user intent before public mutation. MCP tools operate through application services; they are not a direct SQL or shell interface.

The inspected MCP protocol contract is `2024-11-05`. Use tools advertised by the running instance and preserve typed errors. Stop on a missing required contract/capability. See [Agent Skills](agent-skills.md).

## Public REST context and least privilege

For bearer REST requests use `Authorization: Bearer <secret-from-approved-channel>`, `x-pcms-site: <site-key>` and `x-pcms-environment: <environment>`. Do not log header values. The [API operation table](api-reference.md) exposes registered permission names. Use a content/service account with only the task's actions, keeping user/session recovery and lead exports out of normal authoring.

A new Content Type requires schema.propose/apply permissions and the documented reload boundary. A new theme id requires an approved initial activation path; same-id active updates have their own API. These are visible prerequisites, not a reason to grant root or edit SQL. MCP discovery/catalogue must be obtained from the running server; never fabricate a tool because a related REST operation exists.

[Documentation index](index.md)
