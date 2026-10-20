// Extensions extension registration (PCMS-EXT-T019). Imported for its side
// effect from the app entry: registers the nav section and the lazy
// workspace route through the M10 extension registries. Read surface only —
// executable artifacts never arrive through Admin (Extensions spec §5).
import { registerNavSection, registerRoute } from "../../extension/registry.js";

registerNavSection({
  id: "extensions",
  title: "nav_extensions",
  items: [
    {
      id: "extensions-overview",
      title: "nav_extensions",
      path: "extensions",
      permission: "extensions.manage",
      order: 10,
    },
  ],
});

registerRoute({
  pattern: "extensions",
  title: "nav_extensions",
  permission: "extensions.manage",
  load: () =>
    import("../../screens/extensions/ExtensionsScreen.js").then(({ default: Screen }) => ({
      default: Screen,
    })),
});
