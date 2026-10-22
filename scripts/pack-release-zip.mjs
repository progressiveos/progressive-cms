import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** Packs the staged release directory into the product-wide zip artifact
 * (top-level <releaseId>/ prefix — same layout the tar.gz used to have). */
export async function packReleaseZip(outRoot, releaseId, artifactPath) {
  const { readdirSync, createWriteStream } = await import("node:fs");
  const yazl = (await import("yazl")).default;
  const zip = new yazl.ZipFile();
  const { lstatSync, realpathSync } = await import("node:fs");
  const visited = new Set();
  const addFile = (path, name) => {
    const mode = lstatSync(path).mode & 0o111 ? 0o100755 : 0o100644;
    zip.addFile(path, name, { mode });
  };
  const addDir = (absolute, relative) => {
    zip.addEmptyDirectory(`${releaseId}/${relative}`, { mode: 0o40755 });
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const childAbsolute = join(absolute, entry.name);
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const entryName = `${releaseId}/${childRelative}`;
      if (entry.isSymbolicLink()) {
        // Workspace links (node_modules/@pcms/* → ../../packages/*) resolve
        // inside the tree; file links are followed as files (cycle-guarded).
        const real = realpathSync(childAbsolute);
        if (visited.has(real)) continue;
        if (lstatSync(real).isDirectory()) {
          visited.add(real);
          addDir(real, childRelative);
        } else {
          addFile(real, entryName);
        }
        continue;
      }
      if (entry.isDirectory()) {
        addDir(childAbsolute, childRelative);
      } else {
        addFile(childAbsolute, entryName);
      }
    }
  };
  addDir(join(outRoot, releaseId), "");
  zip.end();
  await new Promise((resolve, reject) => {
    zip.outputStream
      .pipe(createWriteStream(artifactPath))
      .on("finish", resolve)
      .on("error", reject);
  });
}

export function assertReleaseZipPermissions(artifactPath) {
  const listing = spawnSync("zipinfo", ["-l", artifactPath], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (listing.status !== 0) throw new Error(`cannot inspect ZIP permissions: ${listing.stderr}`);
  const rows = listing.stdout.split("\n").filter((line) => /^[d-][rwxstST-]{9}\s/.test(line));
  const expected = listing.stdout.match(/number of entries: (\d+)/);
  if (!expected || rows.length !== Number(expected[1]))
    throw new Error("ZIP permission inventory is incomplete");
  const invalid = rows.filter((line) => !/^(?:drwxr-xr-x|-rw-r--r--|-rwxr-xr-x)\s/.test(line));
  if (invalid.length)
    throw new Error(`release ZIP has unsafe runtime permissions:\n${invalid.join("\n")}`);
}
