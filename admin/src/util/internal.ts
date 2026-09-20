import axios, { AxiosError, type AxiosRequestConfig } from "axios";

// ─── Internal service clients ───────────────────────────────
// The admin service owns no data of its own: every read/write goes through
// the service that owns the collection, using the platform's shared
// x-internal-key contract. Env vars are read per call (dotenv.config() runs
// after this module is imported).

const internalHeaders = () => ({
  "x-internal-key": process.env.INTERNAL_SERVICE_KEY,
});

const requireServiceUrl = (envVar: string) => {
  const url = process.env[envVar];
  if (!url) {
    throw new Error(`${envVar} is not configured`);
  }
  return url.replace(/\/+$/, "");
};

// Owning services — referenced by env var name so the URL is always read
// fresh (never captured at module load, before dotenv runs).
export const AUTH_SERVICE = "AUTH_SERVICE_URL";
export const RESTAURANT_SERVICE = "RESTAURANT_SERVICE_URL";
export const RIDER_SERVICE = "RIDER_SERVICE_URL";

// Surface the owning service's real error (404 not found, 400 invalid id,
// 403 forbidden) instead of flattening everything into a generic 500.
export class ServiceError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
  }
}

const toServiceError = (err: unknown): Error => {
  if (err instanceof AxiosError) {
    const status = err.response?.status;
    const message =
      (err.response?.data as { message?: string } | undefined)?.message ??
      err.message;
    if (status) {
      return new ServiceError(status, message);
    }
    // No response → owning service is unreachable
    return new Error(`Owning service unreachable: ${message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
};

export const internalGet = async <T>(
  serviceEnv: string,
  path: string,
  config: AxiosRequestConfig = {},
): Promise<T> => {
  try {
    const { data } = await axios.get<T>(
      `${requireServiceUrl(serviceEnv)}${path}`,
      {
        headers: internalHeaders(),
        ...config,
      },
    );
    return data;
  } catch (err) {
    throw toServiceError(err);
  }
};

export const internalPatch = async <T>(
  serviceEnv: string,
  path: string,
  body: unknown = {},
): Promise<T> => {
  try {
    const { data } = await axios.patch<T>(
      `${requireServiceUrl(serviceEnv)}${path}`,
      body,
      { headers: internalHeaders() },
    );
    return data;
  } catch (err) {
    throw toServiceError(err);
  }
};
