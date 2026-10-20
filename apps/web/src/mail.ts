// Mail surface composition (PCMS-OPS-T110) — moved to @pcms/integrations
// (0.1.194) so the worker builds the SAME transport: integration email
// deliveries and notification mail run there and previously had none.
// Re-exports keep the web composition stable.
export {
  applyManagedMailSettings,
  buildMailSurface,
  type MailSurface,
} from "@pcms/integrations";
