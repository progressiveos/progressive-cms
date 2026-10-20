// Community skills admin API (Community Skills plan §4): list/install/
// disable/enable/uninstall over /skills, session + CSRF via the shared
// client. The sample package download is a plain link (session cookie).
import { apiDelete, apiGet, apiPost, apiRequest } from "./client.js";

export interface SkillListItem {
  readonly id: string;
  readonly version: string;
  readonly origin: "first-party" | "community";
  readonly enabled: boolean;
  readonly attribution: {
    readonly author: string;
    readonly homepage?: string;
    readonly source?: string;
  } | null;
}

export interface SkillsList {
  readonly items: readonly SkillListItem[];
  readonly community_enabled: boolean;
  readonly can_manage: boolean;
}

export const fetchSkills = (): Promise<SkillsList> => apiGet<SkillsList>("/skills");

export function installSkillUrl(url: string): Promise<{ id: string; version: string }> {
  return apiPost<{ id: string; version: string }>("/skills/install", { url });
}

export function installSkillFile(file: File): Promise<{ id: string; version: string }> {
  return apiRequest<{ id: string; version: string }>("POST", "/skills/install", {
    rawBody: file,
    headers: { "content-type": "application/octet-stream" },
  });
}

export const disableSkill = (id: string): Promise<{ id: string; disabled: boolean }> =>
  apiPost<{ id: string; disabled: boolean }>(`/skills/${encodeURIComponent(id)}/disable`);

export const enableSkill = (id: string): Promise<{ id: string; disabled: boolean }> =>
  apiPost<{ id: string; disabled: boolean }>(`/skills/${encodeURIComponent(id)}/enable`);

export const uninstallSkill = (id: string): Promise<{ id: string; uninstalled: boolean }> =>
  apiDelete<{ id: string; uninstalled: boolean }>(`/skills/${encodeURIComponent(id)}`);
