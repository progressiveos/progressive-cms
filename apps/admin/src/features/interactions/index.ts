// Interactions extension registration (PCMS-FORM-T022). Imported for its
// side effect from the app entry: registers the nav section and the lazy
// workspace routes through the M10 extension registries.
import { registerNavSection, registerRoute } from "../../extension/registry.js";

registerNavSection({
  id: "interactions",
  title: "nav_interactions",
  items: [
    {
      id: "interactions-privacy",
      title: "privacy.title",
      path: "interactions/privacy",
      permission: "privacy.manage",
      order: 60,
    },
    {
      id: "interactions-forms",
      title: "nav_forms",
      path: "interactions/forms",
      permission: "forms.read_definition",
      order: 10,
    },
    {
      id: "interactions-quizzes",
      title: "nav_quizzes",
      path: "interactions/quizzes",
      permission: "quizzes.read_definition",
      order: 20,
    },
    {
      id: "interactions-submissions",
      title: "nav_submissions",
      path: "interactions/submissions",
      permission: "interactions.read",
      order: 30,
    },
    {
      id: "interactions-quiz-runs",
      title: "nav_quiz_runs",
      path: "interactions/quiz-runs",
      permission: "interactions.read",
      order: 40,
    },
    {
      id: "interactions-leads",
      title: "nav_leads",
      path: "interactions/leads",
      permission: "leads.read",
      order: 50,
    },
  ],
});

registerRoute({
  pattern: "interactions",
  title: "nav_interactions",
  permission: "forms.read_definition",
  load: () =>
    import("./screens.js").then(({ AdminInteractionsHome }) => ({
      default: AdminInteractionsHome,
    })),
});
registerRoute({
  pattern: "interactions/forms",
  title: "nav_forms",
  permission: "forms.read_definition",
  load: () =>
    import("./screens.js").then(({ AdminFormsScreen }) => ({ default: AdminFormsScreen })),
});
registerRoute({
  pattern: "interactions/quizzes",
  title: "nav_quizzes",
  permission: "quizzes.read_definition",
  load: () =>
    import("./screens.js").then(({ AdminQuizzesScreen }) => ({ default: AdminQuizzesScreen })),
});
registerRoute({
  pattern: "interactions/forms/:formId",
  title: "nav_forms",
  permission: "forms.read_definition",
  load: () =>
    import("./screens.js").then(({ AdminFormEditorScreen }) => ({
      default: AdminFormEditorScreen,
    })),
});
registerRoute({
  pattern: "interactions/quizzes/:quizId",
  title: "nav_quizzes",
  permission: "quizzes.read_definition",
  load: () =>
    import("./screens.js").then(({ AdminQuizEditorScreen }) => ({
      default: AdminQuizEditorScreen,
    })),
});
registerRoute({
  pattern: "interactions/submissions",
  title: "nav_submissions",
  permission: "interactions.read",
  load: () =>
    import("./screens.js").then(({ AdminSubmissionsScreen }) => ({
      default: AdminSubmissionsScreen,
    })),
});
registerRoute({
  pattern: "interactions/quiz-runs",
  title: "nav_quiz_runs",
  permission: "interactions.read",
  load: () =>
    import("./screens.js").then(({ AdminQuizRunsScreen }) => ({ default: AdminQuizRunsScreen })),
});
registerRoute({
  pattern: "interactions/leads",
  title: "nav_leads",
  permission: "leads.read",
  load: () =>
    import("./screens.js").then(({ AdminLeadsScreen }) => ({ default: AdminLeadsScreen })),
});

registerRoute({
  pattern: "interactions/privacy",
  title: "privacy.title",
  permission: "privacy.manage",
  load: () =>
    import("./privacy.js").then(({ AdminPrivacyScreen }) => ({ default: AdminPrivacyScreen })),
});
