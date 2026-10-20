// First-party connector set v1 (Integrations spec §7): Email, Telegram,
// Nextcloud Talk, Generic HTTP/Webhook, Progressive HQ. Definitions register
// into the connector registry; runtimes register into a
// ConnectorRuntimeRegistry with the process transports (guarded HTTP client,
// mail transport).

import { amocrmConnectorDefinition } from "./amocrm.js";
import { bitrix24ConnectorDefinition } from "./bitrix24.js";
import type { ConnectorRegistry } from "./connectors.js";
import { emailConnectorDefinition } from "./email.js";
import { hubspotConnectorDefinition } from "./hubspot.js";
import { pipedriveConnectorDefinition } from "./pipedrive.js";
import { progressiveHqConnectorDefinition } from "./progressive-hq.js";
import { salesforceConnectorDefinition } from "./salesforce.js";
import { sharecrmConnectorDefinition } from "./sharecrm.js";
import { talkConnectorDefinition } from "./talk.js";
import { telegramConnectorDefinition } from "./telegram.js";
import { webhookConnectorDefinition } from "./webhook.js";
import { zohoCrmConnectorDefinition } from "./zoho-crm.js";

export function registerFirstPartyConnectorDefinitionsV1(registry: ConnectorRegistry): void {
  registry.register(emailConnectorDefinition);
  registry.register(telegramConnectorDefinition);
  registry.register(talkConnectorDefinition);
  registry.register(webhookConnectorDefinition);
  registry.register(progressiveHqConnectorDefinition);
  registry.register(bitrix24ConnectorDefinition);
  registry.register(amocrmConnectorDefinition);
  registry.register(hubspotConnectorDefinition);
  registry.register(pipedriveConnectorDefinition);
  registry.register(zohoCrmConnectorDefinition);
  registry.register(sharecrmConnectorDefinition);
  registry.register(salesforceConnectorDefinition);
}
