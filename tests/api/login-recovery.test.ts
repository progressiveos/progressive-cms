import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, type ApplicationServices, createApiFastify, createApiV1 } from "@pcms/api";

test("login recovers from an expired cookie while protected requests and Origin remain checked", async (t) => {
  let sessionChecks = 0;
  let passwordChecks = 0;
  const application = {
    pool: {},
    sessions: {
      async resolveSession() {
        sessionChecks++;
        return null;
      },
    },
    authentication: {
      async login(input: { password: string }) {
        passwordChecks++;
        if (input.password !== "valid-password") {
          throw new ApiError("AUTH_INVALID_CREDENTIALS", "invalid credentials", { status: 401 });
        }
        return {
          stage: "PASSWORD_OK",
          user: { id: "01a11395-70e4-75b4-b288-9c20e9330a29" },
          session: { rawToken: "fresh-session", csrfToken: "fresh-csrf" },
          mfaRequired: false,
        };
      },
    },
  } as unknown as ApplicationServices;
  const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
  const server = createApiFastify(() => "login-recovery");
  t.after(() => server.close());
  await server.register(createApiV1([]), { application, logger, cookieSecure: false });
  const headers = {
    host: "wb-st.test",
    origin: "http://wb-st.test",
    cookie: "pcms_session=expired-session",
  };
  const login = await server.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers,
    payload: { email: "owner@example.test", password: "valid-password" },
  });
  assert.equal(login.statusCode, 200);
  assert.match(String(login.headers["set-cookie"]), /fresh-session/);
  assert.equal(sessionChecks, 0);
  const wrongPassword = await server.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers,
    payload: { email: "owner@example.test", password: "wrong-password" },
  });
  assert.equal(wrongPassword.json().error.code, "AUTH_INVALID_CREDENTIALS");
  const protectedRead = await server.inject({ method: "GET", url: "/api/v1/actor", headers });
  assert.equal(protectedRead.json().error.code, "AUTH_SESSION_INVALID");
  assert.equal(sessionChecks, 1);
  const crossOrigin = await server.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { ...headers, origin: "http://foreign.test" },
    payload: { email: "owner@example.test", password: "valid-password" },
  });
  assert.equal(crossOrigin.statusCode, 403);
  assert.equal(passwordChecks, 2);
});
