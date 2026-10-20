// @pcms/payments — Payment bounded context (M13; ADR-0005). Payment is
// domain state with a provider-neutral adapter contract; refund is
// privileged; callbacks are verified and deduplicated. L1 subsystem:
// imports @pcms/core only.
export const PACKAGE_NAME = "@pcms/payments";
export { PAYMENT_ERROR_CODES, PaymentError, type PaymentErrorCode } from "./errors.js";
// FakePaymentProvider stays a CORE test fixture (ADR-0017 S5). Concrete
// provider adapters are trusted extension packages
// (progressive-payments.*) composed through the catalog's payment_provider
// registrations — this public index exports NONE of them.
export { FakePaymentProvider } from "./fake-provider.js";
export {
  type CreatePaymentInput,
  createPaymentService,
  type Payment,
  type PaymentActor,
  type PaymentEvent,
  type PaymentService,
} from "./payments.js";
export {
  createPaymentProviderInstanceService,
  type PaymentProviderInstance,
  type PaymentProviderInstanceService,
} from "./provider-instances.js";
export {
  type InboundRequestView,
  type NormalizedProviderOutcome,
  type ParsedCallback,
  type PaymentProvider,
  type PaymentProviderCapabilities,
  PaymentProviderRegistry,
  type PaymentSecrets,
  type ProviderCreateInput,
  type ProviderCreateResult,
} from "./providers.js";
export { validateAgainstSchema } from "./schema.js";
export {
  assertTransition,
  canTransition,
  isAllowedSubjectType,
  PAYMENT_EVENT_TYPES,
  PAYMENT_STATUSES,
  PAYMENT_SUBJECT_TYPES,
  PAYMENT_TRANSITIONS,
  type PaymentEventType,
  type PaymentStatus,
  statusChangeEvent,
} from "./state.js";
