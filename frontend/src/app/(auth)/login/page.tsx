// ============================================================
// Foodo — Login Page
// ============================================================

"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Eye, EyeOff, LogIn, User, Store, Bike, Zap } from "lucide-react";
import { loginSchema, type LoginFormValues } from "@/features/auth/schemas";
import { useLogin } from "@/features/auth/api";
import { useAuthStore } from "@/store/auth-store";
import type { IAuthResponse, IUser, UserRole } from "@/types";

// ─── Demo accounts (one per role) ────────────────────────────
// These users are seeded automatically by the auth service at startup
// (auth/src/seed/demo-users.ts), so real login always works.

interface DemoAccount {
  role: UserRole;
  label: string;
  subtitle: string;
  name: string;
  email: string;
  password: string;
  redirectTo: string;
  icon: React.ComponentType<{ className?: string }>;
  badge: string;
}

const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    role: "customer",
    label: "Customer",
    subtitle: "Browse & order food",
    name: "Demo Customer",
    email: "customer@demo.com",
    password: "customer123",
    redirectTo: "/",
    icon: User,
    badge: "bg-primary/10 text-primary",
  },
  {
    role: "seller",
    label: "Restaurant",
    subtitle: "Manage menu & orders",
    name: "Demo Restaurant",
    email: "restaurant@demo.com",
    password: "restaurant123",
    redirectTo: "/seller",
    icon: Store,
    badge: "bg-secondary text-secondary-foreground",
  },
  {
    role: "rider",
    label: "Rider",
    subtitle: "Deliver orders & earn",
    name: "Demo Rider",
    email: "rider@demo.com",
    password: "rider123",
    redirectTo: "/rider",
    icon: Bike,
    badge: "bg-primary/10 text-primary",
  },
];

export default function LoginPage() {
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);
  const login = useLogin();
  const { setUser } = useAuthStore();

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
  });

  const routeForRole = (role?: string) =>
    role === "seller"
      ? "/seller"
      : role === "rider"
        ? "/rider"
        : role === "admin"
          ? "/admin"
          : "/";

  const onSubmit = async (data: LoginFormValues) => {
    try {
      const result = await login.mutateAsync(data) as IAuthResponse;
      router.push(routeForRole(result?.user?.role));
    } catch (err: unknown) {
      console.error("Login failed:", err);
    }
  };

  // ─── Demo login: real auth against the seeded demo account ──
  // Falls back to a local mock user if the auth server isn't running,
  // so the UI stays explorable offline.
  const handleDemoLogin = async (account: DemoAccount) => {
    try {
      const result = await login.mutateAsync({
        email: account.email,
        password: account.password,
      }) as IAuthResponse;
      router.push(routeForRole(result?.user?.role));
    } catch (err: unknown) {
      console.warn(
        `[Demo Login] Server login failed for ${account.email}, using local mock user:`,
        err,
      );
      const mockUser: IUser = {
        _id: `demo-${account.role}`,
        name: account.name,
        email: account.email,
        role: account.role,
      };
      setUser(mockUser);
      router.push(account.redirectTo);
    }
  };

  // Fill the form with a demo account's credentials
  const handleFillCredentials = (account: DemoAccount) => {
    setValue("email", account.email, { shouldValidate: true });
    setValue("password", account.password, { shouldValidate: true });
  };

  return (
    <div>
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold">Welcome back</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Sign in to your account
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div>
          <label
            htmlFor="email"
            className="block text-sm font-medium mb-1.5"
          >
            Email
          </label>
          <input
            id="email"
            type="email"
            {...register("email")}
            className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="you@example.com"
          />
          {errors.email && (
            <p className="mt-1 text-xs text-destructive">
              {errors.email.message}
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor="password"
            className="block text-sm font-medium mb-1.5"
          >
            Password
          </label>
          <div className="relative">
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              {...register("password")}
              className="w-full rounded-xl border border-border bg-background px-4 py-2.5 pr-10 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="••••••••"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              tabIndex={-1}
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
          {errors.password && (
            <p className="mt-1 text-xs text-destructive">
              {errors.password.message}
            </p>
          )}
        </div>

        <Button
          type="submit"
          className="w-full h-11"
          disabled={login.isPending}
        >
          {login.isPending ? (
            <span className="flex items-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-background border-t-transparent" />
              Signing in...
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <LogIn className="h-4 w-4" />
              Sign In
            </span>
          )}
        </Button>
      </form>

      {login.error && (
        <p className="mt-4 text-center text-sm text-destructive">
          {(login.error as Error).message}
        </p>
      )}

      {/* ─── Demo Roles — Quick Demo Access ────────────────── */}
      <div className="my-6 flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Zap className="h-3.5 w-3.5" />
          Demo Login
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <div className="space-y-2.5">
        {DEMO_ACCOUNTS.map((account) => {
          const Icon = account.icon;
          return (
            <div
              key={account.role}
              className="flex items-center gap-3 rounded-xl border border-border bg-background p-3 transition-colors hover:bg-accent/50"
            >
              <div
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${account.badge}`}
              >
                <Icon className="h-4.5 w-4.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold">{account.label}</p>
                  <span className="hidden truncate text-xs text-muted-foreground sm:block">
                    {account.email}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {account.subtitle}
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleFillCredentials(account)}
                className="hidden shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground sm:block"
                title="Fill credentials into the form"
              >
                Fill
              </button>
              <Button
                type="button"
                size="sm"
                className="shrink-0 h-8"
                disabled={login.isPending}
                onClick={() => handleDemoLogin(account)}
              >
                {login.isPending ? (
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-background border-t-transparent" />
                ) : (
                  "Get Logged In"
                )}
              </Button>
            </div>
          );
        })}
      </div>
      

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Don&apos;t have an account?{" "}
        <Link
          href="/register"
          className="font-medium text-primary hover:underline"
        >
          Sign up
        </Link>
      </p>
    </div>
  );
}
