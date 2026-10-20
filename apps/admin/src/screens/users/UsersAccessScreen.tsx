// Users & Access (PCMS-ADMIN-T020/T021; Admin spec §43-§46): people with
// roles/sessions/MFA, role matrix, service accounts with the token wizard.
// The server stays the authorization authority; last-OWNER is reflected, not
// enforced, here. Secrets are displayed exactly once.
import { useCallback, useEffect, useState } from "react";
import { ApiError, apiDelete, apiGet, apiPost, apiPut } from "../../api/client.js";
import { useAuth } from "../../auth/AuthContext.js";
import { Dialog } from "../../design/dialog.js";
import { useToast } from "../../design/toast.js";
import { Tooltip } from "../../design/tooltip.js";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Icon,
  IconButton,
  Input,
  Select,
  Spinner,
  Switch,
} from "../../design/ui.js";
import { errorText, formatDate, formatDateTime, t } from "../../i18n/index.js";

interface UserRow {
  readonly user_id: string;
  readonly display_name: string;
  readonly status: string;
  readonly primary_email: string | null;
  readonly roles: readonly string[];
  readonly has_confirmed_mfa: boolean;
}

interface RoleWire {
  readonly key: string;
  readonly name: string;
  readonly builtin: boolean;
  readonly immutable: boolean;
  readonly permissions: readonly string[];
}

interface AccessApi {
  readonly roles: readonly RoleWire[];
  readonly permissions: readonly { readonly key: string; readonly summary: string }[];
  readonly presets: Readonly<Record<string, readonly string[]>>;
}

const DANGEROUS = new Set([
  "publication.publish",
  "publication.unpublish",
  "publication.rollback",
  "theme.activate",
  "users.manage",
  "tokens.manage",
  "integrations.secrets.manage",
  "payments.refund",
  "embed.trusted",
  "leads.read",
]);

export function UsersAccessScreen() {
  const [tab, setTab] = useState<"people" | "roles" | "accounts">("people");
  return (
    <div data-testid="users-screen">
      <h1>{t("access.screen_title")}</h1>
      <div className="pcms-tabs" role="tablist" aria-label={t("access.tabs_aria")}>
        {(
          [
            ["people", t("access.tab_people")],
            ["roles", t("access.tab_roles")],
            ["accounts", t("access.tab_accounts")],
          ] as const
        ).map(([id, title]) => (
          <button
            key={id}
            type="button"
            role="tab"
            className="pcms-tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {title}
          </button>
        ))}
      </div>
      {tab === "people" ? <PeopleTab /> : null}
      {tab === "roles" ? <RolesTab /> : null}
      {tab === "accounts" ? <AccountsTab /> : null}
    </div>
  );
}

/* --- People --- */

