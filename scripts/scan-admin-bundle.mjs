#!/usr/bin/env node
// Production Admin bundle secret scan (PCMS-ADMIN-T001; owner instructions:
// "Browser secrets — строго отсутствуют"). Fails `npm run check` when the
// built bundle under apps/admin/dist contains secret-shaped material:
// DB credentials, service-token material, secret-ref values, TOTP/preview
// signing keys, private keys, or credential-bearing URLs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIST = join(process.cwd(), "apps/admin/dist");
if (!existsSync(join(DIST, "index.html"))) {
  console.error(
    "scan-admin-bundle: apps/admin/dist/index.html is missing (run npm run build:admin)",
  );
  process.exit(1);
}

const PATTERNS = [
  { name: "database connection URL", re: /postgres(ql)?:\/\/[^\s"'<>]*:[^\s"'<>@]*@/i },
  { name: "service token literal", re: /pcms_[0-9a-f]{8}_[A-Za-z0-9_-]{20,}/ },
  { name: "secret env reference value", re: /PCMS_SECRET_[A-Z0-9_]+=/ },
  { name: "TOTP encryption key material", re: /totpEncryptionKey"\s*:\s*"[^"]{8,}"/ },
  { name: "preview signing secret material", re: /previewSecret"\s*:\s*"[^"]{8,}"/ },
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: "bearer token assignment",
    re: /Authorization['"]?\s*[:,]\s*['"]?Bearer\s+[A-Za-z0-9._-]{16,}/,
  },
  { name: "password assignment literal", re: /password['"]?\s*:\s*['"][^'"]{8,}['"]/i },
];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

let scanned = 0;
const findings = [];
for (const file of walk(DIST)) {
  const text = readFileSync(file, "utf8");
  scanned += 1;
  for (const pattern of PATTERNS) {
    const match = text.match(pattern.re);
    if (match !== null) {
      findings.push(
        `${pattern.name} in ${file.replace(`${process.cwd()}/`, "")}: ${match[0].slice(0, 40)}…`,
      );
    }
  }
}

if (findings.length > 0) {
  console.error("scan-admin-bundle: secret-shaped material found in the Admin bundle:");
  for (const finding of findings) console.error(`  - ${finding}`);
  process.exit(1);
}
console.log(`scan-admin-bundle: ${scanned} files scanned, no secret-shaped material`);
