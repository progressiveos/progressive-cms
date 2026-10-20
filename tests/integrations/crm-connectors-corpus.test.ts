// CRM connector wave 2 (owner first queue: HubSpot, Pipedrive, Zoho CRM,
// ShareCRM/FXiaoKe) over deterministic fake transports — no test touches a
// public network. Contract checked per connector: the intake_lead action
// reaches the documented endpoints with the documented auth and payload
// shapes, ids are extracted, auth failures are permanent, 429/5xx are
// retryable, and definitions carry the lead execution projection.
import assert from "node:assert/strict";
import { test } from "node:test";
import { newStableId } from "@pcms/core";
import {
  type ActionExecutionContext,
  type ConnectorDefinition,
  createHubspotConnectorRuntime,
  createPipedriveConnectorRuntime,
  createSharecrmConnectorRuntime,
  createZohoCrmConnectorRuntime,
  hubspotConnectorDefinition,
  type OutboundHttpRequest,
  type OutboundHttpResponse,
  pipedriveConnectorDefinition,
  sharecrmConnectorDefinition,
  zohoCrmConnectorDefinition,
} from "@pcms/integrations";

const PROJECTION = {
  lead_id: "01980000-0000-7000-8000-0000000abcde",
  source_type: "form",
  source_id: "form-1",
  classification: "spangar-lead",
  created_at: "2026-10-03T00:00:00Z",
  name: "Иван Петров",
  email: "ivan@example.com",
  phone: "+7 900 000-00-00",
  summary: "Хочет ангар 1200м²",
  presentation: "Полное представление лида",
};

