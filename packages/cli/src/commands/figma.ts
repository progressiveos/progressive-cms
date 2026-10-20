// `cms figma pull` — Figma design → design-reference pack (theme developer
// workflow). REST API + Personal Access Token (FIGMA_TOKEN env). The official
// Figma "Dev Mode MCP" is a local server inside the desktop app — unusable on
// a server agent; this REST path is what the MCP wrappers wrap anyway.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractDesignTokens,
  type FigmaFile,
  figmaTokensToCss,
  frameIdsOf,
  parseFigmaUrl,
} from "@pcms/themes";
import { type CliCommandResult, failureResult, type GlobalOptions } from "../framework.js";

const USAGE = `usage: cms figma pull --url <figma-design-url> [--out-dir <dir>] [--frames <max>]
Token: FIGMA_TOKEN env (Figma personal access token, never argv).
Output: tokens.css (palette+typography draft), frames/*.png, report.json.`;

export async function figmaCommand(invocation: {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CliCommandResult> {
  const { args, options, env } = invocation;
  try {
    if (args[0] !== "pull") return { exitCode: 2, stdout: "", stderr: USAGE };
    const flag = (name: string): string | undefined => {
      const at = args.indexOf(name);
      return at >= 0 ? args[at + 1] : undefined;
    };
    const url = flag("--url");
    const outDir = flag("--out-dir") ?? "./figma-out";
    const maxFrames = Number(flag("--frames") ?? 12);
    const token = env["FIGMA_TOKEN"] ?? "";
    if (url === undefined) return { exitCode: 2, stdout: "", stderr: USAGE };
    if (token === "") {
      return {
        exitCode: 3,
        stdout: "",
        stderr: "set FIGMA_TOKEN (Figma personal access token)\\n",
      };
    }
    const { fileKey, nodeId } = parseFigmaUrl(url);
    const headers = { "X-Figma-Token": token };

    const fileResponse = await fetch(`https://api.figma.com/v1/files/${fileKey}`, { headers });
    if (!fileResponse.ok) {
      const hint = fileResponse.status === 403 ? " (bad token or no access to the file)" : "";
      throw new Error(`figma file HTTP ${fileResponse.status}${hint}`);
    }
    const file = (await fileResponse.json()) as FigmaFile;
    const tokens = extractDesignTokens(file, nodeId);
    const frames = frameIdsOf(file, nodeId).slice(0, maxFrames);

    mkdirSync(join(outDir, "frames"), { recursive: true });
    writeFileSync(join(outDir, "tokens.css"), figmaTokensToCss(tokens));

    let rendered = 0;
    if (frames.length > 0) {
      const ids = frames.map((frame) => frame.id).join(",");
      const imagesResponse = await fetch(
        `https://api.figma.com/v1/images/${fileKey}?ids=${ids}&format=png&scale=2`,
        { headers },
      );
      if (imagesResponse.ok) {
        const images = (await imagesResponse.json()) as {
          images?: Record<string, string | null>;
        };
        for (const [index, frame] of frames.entries()) {
          const imageUrl = images.images?.[frame.id];
          if (imageUrl === undefined || imageUrl === null) continue;
          const png = await fetch(imageUrl);
          if (!png.ok) continue;
          const safeName =
            frame.name.replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || `frame-${index + 1}`;
          writeFileSync(
            join(outDir, "frames", `${safeName}.png`),
            Buffer.from(await png.arrayBuffer()),
          );
          rendered += 1;
        }
      }
    }

    const report = {
      file: file.name,
      last_modified: file.lastModified,
      node: nodeId,
      palette: tokens.palette,
      typography: tokens.typography,
      components: tokens.components,
      frames_rendered: rendered,
      next_steps: [
        "map tokens.css onto the theme tokens (theme.json / --pcms-* variables)",
        "use frames/*.png as the design reference while building the theme",
      ],
    };
    writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 1));
    return { exitCode: 0, stdout: JSON.stringify(report, null, 1) + "\n", stderr: "" };
  } catch (error) {
    return failureResult(error, options);
  }
}
