/** Rewrite only URL attributes of actual tags. Raw script/style text and all
 * other bytes remain intact, preserving inline CSP hashes and asset SRI. */
export function pinThemeAssetUrls(
  html: string,
  input: { themeId: string; revisionId: string; origin?: string | null },
): string {
  const prefix = `/themes/${input.themeId}/assets/`;
  const versioned = `/themes/${input.themeId}/revisions/${input.revisionId}/assets/`;
  const pin = (url: string) =>
    url.startsWith(prefix)
      ? `${versioned}${url.slice(prefix.length)}`
      : input.origin && url.startsWith(`${input.origin}${prefix}`)
        ? `${input.origin}${versioned}${url.slice(input.origin.length + prefix.length)}`
        : url;
  const attrs = (tag: string) =>
    tag.replace(
      /(\s)([^\s"'<>/=]+)(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
      (
        all,
        space: string,
        name: string,
        equals: string,
        quoted: string,
        double: string | undefined,
        single: string | undefined,
        unquoted: string | undefined,
      ) => {
        if (!/^(src|href|poster|srcset)$/i.test(name)) return all;
        const value = double ?? single ?? unquoted ?? "";
        const next =
          name.toLowerCase() === "srcset"
            ? value.replace(
                /(^|,)(\s*)(\S+)/g,
                (_match, comma: string, white: string, url: string) =>
                  `${comma}${white}${pin(url)}`,
              )
            : pin(value);
        return `${space}${name}${equals}${quoted[0] === '"' ? `"${next}"` : quoted[0] === "'" ? `'${next}'` : next}`;
      },
    );
  let result = "";
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) {
      result += html.slice(cursor);
      break;
    }
    result += html.slice(cursor, start);
    if (html.startsWith("<!--", start)) {
      const close = html.indexOf("-->", start + 4);
      if (close < 0) {
        result += html.slice(start);
        break;
      }
      result += html.slice(start, close + 3);
      cursor = close + 3;
      continue;
    }
    let end = start + 1;
    let quote = "";
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (end === html.length) {
      result += html.slice(start);
      break;
    }
    const tag = html.slice(start, end + 1);
    result += attrs(tag);
    cursor = end + 1;
    const raw = /^<(script|style|textarea|title)\b/i.exec(tag);
    if (raw) {
      const close = new RegExp(`</${raw[1]}\\s*>`, "gi");
      close.lastIndex = cursor;
      const match = close.exec(html);
      if (!match) {
        result += html.slice(cursor);
        break;
      }
      result += html.slice(cursor, match.index + match[0].length);
      cursor = match.index + match[0].length;
    }
  }
  return result;
}
