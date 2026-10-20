// Session/auth state for the Admin (PCMS-ADMIN-T001; M08/M09 browser flow).
// The server is the authority — this context only projects `/actor` for the
// shell and keeps the CSRF token in memory between reloads via rotation.
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiGet, apiPost, setCsrfToken, UNAUTHENTICATED_EVENT } from "../api/client.js";
import type { ActorInfo, LoginResponse } from "../api/types.js";

type AuthState =
  | { readonly status: "loading" }
  | { readonly status: "anonymous" }
  | { readonly status: "mfa"; readonly userId: string }
  | { readonly status: "authed"; readonly actor: ActorInfo };

interface AuthApi {
  readonly state: AuthState;
  readonly login: (email: string, password: string) => Promise<void>;
  readonly confirmMfa: (code: string) => Promise<void>;
  readonly logout: () => Promise<void>;
  /** True when the actor holds every listed permission key. */
  readonly can: (...permissions: readonly string[]) => boolean;
}

const AuthContext = createContext<AuthApi | null>(null);

export function useAuth(): AuthApi {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return value;
}

export function AuthProvider(props: { readonly children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const stateRef = useRef<AuthState>(state);
  stateRef.current = state;

  const enter = useCallback(async () => {
    const actor = await apiGet<ActorInfo>("/actor");
    setState({ status: "authed", actor });
  }, []);

  // Bootstrap: an existing session re-acquires its CSRF token by rotating
  // (M08 spec §31 rotation — the old session is revoked, strength carried).
  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      try {
        await apiGet<ActorInfo>("/actor");
      } catch {
        if (!cancelled) setState({ status: "anonymous" });
        return;
      }
      try {
        const rotated = await apiPost<LoginResponse>("/auth/session/rotate");
        setCsrfToken(rotated.csrf_token);
        if (!cancelled) await enter();
      } catch {
        if (!cancelled) setState({ status: "anonymous" });
      }
    };
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [enter]);

  // Server-driven expiry: any 401 moves the shell back to the login screen.
  useEffect(() => {
    const onUnauthenticated = () => {
      setCsrfToken(null);
      if (stateRef.current.status !== "anonymous") {
        setState({ status: "anonymous" });
      }
    };
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await apiPost<LoginResponse>("/auth/login", { email, password });
      if (result.stage === "PASSWORD_OK_PENDING_MFA") {
        setCsrfToken(result.csrf_token);
        setState({ status: "mfa", userId: result.user_id });
        return;
      }
      setCsrfToken(result.csrf_token);
      await enter();
    },
    [enter],
  );

  const confirmMfa = useCallback(
    async (code: string) => {
      await apiPost("/auth/mfa", { code });
      await enter();
    },
    [enter],
  );

  const logout = useCallback(async () => {
    try {
      await apiPost("/auth/logout");
    } finally {
      setCsrfToken(null);
      setState({ status: "anonymous" });
    }
  }, []);

  const api = useMemo<AuthApi>(
    () => ({
      state,
      login,
      confirmMfa,
      logout,
      can: (...permissions) => {
        if (state.status !== "authed") return false;
        return permissions.every((permission) => state.actor.permissions.includes(permission));
      },
    }),
    [state, login, confirmMfa, logout],
  );

  return <AuthContext.Provider value={api}>{props.children}</AuthContext.Provider>;
}
