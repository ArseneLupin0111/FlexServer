import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Route, Routes } from "react-router-dom";
import { DashboardProvider } from "./context/DashboardContext";
import {
  VpsWorkspaceAuditPage,
  VpsWorkspaceDockerContainerPage,
  VpsWorkspaceDockerPage,
  VpsWorkspaceJobsPage,
  VpsWorkspaceLayout,
  VpsWorkspaceMetricsPage,
  VpsWorkspaceOverviewPage,
  VpsWorkspaceSettingsPage,
  VpsWorkspaceTerminalPage,
} from "./context/VpsWorkspaceContext";
import {
  DashboardLayout,
  NotFoundPage,
  VpsListPage,
  VpsNewPage,
} from "./pages/Pages";
import { AuthLoadingScreen, LoginGate } from "./components/auth/LoginGate";
import { getAuthStatus, loginWithDashboardPassword } from "./lib/api";

// ── Auth state type ─────────────────────────────────────────────────

type AuthState =
  | { status: "checking" }
  | { status: "open"; mode: "demo" | "local"; authRequired: boolean }
  | { status: "locked"; mode: "demo" | "local"; message?: string };

function toSafeAuthMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const hint = error.message.toLowerCase();
  if (hint.includes("invalid credentials")) {
    return "Sai mật khẩu. Vui lòng kiểm tra lại và thử lại.";
  }
  if (hint.includes("too many login attempts") || hint.includes("429")) {
    return "Quá nhiều lần thử. Vui lòng đợi vài phút rồi thử lại.";
  }
  if (
    hint.includes("not configured") ||
    hint.includes("503") ||
    hint.includes("rate limiter unavailable")
  ) {
    return "Dịch vụ đăng nhập tạm thời không khả dụng. Vui lòng thử lại sau.";
  }
  if (
    hint.includes("timed out") ||
    hint.includes("connectivity") ||
    hint.includes("failed to fetch") ||
    hint.includes("network")
  ) {
    return "Không thể kết nối máy chủ. Vui lòng thử lại sau.";
  }
  return fallback;
}

export default function DashboardApp() {
  const [authState, setAuthState] = useState<AuthState>({
    status: "checking",
  });
  const [loginPassword, setLoginPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAuthStatus()
      .then(async (auth) => {
        if (cancelled) return;
        if (!auth.authRequired || auth.authenticated) {
          setAuthState({
            status: "open",
            mode: auth.mode,
            authRequired: auth.authRequired,
          });
          return;
        }
        setAuthState({ status: "locked", mode: auth.mode });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setAuthState({
          status: "locked",
          mode: "local",
          message: toSafeAuthMessage(
            error,
            "Không thể xác minh quyền truy cập. Vui lòng thử lại sau.",
          ),
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = loginPassword.trim();
    if (!password) {
      setAuthState({
        status: "locked",
        mode: "local",
        message: "Vui lòng nhập mật khẩu để tiếp tục.",
      });
      return;
    }
    setLoginBusy(true);
    try {
      const auth = await loginWithDashboardPassword(password);
      setLoginPassword("");
      setAuthState({
        status: "open",
        mode: auth.mode,
        authRequired: auth.authRequired,
      });
    } catch (error) {
      setAuthState({
        status: "locked",
        mode: "local",
        message: toSafeAuthMessage(
          error,
          "Không thể đăng nhập. Vui lòng thử lại sau.",
        ),
      });
    } finally {
      setLoginBusy(false);
    }
  }

  if (authState.status === "checking") return <AuthLoadingScreen />;
  if (authState.status === "locked") {
    return (
      <LoginGate
        password={loginPassword}
        busy={loginBusy}
        message={authState.message}
        onPasswordChange={setLoginPassword}
        onSubmit={handleLogin}
      />
    );
  }

  return (
    <DashboardProvider
      authRequired={authState.authRequired}
      onAfterLogout={
        authState.authRequired
          ? () => {
              setAuthState((prev) => ({
                status: "locked",
                mode: prev.status === "open" ? prev.mode : "local",
              }));
            }
          : undefined
      }
    >
      <Routes>
        <Route element={<DashboardLayout />}>
          <Route path="/vps" element={<VpsListPage />} />
          <Route path="/vps/new" element={<VpsNewPage />} />
          <Route path="/vps/:vpsId" element={<VpsWorkspaceLayout />}>
            <Route index element={<VpsWorkspaceOverviewPage />} />
            <Route path="metrics" element={<VpsWorkspaceMetricsPage />} />
            <Route path="docker" element={<VpsWorkspaceDockerPage />} />
            <Route
              path="docker/containers/:agentInstanceId/:containerKey"
              element={<VpsWorkspaceDockerContainerPage />}
            />
            <Route path="jobs" element={<VpsWorkspaceJobsPage />} />
            <Route path="audit" element={<VpsWorkspaceAuditPage />} />
            <Route path="terminal" element={<VpsWorkspaceTerminalPage />} />
            <Route path="settings" element={<VpsWorkspaceSettingsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </DashboardProvider>
  );
}
