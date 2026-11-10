// Human labels for payment provider slots (CORE-PAYMENTS-ADMIN-CONFIG-01 §6).
// Machine keys are NEVER the only text a person reads: every shipped provider
// slot and config key has a label, and the credential slots explain where the
// value comes from. Hints stay generic on purpose — they point at the provider
// cabinet, they do not invent API details this repository cannot verify.
import type { FieldMeta } from "../../design/schema-form.js";
import { t } from "../../i18n/index.js";

interface SlotMeta {
  /** i18n key of the human label. */
  readonly labelKey: string;
  /** i18n key of the "where to get it / what it is" hint. */
  readonly hintKey?: string;
  readonly advanced?: boolean;
}

const COMMON: Readonly<Record<string, SlotMeta>> = {
  "*.apiBase": {
    labelKey: "payments.field_api_base",
    hintKey: "payments.hint_api_base",
    advanced: true,
  },
  "*.gatewayUrl": {
    labelKey: "payments.field_gateway_url",
    hintKey: "payments.hint_api_base",
    advanced: true,
  },
};

const BY_TYPE: Readonly<Record<string, Readonly<Record<string, SlotMeta>>>> = {
  yookassa: {
    shopId: {
      labelKey: "payments.field_yookassa_shop_id",
      hintKey: "payments.hint_yookassa_shop_id",
    },
    secretKey: {
      labelKey: "payments.field_yookassa_secret_key",
      hintKey: "payments.hint_yookassa_secret_key",
    },
    "*.apiBase": {
      labelKey: "payments.field_api_base",
      hintKey: "payments.hint_api_base",
      advanced: true,
    },
    allowedIps: {
      labelKey: "payments.field_yookassa_allowed_ips",
      hintKey: "payments.hint_yookassa_allowed_ips",
      advanced: true,
    },
  },
  tbank: {
    terminalKey: {
      labelKey: "payments.field_tbank_terminal",
      hintKey: "payments.hint_tbank_terminal",
    },
    password: {
      labelKey: "payments.field_tbank_password",
      hintKey: "payments.hint_tbank_password",
    },
    "*.apiBase": {
      labelKey: "payments.field_api_base",
      hintKey: "payments.hint_api_base",
      advanced: true,
    },
  },
  stripe: {
    secretKey: { labelKey: "payments.field_stripe_secret", hintKey: "payments.hint_stripe_secret" },
    webhookSecret: {
      labelKey: "payments.field_stripe_webhook",
      hintKey: "payments.hint_stripe_webhook",
    },
    "*.apiBase": {
      labelKey: "payments.field_api_base",
      hintKey: "payments.hint_api_base",
      advanced: true,
    },
    webhookToleranceSeconds: {
      labelKey: "payments.field_stripe_tolerance",
      hintKey: "payments.hint_stripe_tolerance",
      advanced: true,
    },
  },
  paypal: {
    clientId: {
      labelKey: "payments.field_paypal_client_id",
      hintKey: "payments.hint_paypal_client_id",
    },
    clientSecret: {
      labelKey: "payments.field_paypal_client_secret",
      hintKey: "payments.hint_paypal_client_secret",
    },
    webhookId: {
      labelKey: "payments.field_paypal_webhook",
      hintKey: "payments.hint_paypal_webhook",
    },
    "*.apiBase": {
      labelKey: "payments.field_api_base",
      hintKey: "payments.hint_api_base",
      advanced: true,
    },
  },
  alipay: {
    appId: { labelKey: "payments.field_alipay_app_id", hintKey: "payments.hint_alipay_app_id" },
    privateKey: {
      labelKey: "payments.field_alipay_private",
      hintKey: "payments.hint_alipay_private",
    },
    // Required to verify callbacks, therefore part of the main path, not the
    // collapsed advanced block (review R6).
    alipayPublicKey: {
      labelKey: "payments.field_alipay_public",
      hintKey: "payments.hint_alipay_public",
    },
    "*.gatewayUrl": {
      labelKey: "payments.field_gateway_url",
      hintKey: "payments.hint_api_base",
      advanced: true,
    },
  },
  tabby: {
    merchantCode: {
      labelKey: "payments.field_tabby_merchant",
      hintKey: "payments.hint_tabby_merchant",
    },
    secretKey: { labelKey: "payments.field_tabby_secret", hintKey: "payments.hint_tabby_secret" },
    webhookSecret: {
      labelKey: "payments.field_tabby_webhook",
      hintKey: "payments.hint_tabby_webhook",
    },
    "*.apiBase": {
      labelKey: "payments.field_api_base",
      hintKey: "payments.hint_api_base",
      advanced: true,
    },
    signatureHeader: {
      labelKey: "payments.field_tabby_signature_header",
      hintKey: "payments.hint_tabby_signature_header",
      advanced: true,
    },
  },
};

function lookup(providerType: string, key: string): SlotMeta | undefined {
  const scoped = BY_TYPE[providerType]?.[key];
  if (scoped !== undefined) return scoped;
  const scopedWildcard = BY_TYPE[providerType]?.[`*.${key}`];
  if (scopedWildcard !== undefined) return scopedWildcard;
  return COMMON[`*.${key}`];
}

/** Resolved label/hint for one field of one provider. */
export function providerFieldMeta(providerType: string, key: string): FieldMeta {
  const meta = lookup(providerType, key);
  if (meta === undefined) return { label: key };
  return {
    label: t(meta.labelKey),
    ...(meta.hintKey === undefined ? {} : { hint: t(meta.hintKey) }),
  };
}

/** Config keys shown in the collapsed "advanced" block. */
export function providerAdvancedKeys(
  providerType: string,
  keys: readonly string[],
): readonly string[] {
  return keys.filter((key) => {
    const meta = lookup(providerType, key);
    if (meta === undefined) return true; // unknown key → advanced, not the main path
    return meta.advanced === true;
  });
}

/** PEM-valued credentials get a multi-line editor. */
export function isPemSlot(slot: string): boolean {
  return /privateKey|publicKey|PEM/i.test(slot);
}
