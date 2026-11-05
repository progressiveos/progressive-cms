const SAFE_MARKDOWN_BRAND = Symbol("pcms.safe-markdown");

export interface SafeMarkdown {
  readonly [SAFE_MARKDOWN_BRAND]: true;
  readonly markdown: string;
}

export function safeMarkdown(markdown: string): SafeMarkdown {
  return { [SAFE_MARKDOWN_BRAND]: true, markdown };
}

export function isSafeMarkdown(value: unknown): value is SafeMarkdown {
  return (
    typeof value === "object" &&
    value !== null &&
    SAFE_MARKDOWN_BRAND in value &&
    (value as SafeMarkdown)[SAFE_MARKDOWN_BRAND] === true &&
    typeof (value as SafeMarkdown).markdown === "string"
  );
}