function PeopleTab() {
  const auth = useAuth();
  const toast = useToast();
  const [users, setUsers] = useState<readonly UserRow[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createDirectOpen, setCreateDirectOpen] = useState(false);
  const [invite, setInvite] = useState<{ email: string; token: string } | null>(null);
  const [editUser, setEditUser] = useState<UserRow | null>(null);
  const [passwordUser, setPasswordUser] = useState<UserRow | null>(null);
  const [deleteUser, setDeleteUser] = useState<UserRow | null>(null);
  const [busy, setBusy] = useState(false);
  const selfUserId =
    auth.state.status === "authed" && auth.state.actor.actor_type === "USER"
      ? auth.state.actor.actor_id
      : null;

  const reload = useCallback(() => {
    apiGet<{ items: readonly UserRow[] }>("/users")
      .then((result) => setUsers(result.items))
      .catch(() => toast(t("access.load_users_failed"), "error"));
  }, [toast]);
  useEffect(reload, [reload]);

  const run = async (action: () => Promise<unknown>, success: string, failure?: string) => {
    setBusy(true);
    try {
      await action();
      toast(success, "success");
      reload();
    } catch (caught) {
      const code =
        caught instanceof Error && "code" in caught
          ? String((caught as { code: string }).code)
          : "";
      toast(
        code === "AUTH_LAST_OWNER_PROTECTED"
          ? t("access.last_owner_protected")
          : (failure ?? t("access.operation_failed")),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  if (users === null) return <Spinner />;

  return (
    <div>
      <div className="pcms-toolbar">
        <span className="pcms-toolbar__spacer" />
        {auth.can("users.manage") ? (
          <>
            <Button size="sm" onClick={() => setCreateDirectOpen(true)}>
              {t("access.create_user_button")}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setCreateOpen(true)}>
              {t("access.invite_employee_button")}
            </Button>
          </>
        ) : null}
      </div>
      {users.length === 0 ? (
        <EmptyState title={t("access.users_empty")} />
      ) : (
        <div className="pcms-table-wrap">
          <table className="pcms-table" data-testid="users-table">
            <thead>
              <tr>
                <th>{t("access.th_user")}</th>
                <th>{t("access.th_roles")}</th>
                <th>{t("access.th_status")}</th>
                <th>{t("access.th_mfa")}</th>
                <th>{t("access.th_actions")}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.user_id}>
                  <td>
                    <strong>{user.display_name}</strong>
                    {user.user_id === selfUserId ? (
                      <Badge tone="accent">{t("access.you_badge")}</Badge>
                    ) : null}
                    <div className="pcms-picker-row__meta">{user.primary_email}</div>
                  </td>
                  <td>
                    {user.roles.map((role) => (
                      <Badge key={role} tone="accent">
                        {role}
                      </Badge>
                    ))}
                  </td>
                  <td>
                    {user.status === "ACTIVE" ? (
                      <Badge tone="success">{t("access.state_active")}</Badge>
                    ) : (
                      <Badge tone="danger">{t("access.state_disabled")}</Badge>
                    )}
                  </td>
                  <td>{user.has_confirmed_mfa ? <Badge>{t("access.mfa_badge")}</Badge> : "—"}</td>
                  <td className="pcms-actions-row">
                    {auth.can("users.manage") ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setEditUser(user)}
                        >
                          {t("access.edit_user")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setPasswordUser(user)}
                        >
                          {t("access.set_password")}
                        </Button>
                        {user.status === "ACTIVE" ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () => apiPost(`/users/${user.user_id}/disable`, {}),
                                t("access.user_disabled"),
                              )
                            }
                          >
                            {t("access.disable")}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () => apiPost(`/users/${user.user_id}/enable`, {}),
                                t("access.user_enabled"),
                              )
                            }
                          >
                            {t("access.enable")}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => apiPost(`/users/${user.user_id}/sessions/revoke`, {}),
                              t("access.sessions_revoked"),
                            )
                          }
                        >
                          {t("access.sessions_button")}
                        </Button>
                        {user.has_confirmed_mfa ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () => apiDelete(`/users/${user.user_id}/mfa`),
                                t("access.mfa_reset"),
                              )
                            }
                          >
                            {t("access.reset_mfa")}
                          </Button>
                        ) : null}
                        <RoleSelect
                          userId={user.user_id}
                          roles={user.roles}
                          busy={busy}
                          onChanged={reload}
                        />
                        {user.user_id !== selfUserId ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => setDeleteUser(user)}
                          >
                            {t("access.delete")}
                          </Button>
                        ) : null}
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen ? (
        <CreateUserDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(email, token) => {
            setCreateOpen(false);
            setInvite({ email, token });
            reload();
          }}
        />
      ) : null}
      {createDirectOpen ? (
        <CreateUserDirectDialog
          onClose={() => setCreateDirectOpen(false)}
          onCreated={() => {
            setCreateDirectOpen(false);
            toast(t("access.user_created"), "success");
            reload();
          }}
        />
      ) : null}
      {editUser !== null ? (
        <EditUserDialog
          user={editUser}
          onClose={() => setEditUser(null)}
          onSaved={() => {
            setEditUser(null);
            toast(t("access.user_updated"), "success");
            reload();
          }}
        />
      ) : null}
      {passwordUser !== null ? (
        <SetPasswordDialog
          user={passwordUser}
          onClose={() => setPasswordUser(null)}
          onSaved={() => {
            setPasswordUser(null);
            toast(t("access.password_set"), "success");
          }}
        />
      ) : null}
      {deleteUser !== null ? (
        <Dialog
          open
          onClose={() => setDeleteUser(null)}
          title={t("access.delete_user_title")}
          footer={
            <>
              <Button onClick={() => setDeleteUser(null)}>{t("access.cancel")}</Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={async () => {
                  const target = deleteUser;
                  setDeleteUser(null);
                  if (target === null) return;
                  await run(
                    () => apiDelete(`/users/${target.user_id}`),
                    t("access.user_deleted"),
                    t("access.user_delete_failed"),
                  );
                }}
              >
                {t("access.delete")}
              </Button>
            </>
          }
        >
          <p>{t("access.delete_user_confirm", { name: deleteUser.display_name })}</p>
        </Dialog>
      ) : null}
      {invite !== null ? (
        <Dialog
          open
          onClose={() => setInvite(null)}
          title={t("access.invite_created_title")}
          footer={
            <Button variant="primary" onClick={() => setInvite(null)}>
              {t("access.invite_saved_button")}
            </Button>
          }
        >
          <p>
            {t("access.invite_once_intro")} <strong>{t("access.invite_once_strong")}</strong>{" "}
            {t("access.invite_once_outro")}
          </p>
          <code style={{ wordBreak: "break-all" }} data-testid="invite-token">
            {`/admin/#/invite/${invite.token}`}
          </code>
          <p className="pcms-field__hint">
            {t("access.invite_email_hint", { email: invite.email })}
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}

function RoleSelect(props: {
  readonly userId: string;
  readonly roles: readonly string[];
  readonly busy: boolean;
  readonly onChanged: () => void;
}) {
  const toast = useToast();
  const [roles, setRoles] = useState<readonly RoleWire[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void apiGet<AccessApi>("/roles").then((result) => setRoles(result.roles));
  }, []);
  const unassigned = roles.filter((role) => !props.roles.includes(role.key));
  return (
    <Select
      style={{ width: "auto" }}
      aria-label={t("access.add_role_aria")}
      value=""
      disabled={props.busy || busy || unassigned.length === 0}
      onChange={async (event) => {
        const roleKey = event.target.value;
        if (roleKey === "") return;
        setBusy(true);
        try {
          await apiPost(`/users/${props.userId}/roles`, { role_key: roleKey });
          toast(t("access.role_assigned"), "success");
          props.onChanged();
        } catch {
          toast(t("access.role_assign_failed"), "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      <option value="">{t("access.add_role_option")}</option>
      {unassigned.map((role) => (
        <option key={role.key} value={role.key}>
          {role.name}
        </option>
      ))}
    </Select>
  );
}

function CreateUserDialog(props: {
  readonly onClose: () => void;
  readonly onCreated: (email: string, token: string) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [roleKey, setRoleKey] = useState("EDITOR");
  const [roles, setRoles] = useState<readonly RoleWire[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void apiGet<AccessApi>("/roles").then((result) => setRoles(result.roles));
  }, []);
  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t("access.invite_dialog_title")}
      footer={
        <>
          <Button onClick={props.onClose}>{t("access.cancel")}</Button>
          <Button
            variant="primary"
            disabled={busy || displayName === "" || email === ""}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const result = await apiPost<{ user_id: string; invite_token: string }>("/users", {
                  display_name: displayName,
                  email,
                  role_key: roleKey,
                });
                props.onCreated(email, result.invite_token);
              } catch {
                setError(t("access.user_create_failed"));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("access.create_invite_button")}
          </Button>
        </>
      }
    >
      <Field label={t("access.field_name")} required>
        <Input
          value={displayName}
          maxLength={200}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </Field>
      <Field label={t("access.field_email")} required>
        <Input
          type="email"
          value={email}
          maxLength={320}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>
      <Field label={t("access.field_role")} required>
        <Select value={roleKey} onChange={(event) => setRoleKey(event.target.value)}>
          {roles.map((role) => (
            <option key={role.key} value={role.key}>
              {role.name}
            </option>
          ))}
        </Select>
      </Field>
      {error === null ? null : (
        <p className="pcms-field__error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

function CreateUserDirectDialog(props: {
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [roleKey, setRoleKey] = useState("EDITOR");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [roles, setRoles] = useState<readonly RoleWire[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void apiGet<AccessApi>("/roles").then((result) => setRoles(result.roles));
  }, []);
  const mismatch = confirm !== "" && password !== confirm;
  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t("access.direct_user_dialog_title")}
      footer={
        <>
          <Button onClick={props.onClose}>{t("access.cancel")}</Button>
          <Button
            variant="primary"
            disabled={
              busy || displayName === "" || email === "" || password === "" || password !== confirm
            }
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await apiPost("/users/direct", {
                  display_name: displayName,
                  email,
                  role_key: roleKey,
                  password,
                });
                setPassword("");
                setConfirm("");
                props.onCreated();
              } catch (cause) {
                const detail =
                  cause instanceof ApiError
                    ? (errorText(cause.code) ?? cause.message)
                    : (cause as Error).message;
                setError(detail || t("access.user_create_failed"));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("access.create_user_button_label")}
          </Button>
        </>
      }
    >
      <Field label={t("access.field_name")} required>
        <Input
          value={displayName}
          maxLength={200}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </Field>
      <Field label={t("access.field_email")} required>
        <Input
          type="email"
          value={email}
          maxLength={320}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>
      <Field label={t("access.field_role")} required>
        <Select value={roleKey} onChange={(event) => setRoleKey(event.target.value)}>
          {roles.map((role) => (
            <option key={role.key} value={role.key}>
              {role.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("access.field_password")} required hint={t("access.password_hint")}>
        <Input
          type="password"
          value={password}
          maxLength={1024}
          autoComplete="new-password"
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <Field
        label={t("access.field_password_confirm")}
        required
        {...(mismatch ? { error: t("access.password_mismatch") } : {})}
      >
        <Input
          type="password"
          value={confirm}
          maxLength={1024}
          autoComplete="new-password"
          onChange={(event) => setConfirm(event.target.value)}
        />
      </Field>
      {error === null ? null : (
        <p className="pcms-field__error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

function EditUserDialog(props: {
  readonly user: UserRow;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState(props.user.display_name);
  const [email, setEmail] = useState(props.user.primary_email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Send only the changed fields: an unchanged email must not lose its
  // verification mark (the server resets it on any email rewrite).
  const nameChanged = displayName !== props.user.display_name;
  const emailChanged = email !== (props.user.primary_email ?? "");
  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t("access.edit_user_title")}
      footer={
        <>
          <Button onClick={props.onClose}>{t("access.cancel")}</Button>
          <Button
            variant="primary"
            disabled={busy || (!nameChanged && !emailChanged) || email === ""}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await apiPut(`/users/${props.user.user_id}`, {
                  ...(nameChanged ? { display_name: displayName } : {}),
                  ...(emailChanged ? { email } : {}),
                });
                props.onSaved();
              } catch (cause) {
                const detail =
                  cause instanceof ApiError
                    ? (errorText(cause.code) ?? cause.message)
                    : (cause as Error).message;
                setError(detail || t("access.user_update_failed"));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("save")}
          </Button>
        </>
      }
    >
      <Field label={t("access.field_name")} required>
        <Input
          value={displayName}
          maxLength={200}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </Field>
      <Field label={t("access.field_email")} required>
        <Input
          type="email"
          value={email}
          maxLength={320}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>
      {error === null ? null : (
        <p className="pcms-field__error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

function SetPasswordDialog(props: {
  readonly user: UserRow;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = confirm !== "" && password !== confirm;
  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t("access.password_title", { name: props.user.display_name })}
      footer={
        <>
          <Button onClick={props.onClose}>{t("access.cancel")}</Button>
          <Button
            variant="primary"
            disabled={busy || password === "" || password !== confirm}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await apiPut(`/users/${props.user.user_id}/password`, { new_password: password });
                setPassword("");
                setConfirm("");
                props.onSaved();
              } catch (cause) {
                const detail =
                  cause instanceof ApiError
                    ? (errorText(cause.code) ?? cause.message)
                    : (cause as Error).message;
                setError(detail || t("access.password_set_failed"));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("access.set_password")}
          </Button>
        </>
      }
    >
      <Field label={t("access.field_password")} required hint={t("access.password_hint")}>
        <Input
          type="password"
          value={password}
          maxLength={1024}
          autoComplete="new-password"
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <Field
        label={t("access.field_password_confirm")}
        required
        {...(mismatch ? { error: t("access.password_mismatch") } : {})}
      >
        <Input
          type="password"
          value={confirm}
          maxLength={1024}
          autoComplete="new-password"
          onChange={(event) => setConfirm(event.target.value)}
        />
      </Field>
      {error === null ? null : (
        <p className="pcms-field__error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/* --- Roles matrix --- */

function RolesTab() {
  const auth = useAuth();
  const toast = useToast();
  const [api, setApi] = useState<AccessApi | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const reload = useCallback(() => {
    apiGet<AccessApi>("/roles")
      .then(setApi)
      .catch(() => toast(t("access.load_roles_failed"), "error"));
  }, [toast]);
  useEffect(reload, [reload]);
  if (api === null) return <Spinner />;

  return (
    <div data-testid="roles-matrix">
      <div className="pcms-toolbar">
        <span className="pcms-toolbar__spacer" />
        {auth.can("roles.manage") ? (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            {t("access.add_custom_role_button")}
          </Button>
        ) : null}
      </div>
      {api.roles.map((role) => (
        <div key={role.key} className="pcms-panel">
          <div className="pcms-toolbar">
            <h3>
              {role.name} <span className="pcms-picker-row__meta">{role.key}</span>
            </h3>
            {role.builtin ? (
              <Badge>{t("access.role_builtin")}</Badge>
            ) : (
              <Badge tone="accent">{t("access.role_custom")}</Badge>
            )}
            <span className="pcms-toolbar__spacer" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setExpanded(expanded === role.key ? null : role.key)}
            >
              {expanded === role.key
                ? t("access.hide_permissions")
                : t("access.permissions_count", { count: role.permissions.length })}
            </Button>
            {auth.can("roles.manage") && !role.immutable ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  try {
                    await apiPost("/roles-admin", { action: "delete", role_key: role.key });
                    toast(t("access.role_deleted"), "success");
                    reload();
                  } catch {
                    toast(t("access.role_delete_failed"), "error");
                  }
                }}
              >
                {t("access.delete")}
              </Button>
            ) : null}
          </div>
          {expanded === role.key ? (
            <div className="pcms-form-grid">
              {api.permissions.map((permission) => (
                <div
                  key={permission.key}
                  className="pcms-row"
                  style={{ alignItems: "center", padding: "0.25rem 0.5rem" }}
                >
                  <div className="pcms-row__body">
                    <span
                      style={{
                        fontFamily: "var(--pcms-admin-font-mono)",
                        fontSize: "var(--pcms-admin-text-sm)",
                      }}
                    >
                      {permission.key}
                      {DANGEROUS.has(permission.key) ? (
                        <span style={{ color: "var(--pcms-admin-danger)" }}>
                          <Icon name="warning" label={t("access.danger_permission")} />
                        </span>
                      ) : null}
                    </span>
                    <div className="pcms-picker-row__meta">{permission.summary}</div>
                  </div>
                  {role.permissions.includes(permission.key) ? (
                    <Badge tone="success">{t("access.perm_yes")}</Badge>
                  ) : (
                    <Badge>{t("access.perm_no")}</Badge>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ))}
      {createOpen ? (
        <CreateRoleDialog
          permissions={api.permissions}
          presets={api.presets}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

function CreateRoleDialog(props: {
  readonly permissions: readonly { key: string; summary: string }[];
  readonly presets: Readonly<Record<string, readonly string[]>>;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) {
  const toast = useToast();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t("access.custom_role_title")}
      wide
      footer={
        <>
          <Button onClick={props.onClose}>{t("access.cancel")}</Button>
          <Button
            variant="primary"
            disabled={key === "" || name === "" || selected.size === 0}
            onClick={async () => {
              try {
                await apiPost("/roles-admin", {
                  action: "create",
                  role_key: key,
                  name,
                  permissions: [...selected],
                });
                toast(t("access.role_created"), "success");
                props.onCreated();
              } catch {
                toast(t("access.role_create_failed"), "error");
              }
            }}
          >
            {t("access.create_role_button")}
          </Button>
        </>
      }
    >
      <div className="pcms-form-grid">
        <Field label={t("access.field_key")} required hint={t("access.key_hint")}>
          <Input
            value={key}
            maxLength={64}
            onChange={(event) => setKey(event.target.value.toUpperCase())}
          />
        </Field>
        <Field label={t("access.field_title")} required>
          <Input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
        </Field>
      </div>
      <PresetButtonsRow presets={props.presets} onPick={(scopes) => setSelected(new Set(scopes))} />
      <PermissionChecklist
        permissions={props.permissions}
        selected={selected}
        onToggle={(permissionKey, on) => {
          const next = new Set(selected);
          if (on) next.add(permissionKey);
          else next.delete(permissionKey);
          setSelected(next);
        }}
      />
    </Dialog>
  );
}

/* --- Service accounts + token wizard --- */

/** Tooltip help for one permission: the localized RU/EN description from the
 * `perm.*` catalog (what it grants, when it matters, how it bites); falls
 * back to the registry summary for keys a future registry append adds
 * before the catalog is swept. */
function permissionHelp(key: string, summary: string): string {
  const localized = t(`perm.${key}`);
  return localized.startsWith("[") ? summary : localized;
}

/** Preset buttons shared by the token wizard and the role dialog (owner
 * directive 2026-09-28): generous scenario starting points served by the
 * server (`/roles` presets), labeled from the `access.preset_*` catalog. */
function PresetButtonsRow(props: {
  readonly presets: Readonly<Record<string, readonly string[]>>;
  readonly onPick: (scopes: readonly string[]) => void;
}) {
  return (
    <div className="pcms-actions-row" style={{ marginBottom: "var(--pcms-admin-space-3)" }}>
      {Object.entries(props.presets).map(([presetKey, presetScopes]) => (
        <Button key={presetKey} size="sm" onClick={() => props.onPick(presetScopes)}>
          {t(`access.preset_${presetKey}`)}
        </Button>
      ))}
      <span className="pcms-field__hint">{t("access.preset_hint")}</span>
    </div>
  );
}

/** The permission grid shared by the token wizard and the role dialog: one
 * checkbox per registry key, each with a hover/focus tooltip explaining
 * what the scope gives and how it can bite. */
function PermissionChecklist(props: {
  readonly permissions: readonly { readonly key: string; readonly summary: string }[];
  readonly selected: ReadonlySet<string>;
  readonly disabledFor?: (key: string) => boolean;
  readonly onToggle: (key: string, on: boolean) => void;
}) {
  return (
    <div className="pcms-form-grid">
      {props.permissions.map((permission) => {
        const disabled = props.disabledFor?.(permission.key) ?? false;
        return (
          <Tooltip
            key={permission.key}
            content={permissionHelp(permission.key, permission.summary)}
          >
            <label className="pcms-switch">
              <input
                type="checkbox"
                disabled={disabled}
                checked={props.selected.has(permission.key)}
                onChange={(event) => props.onToggle(permission.key, event.target.checked)}
              />
              <span>
                {permission.key}
                {DANGEROUS.has(permission.key) ? (
                  <span style={{ color: "var(--pcms-admin-danger)" }}>
                    <Icon name="warning" label={t("access.danger_permission")} />
                  </span>
                ) : null}
              </span>
            </label>
          </Tooltip>
        );
      })}
    </div>
  );
}

interface AccountWire {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly status: string;
  readonly allowed_scopes: readonly string[] | null;
}

interface TokenRow {
  readonly id: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
}

const ACCOUNTS_PAGE_SIZE = 20;

function AccountsTab() {
  const auth = useAuth();
  const toast = useToast();
  const [accounts, setAccounts] = useState<readonly AccountWire[] | null>(null);
  const [openAccount, setOpenAccount] = useState<string | null>(null);
  const [wizard, setWizard] = useState<AccountWire | null>(null);
  const [secret, setSecret] = useState<{ prefix: string; raw: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<{
    readonly ids: readonly string[];
    readonly names: readonly string[];
  } | null>(null);

  const reload = useCallback(() => {
    apiGet<{ items: readonly AccountWire[] }>("/service-accounts")
      .then((result) => {
        setAccounts(result.items);
        setSelected(new Set());
      })
      .catch(() => toast(t("access.load_accounts_failed"), "error"));
  }, [toast]);
  useEffect(reload, [reload]);

  if (accounts === null) return <Spinner />;

  // Client-side paging: the account list is small and already fully loaded;
  // server pagination would be ceremony without a count problem to solve.
  const pageCount = Math.max(1, Math.ceil(accounts.length / ACCOUNTS_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = accounts.slice(
    safePage * ACCOUNTS_PAGE_SIZE,
    (safePage + 1) * ACCOUNTS_PAGE_SIZE,
  );
  const allVisibleSelected =
    visible.length > 0 && visible.every((account) => selected.has(account.id));

  const askDelete = (ids: readonly string[]) => {
    const names = ids.map((id) => accounts.find((account) => account.id === id)?.name ?? id);
    setConfirmDelete({ ids, names });
  };
  const runDelete = async () => {
    if (confirmDelete === null) return;
    const { ids } = confirmDelete;
    setConfirmDelete(null);
    const results = await Promise.allSettled(
      ids.map((id) => apiDelete(`/service-accounts/${id}`, { reason: t("access.delete_reason") })),
    );
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed === 0) {
      toast(
        ids.length === 1
          ? t("access.account_deleted_one")
          : t("access.account_deleted_many", { count: ids.length }),
        "success",
      );
    } else {
      toast(t("access.delete_failed_partial", { failed, total: ids.length }), "error");
    }
    reload();
  };

  return (
    <div data-testid="accounts-tab">
      <div className="pcms-toolbar">
        {auth.can("tokens.manage") && selected.size > 0 ? (
          <Button size="sm" variant="danger" onClick={() => askDelete([...selected])}>
            <Icon name="delete" /> {t("access.delete_selected", { count: selected.size })}
          </Button>
        ) : null}
        <span className="pcms-toolbar__spacer" />
        {auth.can("tokens.manage") ? (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            {t("access.add_account_button")}
          </Button>
        ) : null}
      </div>
      {accounts.length === 0 ? (
        <EmptyState title={t("access.accounts_empty")} hint={t("access.accounts_empty_hint")} />
      ) : (
        <>
          <div className="pcms-table-wrap">
            <table className="pcms-table">
              <thead>
                <tr>
                  <th style={{ width: "2.5rem" }}>
                    {auth.can("tokens.manage") ? (
                      <label className="pcms-switch">
                        <input
                          type="checkbox"
                          aria-label={t("access.select_page")}
                          checked={allVisibleSelected}
                          onChange={(event) => {
                            const next = new Set(selected);
                            for (const account of visible) {
                              if (event.target.checked) next.add(account.id);
                              else next.delete(account.id);
                            }
                            setSelected(next);
                          }}
                        />
                      </label>
                    ) : null}
                  </th>
                  <th>{t("access.th_account")}</th>
                  <th>{t("access.th_purpose")}</th>
                  <th>{t("access.th_status")}</th>
                  <th>{t("access.th_actions")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((account) => (
                  <tr key={account.id}>
                    <td>
                      {auth.can("tokens.manage") ? (
                        <label className="pcms-switch">
                          <input
                            type="checkbox"
                            aria-label={t("access.select_page")}
                            checked={selected.has(account.id)}
                            onChange={(event) => {
                              const next = new Set(selected);
                              if (event.target.checked) next.add(account.id);
                              else next.delete(account.id);
                              setSelected(next);
                            }}
                          />
                        </label>
                      ) : null}
                    </td>
                    <td>
                      <strong>{account.name}</strong>
                      <div className="pcms-picker-row__meta">{account.id}</div>
                    </td>
                    <td>{account.purpose}</td>
                    <td>
                      {account.status === "ENABLED" ? (
                        <Badge tone="success">{t("access.state_enabled")}</Badge>
                      ) : (
                        <Badge tone="danger">{t("access.state_disabled")}</Badge>
                      )}
                    </td>
                    <td className="pcms-actions-row">
                      {auth.can("tokens.manage") ? (
                        <>
                          <IconButton
                            small
                            icon="key"
                            label={t("access.tokens_button")}
                            onClick={() => {
                              setOpenAccount(openAccount === account.id ? null : account.id);
                            }}
                          />
                          {account.status === "ENABLED" ? (
                            <>
                              <IconButton
                                small
                                icon="plus"
                                label={t("access.new_token_button")}
                                onClick={() => setWizard(account)}
                              />
                              <IconButton
                                small
                                variant="danger"
                                icon="hide"
                                label={t("access.disable")}
                                onClick={async () => {
                                  try {
                                    await apiPost(`/service-accounts/${account.id}/disable`, {
                                      reason: t("access.disable_reason"),
                                    });
                                    toast(t("access.account_disabled"), "success");
                                    reload();
                                  } catch {
                                    toast(t("access.disable_failed"), "error");
                                  }
                                }}
                              />
                            </>
                          ) : null}
                          <IconButton
                            small
                            variant="danger"
                            icon="delete"
                            label={t("access.delete_account")}
                            onClick={() => askDelete([account.id])}
                          />
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pageCount > 1 ? (
            <nav className="pcms-actions-row" aria-label={t("access.pagination_aria")}>
              <IconButton
                small
                icon="chevronLeft"
                label={t("access.page_prev")}
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
              />
              <span className="pcms-picker-row__meta">
                {safePage + 1} / {pageCount}
              </span>
              <IconButton
                small
                icon="chevronRight"
                label={t("access.page_next")}
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage(safePage + 1)}
              />
            </nav>
          ) : null}
        </>
      )}

      {openAccount !== null ? <TokenList accountId={openAccount} /> : null}
      {confirmDelete !== null ? (
        <Dialog
          open
          onClose={() => setConfirmDelete(null)}
          title={t("access.delete_confirm_title")}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(null)}>{t("access.cancel")}</Button>
              <Button variant="danger" onClick={() => void runDelete()}>
                <Icon name="delete" /> {t("delete")}
              </Button>
            </>
          }
        >
          <p>
            {confirmDelete.ids.length === 1
              ? t("access.delete_confirm_one", { name: confirmDelete.names[0] ?? "" })
              : t("access.delete_confirm_many", { count: confirmDelete.ids.length })}
          </p>
          <p className="pcms-field__hint">{t("access.delete_confirm_hint")}</p>
        </Dialog>
      ) : null}
      {wizard !== null ? (
        <TokenWizard
          account={wizard}
          onClose={() => setWizard(null)}
          onCreated={(raw) => {
            setWizard(null);
            setSecret(raw);
            reload();
          }}
        />
      ) : null}
      {secret !== null ? (
        <Dialog
          open
          onClose={() => setSecret(null)}
          title={t("access.token_created_title")}
          footer={
            <Button variant="primary" onClick={() => setSecret(null)}>
              {t("access.token_saved_button")}
            </Button>
          }
        >
          <p>{t("access.token_copy_now")}</p>
          <code style={{ wordBreak: "break-all" }} data-testid="token-secret">
            {secret.raw}
          </code>
          <p className="pcms-field__hint">
            {t("access.token_prefix_hint", { prefix: secret.prefix })}
          </p>
        </Dialog>
      ) : null}
      {createOpen ? (
        <CreateAccountDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

function TokenList(props: { readonly accountId: string }) {
  const toast = useToast();
  const [tokens, setTokens] = useState<readonly TokenRow[] | null>(null);
  const load = useCallback(() => {
    void apiGet<{ items: readonly TokenRow[] }>(`/service-accounts/${props.accountId}/tokens`)
      .then((result) => setTokens(result.items))
      .catch(() => setTokens([]));
  }, [props.accountId]);
  useEffect(load, [load]);
  if (tokens === null) return <Spinner />;
  if (tokens.length === 0) return <p className="pcms-text-muted">{t("access.tokens_empty")}</p>;
  return (
    <div className="pcms-table-wrap">
      <table className="pcms-table">
        <thead>
          <tr>
            <th>{t("access.th_prefix")}</th>
            <th>{t("access.th_scopes")}</th>
            <th>{t("access.th_created")}</th>
            <th>{t("access.th_expires")}</th>
            <th>{t("access.th_status")}</th>
            <th>{t("access.th_actions")}</th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((token) => (
            <tr key={token.id}>
              <td style={{ fontFamily: "var(--pcms-admin-font-mono)" }}>{token.prefix}…</td>
              <td>{token.scopes.join(", ")}</td>
              <td>{formatDate(token.created_at)}</td>
              <td>
                {token.expires_at === null
                  ? t("access.never_expires")
                  : formatDateTime(token.expires_at)}
              </td>
              <td>
                {token.revoked_at !== null ? (
                  <Badge tone="danger">{t("access.state_revoked")}</Badge>
                ) : (
                  <Badge tone="success">{t("access.state_active")}</Badge>
                )}
              </td>
              <td className="pcms-actions-row">
                {token.revoked_at === null ? (
                  <IconButton
                    small
                    variant="danger"
                    icon="unlink"
                    label={t("access.revoke_token")}
                    onClick={async () => {
                      try {
                        await apiPost(`/access-tokens/${token.id}/revoke`, {
                          reason: t("access.revoke_reason"),
                        });
                        toast(t("access.token_revoked"), "success");
                        load();
                      } catch {
                        toast(t("access.operation_failed"), "error");
                      }
                    }}
                  />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TokenWizard(props: {
  readonly account: AccountWire;
  readonly onClose: () => void;
  readonly onCreated: (secret: { prefix: string; raw: string }) => void;
}) {
  const toast = useToast();
  const [api, setApi] = useState<AccessApi | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [description, setDescription] = useState("");
  const [ttl, setTtl] = useState("720");
  const [permanent, setPermanent] = useState(false);
  useEffect(() => {
    void apiGet<AccessApi>("/roles").then(setApi);
  }, []);
  if (api === null) return <Spinner />;
  // A token scope may never exceed the account ceiling: presets are picked
  // through the same filter so an over-broad preset cannot break the issue.
  const withinCeiling = (key: string): boolean =>
    props.account.allowed_scopes === null || props.account.allowed_scopes.includes(key);
  const toggle = (key: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(key);
    else next.delete(key);
    setSelected(next);
  };
  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t("access.new_token_title", { name: props.account.name })}
      wide
      footer={
        <>
          <Button onClick={props.onClose}>{t("access.cancel")}</Button>
          <Button
            variant="primary"
            disabled={selected.size === 0}
            onClick={async () => {
              try {
                const result = await apiPost<{ raw_secret: string; prefix: string }>(
                  `/service-accounts/${props.account.id}/tokens`,
                  {
                    scopes: [...selected],
                    description,
                    ttl_hours: permanent ? null : Number(ttl),
                    allow_permanent: permanent,
                  },
                );
                props.onCreated({ raw: result.raw_secret, prefix: result.prefix });
              } catch (cause) {
                const detail =
                  cause instanceof ApiError
                    ? (errorText(cause.code) ?? cause.message)
                    : (cause as Error).message;
                toast(`${t("access.token_create_failed")}: ${detail}`, "error");
              }
            }}
          >
            {t("access.create_token_button")}
          </Button>
        </>
      }
    >
      <p className="pcms-field__hint">
        {t("access.ceiling_line", {
          scopes:
            props.account.allowed_scopes === null
              ? t("access.all_scopes")
              : props.account.allowed_scopes.join(", "),
        })}
      </p>
      <PresetButtonsRow
        presets={api.presets}
        onPick={(scopes) => setSelected(new Set(scopes.filter(withinCeiling)))}
      />
      <PermissionChecklist
        permissions={api.permissions}
        selected={selected}
        disabledFor={(key) => !withinCeiling(key)}
        onToggle={toggle}
      />
      <Field label={t("access.field_description")}>
        <Input
          value={description}
          maxLength={500}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
      <div className="pcms-actions-row">
        <Field label={t("access.field_ttl")}>
          <Input
            inputMode="numeric"
            value={permanent ? "" : ttl}
            disabled={permanent}
            onChange={(event) => setTtl(event.target.value)}
            style={{ width: "6rem" }}
          />
        </Field>
        <Switch checked={permanent} label={t("access.no_expiry_label")} onChange={setPermanent} />
      </div>
    </Dialog>
  );
}

function CreateAccountDialog(props: {
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t("access.account_title")}
      footer={
        <>
          <Button onClick={props.onClose}>{t("access.cancel")}</Button>
          <Button
            variant="primary"
            disabled={name === "" || purpose === ""}
            onClick={async () => {
              try {
                await apiPost("/service-accounts", { name, purpose });
                toast(t("access.account_created"), "success");
                props.onCreated();
              } catch {
                toast(t("access.account_create_failed"), "error");
              }
            }}
          >
            {t("access.create_button")}
          </Button>
        </>
      }
    >
      <Field label={t("access.field_name")} required>
        <Input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label={t("access.field_purpose")} required>
        <Input
          value={purpose}
          maxLength={500}
          onChange={(event) => setPurpose(event.target.value)}
        />
      </Field>
    </Dialog>
  );
}
