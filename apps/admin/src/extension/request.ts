import type { AdminRequestOptions } from "@pcms/extensions";
import { ApiError, apiRequest } from "../api/client.js";
import { t } from "../i18n/index.js";

/** Trusted contributions share the host client, never its auth state. */
export async function requestExtensionApi<T>(
  method: string,
  path: string,
  options?: AdminRequestOptions,
): Promise<T> {
  const pathname = path.split("?", 1)[0] ?? "";
  let decodedPathname = "";
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    /* malformed URI */
  }
  if (
    !pathname.startsWith("/") ||
    !decodedPathname.startsWith("/") ||
    pathname.includes("//") ||
    /[\p{Cc}\s\\#]/u.test(path) ||
    /%(?:2f|5c)/i.test(pathname) ||
    new URL(`/api/v1${path}`, "https://pcms.invalid").pathname !== `/api/v1${pathname}` ||
    // Session changes would desynchronize the host's cookie and CSRF state.
    decodedPathname === "/auth" ||
    decodedPathname.startsWith("/auth/") ||
    Object.keys(options?.headers ?? {}).some((name) =>
      ["cookie", "authorization", "x-pcms-csrf"].includes(name.toLowerCase()),
    )
  ) {
    throw new ApiError({
      code: "API_REQUEST_INVALID",
      status: 0,
      message: t("extensions.api_request_invalid"),
    });
  }
  return apiRequest<T>(method.toUpperCase(), path, { ...options, redirect: "error" });
}
