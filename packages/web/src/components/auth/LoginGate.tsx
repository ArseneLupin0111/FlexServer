import { type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { BrandMark } from "../Brand";

export function AuthLoadingScreen() {
  return (
    <main className="grid min-h-screen place-items-center bg-ink text-dim">
      <div
        role="status"
        aria-live="polite"
        className="border border-line bg-panel px-6 py-5 text-base"
      >
        Đang kiểm tra quyền truy cập bảng điều khiển…
      </div>
    </main>
  );
}

export function LoginGate({
  password,
  busy,
  message,
  onPasswordChange,
  onSubmit,
}: {
  password: string;
  busy: boolean;
  message?: string;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <main className="grid min-h-screen place-items-center bg-ink px-4 py-8 text-text">
      <section
        aria-labelledby="login-title"
        className="w-full max-w-sm border border-line bg-panel p-6 sm:p-7"
      >
        <div className="mb-5">
          <Link to="/" aria-label="FlexServer — home" className="flex items-center gap-2.5 focus-visible:outline-2 focus-visible:outline-signal">
            <BrandMark />
            <span className="text-sm font-semibold text-text">FlexServer</span>
          </Link>
          <h1
            id="login-title"
            className="mt-4 text-2xl font-semibold tracking-tight text-text"
          >
            Đăng nhập FlexServer
          </h1>
          <p
            id="login-description"
            className="mt-2 text-base leading-6 text-dim"
          >
            Nhập mật khẩu để truy cập bảng điều khiển.
          </p>
        </div>
        <form
          className="grid gap-4"
          onSubmit={onSubmit}
          aria-busy={busy}
        >
          <div className="grid gap-2">
            <Label htmlFor="dashboard-password" className="text-base text-text">
              Mật khẩu
            </Label>
            <Input
              id="dashboard-password"
              type="password"
              autoComplete="current-password"
              className="h-11 text-base"
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              placeholder="Nhập mật khẩu"
              autoFocus
              aria-invalid={message ? true : undefined}
              aria-describedby={
                message ? "login-description login-error" : "login-description"
              }
            />
          </div>
          {message ? (
            <Alert
              id="login-error"
              variant="destructive"
              className="px-3 py-2 text-sm"
            >
              {message}
            </Alert>
          ) : null}
          <Button type="submit" disabled={busy} className="h-11 w-full text-base">
            {busy ? "Đang xác minh…" : "Đăng nhập"}
          </Button>
        </form>
        <p className="mt-5 text-center text-base">
          <Link
            to="/"
            className="inline-flex min-h-11 items-center text-dim underline underline-offset-4 transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
          >
            ← Về trang chủ
          </Link>
        </p>
      </section>
    </main>
  );
}
