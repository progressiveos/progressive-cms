// Component include/render contract (PCMS-THEME-T007; Theme Contract spec §16).
//
// Components are reusable presentation units with stable logical IDs declared
// in the manifest. Resolution is deterministic: manifest `id` → `file`, and
// duplicate IDs are already rejected by manifest validation (PCMS-THEME-T002).
// A component renders two equivalent ways, both resolving to the same file in
// the snapshot:
//   1. registry render: `renderComponent("button", scope)` (application layer);
//   2. inline include from any template: `{% include 'components/button.liquid' %}`.
import { ThemeError } from "../errors.js";
import type { ThemeManifest } from "../manifest/schema.js";
import type { RenderContext, RenderService } from "./render-service.js";

export interface ComponentDescriptor {
  readonly id: string;
  readonly file: string;
}

export interface ComponentRegistry {
  /** Deterministic (sorted by ID) component listing. */
  listComponents(): readonly ComponentDescriptor[];
  getComponentFile(id: string): string | null;
  /**
   * Renders a component by logical ID. Scope is plain data only — component
   * templates run under the same autoescape/sandbox rules as page templates.
   */
  renderComponent(
    id: string,
    scope: Readonly<Record<string, unknown>>,
    context?: RenderContext,
  ): Promise<string>;
}

export function createComponentRegistry(
  manifest: ThemeManifest,
  render: Pick<RenderService, "renderComponent">,
): ComponentRegistry {
  const byId = new Map(manifest.components.map((c) => [c.id, c.file]));
  return {
    listComponents() {
      return [...byId.entries()]
        .map(([id, file]) => ({ id, file }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
    getComponentFile(id) {
      return byId.get(id) ?? null;
    },
    async renderComponent(id, scope, context = {}) {
      const file = byId.get(id);
      if (file === undefined) {
        throw new ThemeError("THEME_COMPONENT_NOT_FOUND", `unknown component: ${id}`, {
          details: { id, kind: "component", ...context },
        });
      }
      return render.renderComponent(file, scope, { ...context, componentId: id });
    },
  };
}
