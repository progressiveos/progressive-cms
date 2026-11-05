import type { FastifyInstance } from "fastify";

export function registerExtensionFormParser(fastify: FastifyInstance): void {
  fastify.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer", bodyLimit: 65_536 },
    (_request, body, done) => {
      try {
        const raw = new TextDecoder("utf-8", { fatal: true }).decode(body as Buffer);
        const result: Record<string, string> = Object.create(null) as Record<string, string>;
        const fields = raw === "" ? [] : raw.split("&");
        if (fields.length > 100) throw new Error("too many fields");
        for (const field of fields) {
          const equals = field.indexOf("=");
          const decode = (value: string) => decodeURIComponent(value.replace(/\+/g, " "));
          const name = decode(equals < 0 ? field : field.slice(0, equals));
          const value = decode(equals < 0 ? "" : field.slice(equals + 1));
          if (
            name.length === 0 ||
            Buffer.byteLength(name) > 128 ||
            Buffer.byteLength(value) > 8192 ||
            [...name].some(
              (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
            ) ||
            name
              .split(/[.[\]]/)
              .some((part) => ["__proto__", "prototype", "constructor"].includes(part)) ||
            Object.hasOwn(result, name)
          )
            throw new Error("invalid form field");
          result[name] = value;
        }
        done(null, result);
      } catch {
        done(Object.assign(new Error("Invalid form body"), { statusCode: 400 }), undefined);
      }
    },
  );
}