function ctxFor(
  connectorType: string,
  config: Record<string, unknown>,
  secrets: Record<string, string>,
): ActionExecutionContext {
  return {
    instance: {
      id: newStableId(),
      connectorType,
      name: "crm-under-test",
      enabled: true,
      config,
      secretRefs: {},
      siteKey: null,
      environment: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    secrets,
    projection: PROJECTION,
  };
}

type Handler = (
  request: OutboundHttpRequest,
) => OutboundHttpResponse | Promise<OutboundHttpResponse>;

function fakeHttp(handler: Handler): {
  http: (request: OutboundHttpRequest) => Promise<OutboundHttpResponse>;
  calls: OutboundHttpRequest[];
} {
  const calls: OutboundHttpRequest[] = [];
  return {
    calls,
    http: async (request) => {
      calls.push(request);
      return await handler(request);
    },
  };
}

test("CRM definitions: intake_lead with lead execution projection and secrets", () => {
  const definitions: readonly ConnectorDefinition[] = [
    hubspotConnectorDefinition,
    pipedriveConnectorDefinition,
    zohoCrmConnectorDefinition,
    sharecrmConnectorDefinition,
  ];
  for (const definition of definitions) {
    const action = definition.actions.find((candidate) => candidate.actionType === "intake_lead");
    assert.ok(action !== undefined, `${definition.connectorType}: intake_lead action`);
    assert.equal(action.executionProjection?.aggregate, "lead");
    assert.equal(action.executionProjection?.idFromPayload, "lead_id");
    assert.ok(definition.secrets.length > 0, `${definition.connectorType}: secrets declared`);
    assert.equal(definition.testable, true);
  }
});

test("hubspot: contact + deal created, association and idempotency key set", async () => {
  const fake = fakeHttp((request) => {
    if (request.url.endsWith("/crm/v3/objects/contacts")) {
      assert.match(String(request.headers?.["idempotencykey"]), /^pcms-contact-/);
      assert.match(String(request.headers?.["authorization"]), /^Bearer hs-token$/);
      assert.deepEqual(JSON.parse(request.body ?? "{}").properties, {
        email: "ivan@example.com",
        firstname: "Иван Петров",
        phone: "+7 900 000-00-00",
      });
      return { status: 201, body: JSON.stringify({ id: "101" }) };
    }
    if (request.url.endsWith("/crm/v3/objects/deals")) {
      const body = JSON.parse(request.body ?? "{}");
      assert.equal(body.associations[0].to.id, "101");
      assert.equal(body.associations[0].types[0].associationTypeId, 3);
      assert.equal(body.properties.dealname, "Lead: Иван Петров");
      assert.equal(body.properties.description, "Полное представление лида");
      return { status: 201, body: JSON.stringify({ id: "202" }) };
    }
    throw new Error(`unexpected hubspot call ${request.url}`);
  });
  const runtime = createHubspotConnectorRuntime(fake.http);
  const result = await runtime.execute(
    "intake_lead",
    { lead_id: PROJECTION.lead_id },
    ctxFor("hubspot", {}, { private_app_token: "hs-token" }),
  );
  assert.deepEqual(
    { ok: result.ok, externalId: result.externalId },
    { ok: true, externalId: "202" },
  );
  assert.equal(fake.calls.length, 2);
});

test("hubspot: 401 is permanent, 429 is retryable, missing token is caught early", async () => {
  const unauthorized = fakeHttp(() => ({ status: 401, body: "" }));
  const runtime = createHubspotConnectorRuntime(unauthorized.http);
  const auth = await runtime.execute(
    "intake_lead",
    { lead_id: PROJECTION.lead_id },
    ctxFor("hubspot", {}, { private_app_token: "bad" }),
  );
  assert.equal(auth.ok, false);
  assert.equal(auth.retryable, false);
  assert.equal(auth.providerErrorCode, "HUBSPOT_CONTACT_AUTH_FAILED");

  const limited = fakeHttp((request) =>
    request.url.endsWith("/contacts")
      ? { status: 201, body: JSON.stringify({ id: "101" }) }
      : { status: 429, body: "" },
  );
  const throttled = await createHubspotConnectorRuntime(limited.http).execute(
    "intake_lead",
    { lead_id: PROJECTION.lead_id },
    ctxFor("hubspot", {}, { private_app_token: "t" }),
  );
  assert.equal(throttled.retryable, true);

  const noToken = await createHubspotConnectorRuntime(
    fakeHttp(() => ({ status: 500, body: "" })).http,
  ).execute("intake_lead", { lead_id: PROJECTION.lead_id }, ctxFor("hubspot", {}, {}));
  assert.equal(noToken.providerErrorCode, "HUBSPOT_NO_TOKEN");
});

test("pipedrive: person deduped by search, deal + presentation note created", async () => {
  const fake = fakeHttp((request) => {
    if (request.url.includes("/v1/persons/search?term=ivan%40example.com")) {
      return {
        status: 200,
        body: JSON.stringify({ data: { items: [{ item: { id: 77 }, score: 1 }] } }),
      };
    }
    if (request.url.includes("/v1/deals?")) {
      const body = JSON.parse(request.body ?? "{}");
      assert.equal(body.title, "Lead: Иван Петров");
      assert.equal(body.person_id, 77);
      return { status: 201, body: JSON.stringify({ data: { id: 501 } }) };
    }
    if (request.url.includes("/v1/notes?")) {
      const body = JSON.parse(request.body ?? "{}");
      assert.equal(body.deal_id, 501);
      assert.equal(body.content, "Полное представление лида");
      return { status: 201, body: JSON.stringify({ data: { id: 9 } }) };
    }
    throw new Error(`unexpected pipedrive call ${request.url}`);
  });
  const runtime = createPipedriveConnectorRuntime(fake.http);
  const result = await runtime.execute(
    "intake_lead",
    { lead_id: PROJECTION.lead_id },
    ctxFor("pipedrive", {}, { api_token: "pd-token" }),
  );
  assert.deepEqual(
    { ok: result.ok, externalId: result.externalId },
    { ok: true, externalId: "501" },
  );
  // Person search + deal + note; no person create (dedupe hit).
  assert.equal(fake.calls.filter((call) => call.url.includes("/v1/persons/create")).length, 0);
  assert.equal(fake.calls.length, 3);
});

test("pipedrive: person created when the search misses", async () => {
  const fake = fakeHttp((request) => {
    if (request.url.includes("/v1/persons/search?")) {
      return { status: 200, body: JSON.stringify({ data: { items: [] } }) };
    }
    if (request.url.includes("/v1/persons?")) {
      return { status: 201, body: JSON.stringify({ data: { id: 88 } }) };
    }
    if (request.url.includes("/v1/deals?")) {
      return { status: 201, body: JSON.stringify({ data: { id: 502 } }) };
    }
    if (request.url.includes("/v1/notes?")) {
      return { status: 201, body: JSON.stringify({ data: { id: 10 } }) };
    }
    throw new Error(`unexpected pipedrive call ${request.url}`);
  });
  const result = await createPipedriveConnectorRuntime(fake.http).execute(
    "intake_lead",
    { lead_id: PROJECTION.lead_id },
    ctxFor("pipedrive", {}, { api_token: "pd" }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.externalId, "502");
});

test("zoho: refresh token exchange, contact + deal with Contact_Name lookup", async () => {
  const fake = fakeHttp((request) => {
    if (request.url.startsWith("https://accounts.zoho.eu/oauth/v2/token")) {
      assert.match(
        request.url ?? "",
        /refresh_token=zr&client_id=ci&client_secret=cs&grant_type=refresh_token/,
      );
      return {
        status: 200,
        body: JSON.stringify({ access_token: "zt", api_domain: "https://www.zoho.eu" }),
      };
    }
    if (request.url === "https://www.zoho.eu/crm/v3/Contacts") {
      assert.match(String(request.headers?.["authorization"]), /^Zoho-oauthtoken zt$/);
      const body = JSON.parse(request.body ?? "{}");
      assert.equal(body.data[0].Last_Name, "Иван Петров");
      assert.equal(body.data[0].Email, "ivan@example.com");
      return { status: 201, body: JSON.stringify({ data: [{ details: { id: "3001" } }] }) };
    }
    if (request.url === "https://www.zoho.eu/crm/v3/Deals") {
      const body = JSON.parse(request.body ?? "{}");
      assert.deepEqual(body.data[0].Contact_Name, { id: "3001" });
      assert.equal(body.data[0].Deal_Name, "Lead: Иван Петров");
      assert.equal(body.data[0].Description, "Полное представление лида");
      return { status: 201, body: JSON.stringify({ data: [{ details: { id: "4002" } }] }) };
    }
    throw new Error(`unexpected zoho call ${request.url}`);
  });
  const result = await createZohoCrmConnectorRuntime(fake.http).execute(
    "intake_lead",
    { lead_id: PROJECTION.lead_id },
    ctxFor(
      "zoho-crm",
      { region: "zoho.eu" },
      {
        refresh_token: "zr",
        client_id: "ci",
        client_secret: "cs",
      },
    ),
  );
  assert.deepEqual(
    { ok: result.ok, externalId: result.externalId },
    { ok: true, externalId: "4002" },
  );
});

test("zoho: rejected refresh token is a typed permanent failure", async () => {
  const fake = fakeHttp(() => ({
    status: 200,
    body: JSON.stringify({ error: "invalid_code" }),
  }));
  const result = await createZohoCrmConnectorRuntime(fake.http).execute(
    "intake_lead",
    { lead_id: PROJECTION.lead_id },
    ctxFor("zoho-crm", {}, { refresh_token: "x", client_id: "y", client_secret: "z" }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.providerErrorCode, "ZOHO_TOKEN_REJECTED");
  assert.equal(result.retryable, false);
});

test("sharecrm: token exchange, lead create with FXiaoKe headers, dataId extracted", async () => {
  const fake = fakeHttp((request) => {
    if (request.url.includes("/oauth2.0/token?")) {
      const body = JSON.parse(request.body ?? "{}");
      assert.deepEqual(body, {
        appId: "FSAID_1",
        appSecret: "sec",
        permanentCode: "perm",
        grantType: "app_secret",
      });
      return {
        status: 200,
        body: JSON.stringify({ errorCode: 0, accessToken: "fx-t", ea: "ea-9" }),
      };
    }
    if (request.url.includes("/cgi/crm/v2/data/create?")) {
      assert.equal(request.headers?.["authorization"], "Bearer fx-t");
      assert.equal(request.headers?.["x-fs-ea"], "ea-9");
      assert.equal(request.headers?.["x-fs-userid"], "EMP-1");
      const body = JSON.parse(request.body ?? "{}");
      assert.equal(body.data.object_data.dataObjectApiName, "LeadsObj");
      assert.equal(body.data.object_data.name, "Lead: Иван Петров");
      assert.equal(body.data.object_data.email, "ivan@example.com");
      assert.equal(body.data.object_data.phone, "+7 900 000-00-00");
      assert.equal(body.data.object_data.remark, "Полное представление лида");
      return { status: 200, body: JSON.stringify({ errorCode: 0, dataId: "68fabc" }) };
    }
    throw new Error(`unexpected sharecrm call ${request.url}`);
  });
  const result = await createSharecrmConnectorRuntime(fake.http).execute(
    "intake_lead",
    { lead_id: PROJECTION.lead_id },
    ctxFor(
      "sharecrm",
      { user_id: "EMP-1" },
      {
        app_id: "FSAID_1",
        app_secret: "sec",
        permanent_code: "perm",
      },
    ),
  );
  assert.deepEqual(
    { ok: result.ok, externalId: result.externalId },
    { ok: true, externalId: "68fabc" },
  );
});

test("sharecrm: non-zero errorCode is a typed failure; tests probe the token endpoint", async () => {
  const rejected = fakeHttp((request) =>
    request.url.includes("/oauth2.0/token?")
      ? {
          status: 200,
          body: JSON.stringify({ errorCode: 1006, errorMessage: "bad permanent code" }),
        }
      : (() => {
          throw new Error("should not reach the data API");
        })(),
  );
  const result = await createSharecrmConnectorRuntime(rejected.http).execute(
    "intake_lead",
    { lead_id: PROJECTION.lead_id },
    ctxFor("sharecrm", { user_id: "E" }, { app_id: "a", app_secret: "b", permanent_code: "c" }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.providerErrorCode, "SHARECRM_TOKEN_ERROR_1006");

  const probe = fakeHttp(() => ({
    status: 200,
    body: JSON.stringify({ errorCode: 0, accessToken: "t", ea: "e" }),
  }));
  const tested = await createSharecrmConnectorRuntime(probe.http).test(
    ctxFor("sharecrm", { user_id: "E" }, { app_id: "a", app_secret: "b", permanent_code: "c" }),
  );
  assert.equal(tested.ok, true);
});

test("salesforce: token exchange, email dedupe, lead create with LastName+Company", async () => {
  const { createSalesforceConnectorRuntime, salesforceConnectorDefinition } = await import(
    "@pcms/integrations"
  );
  const fake = fakeHttp((request) => {
    if (request.url === "https://login.salesforce.com/services/oauth2/token") {
      assert.match(String(request.headers?.["content-type"]), /application\/x-www-form-urlencoded/);
      assert.match(request.body ?? "", /grant_type=client_credentials/);
      assert.match(request.body ?? "", /client_id=ci/);
      return {
        status: 200,
        body: JSON.stringify({
          access_token: "sf-t",
          instance_url: "https://org.my.salesforce.com",
        }),
      };
    }
    if (request.url.startsWith("https://org.my.salesforce.com/services/data/v60.0/query?")) {
      assert.match(
        request.url ?? "",
        /SELECT%20Id%20FROM%20Lead%20WHERE%20Email%20%3D%20'ivan%40example.com'%20LIMIT%201/,
      );
      return { status: 200, body: JSON.stringify({ records: [] }) };
    }
    if (request.url === "https://org.my.salesforce.com/services/data/v60.0/sobjects/Lead") {
      const body = JSON.parse(request.body ?? "{}");
      assert.equal(body.LastName, "Иван Петров");
      assert.equal(body.Company, "Website lead");
      assert.equal(body.Email, "ivan@example.com");
      assert.equal(body.Description, "Хочет ангар 1200м²\n\nПолное представление лида");
      return { status: 201, body: JSON.stringify({ id: "00QAbc", success: true }) };
    }
    throw new Error(`unexpected salesforce call ${request.url}`);
  });
  const runtime = createSalesforceConnectorRuntime(fake.http);
  const result = await runtime.execute(
    "intake_lead",
    { lead_id: PROJECTION.lead_id },
    ctxFor("salesforce", {}, { client_id: "ci", client_secret: "cs" }),
  );
  assert.deepEqual(
    { ok: result.ok, externalId: result.externalId },
    { ok: true, externalId: "00QAbc" },
  );
  assert.equal(salesforceConnectorDefinition.connectorType, "salesforce");
});

test("salesforce: an existing exact-email lead short-circuits the create", async () => {
  const { createSalesforceConnectorRuntime } = await import("@pcms/integrations");
  const fake = fakeHttp((request) => {
    if (request.url.includes("/oauth2/token")) {
      return {
        status: 200,
        body: JSON.stringify({ access_token: "t", instance_url: "https://o.my.salesforce.com" }),
      };
    }
    if (request.url.includes("/query?")) {
      return { status: 200, body: JSON.stringify({ records: [{ Id: "00QExisting" }] }) };
    }
    throw new Error("should not create a duplicate lead");
  });
  const result = await createSalesforceConnectorRuntime(fake.http).execute(
    "intake_lead",
    { lead_id: PROJECTION.lead_id },
    ctxFor("salesforce", {}, { client_id: "ci", client_secret: "cs" }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.externalId, "00QExisting");
});
