// An independent author fixture: imports only the public SDK.
import type { AdminContributionApi, ExtensionContribution } from "@pcms/extensions";

export function contribution(ready: (api: AdminContributionApi) => void): ExtensionContribution {
  return { extensionId: "example.admin-client", register: ready };
}

export async function editNavigation(api: AdminContributionApi): Promise<string> {
  await api.request("GET", "/actor");
  const set = await api.request<{ set_id: string }>("POST", "/navigation/sets", {
    body: { key: "extension-test", title: "Extension" },
  });
  const item = await api.request<{ item_id: string }>(
    "POST",
    `/navigation/sets/${set.set_id}/items`,
    {
      body: { type: "group", label: "Before" },
    },
  );
  await api.request("PATCH", `/navigation/sets/${set.set_id}/items/${item.item_id}`, {
    body: { type: "group", label: "After" },
  });
  const read = await api.request<{ items: { label: string }[] }>(
    "GET",
    `/discovery/navigation/trees/${set.set_id}`,
  );
  await api.request("DELETE", `/navigation/sets/${set.set_id}`);
  return read.items[0]?.label ?? "";
}
