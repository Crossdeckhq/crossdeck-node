/**
 * Runtime info enrichment — the Node SDK equivalent of
 * `@cross-deck/web/src/device-info.ts`.
 *
 * Detects the host platform (Lambda / Firebase Functions v1 / v2 /
 * Cloud Run / Vercel / plain Node), region, service name + version,
 * and instance ID. Auto-merged into every event's `properties` and
 * every captured-error's `runtime` block.
 *
 * Privacy posture (parity with web's device-info.ts):
 *   - No fingerprinting / hardware identifiers.
 *   - No precise geolocation (region only — the platform's own metadata).
 *   - No IP collection (backend logs the request IP for rate-limit
 *     purposes; not stored on the event document).
 *
 * Detection runs ONCE per process — the returned `RuntimeInfo` is a
 * frozen reference cached at module level. Zero per-event overhead.
 * Caller-supplied overrides (serviceName / serviceVersion / appVersion
 * via `CrossdeckServer` options) win over env-derived values on the
 * first call — that's the SDK constructor.
 */

import { hostname as osHostname, platform as osPlatform, release as osRelease } from "node:os";

export type RuntimeHost =
  | "aws-lambda"
  | "azure-functions"
  | "google-app-engine"
  | "firebase-functions-v1"
  | "firebase-functions-v2"
  | "cloud-run"
  | "vercel"
  | "netlify"
  | "heroku"
  | "render"
  | "railway"
  | "fly"
  | "kubernetes"
  | "node";

export interface RuntimeInfo {
  nodeVersion: string;
  /** `os.platform()` — "darwin" | "linux" | "win32" | … */
  platform: string;
  /** `os.release()` — kernel release string, e.g. "5.15.0-1071-aws". */
  platformRelease: string;
  hostname: string;
  host: RuntimeHost;
  region: string | null;
  serviceName: string | null;
  serviceVersion: string | null;
  /**
   * Process-stable ID. Lambda log stream name when on Lambda; revision +
   * pid on Cloud Run / Firebase v2; pid as string otherwise. Used by the
   * dashboard to distinguish events from different instances of the same
   * function name + version.
   */
  instanceId: string | null;
  /** Caller-supplied app version. Attached as `appVersion` on every event. */
  appVersion: string | null;
}

export interface RuntimeInfoOptions {
  serviceName?: string;
  serviceVersion?: string;
  appVersion?: string;
}

let cached: RuntimeInfo | null = null;

/**
 * Collect runtime info. Detection runs once per process; subsequent
 * calls return the same cached frozen object. Caller-supplied options
 * take effect on the FIRST call — that's by design, the SDK constructor
 * passes them once and downstream call sites read.
 */
export function collectRuntimeInfo(options: RuntimeInfoOptions = {}): RuntimeInfo {
  if (cached) return cached;
  cached = detect(options);
  return cached;
}

/**
 * Re-detect. Tests + multi-instance scenarios only. Not called from the
 * SDK boot path — runtime info is logically immutable for a process's
 * lifetime.
 */
export function resetRuntimeInfoCache(): void {
  cached = null;
}

function detect(options: RuntimeInfoOptions): RuntimeInfo {
  // Defensive: edge runtimes (Workers, Bun-in-some-configs, sandboxed
  // hosts) may have a partial or absent `process` object. Fall back
  // to an empty env so detection just returns the "node" host.
  const env: NodeJS.ProcessEnv =
    typeof process !== "undefined" && process.env ? process.env : ({} as NodeJS.ProcessEnv);
  const detected = detectHost(env);
  return Object.freeze({
    nodeVersion: typeof process !== "undefined" && process.versions ? process.versions.node : "unknown",
    platform: safePlatform(),
    platformRelease: safeRelease(),
    hostname: safeHostname(),
    host: detected.host,
    region: detected.region,
    serviceName: options.serviceName ?? detected.serviceName,
    serviceVersion: options.serviceVersion ?? detected.serviceVersion,
    instanceId: detected.instanceId,
    appVersion: options.appVersion ?? null,
  });
}

interface HostDetection {
  host: RuntimeHost;
  region: string | null;
  serviceName: string | null;
  serviceVersion: string | null;
  instanceId: string | null;
}

/**
 * Host detection — order matters. More-specific signals first:
 *   - AWS Lambda: `AWS_LAMBDA_FUNCTION_NAME` (unique to Lambda).
 *   - Azure Functions: `FUNCTIONS_WORKER_RUNTIME` + `WEBSITE_INSTANCE_ID`.
 *   - Google App Engine: `GAE_APPLICATION` (gen-1 + gen-2 standard) —
 *     checked before K_SERVICE because GAE gen-2 sets BOTH and we
 *     want the more specific label.
 *   - Firebase v2 / Cloud Run: share `K_SERVICE` + `K_REVISION`. The
 *     difference is `FIREBASE_CONFIG` / `GCLOUD_PROJECT` (set by the
 *     Firebase deploy chain, not by plain Cloud Run).
 *   - Firebase v1: `FUNCTION_NAME` + `FUNCTION_REGION` (the legacy
 *     pair, still used by gen-1 deployments).
 *   - Vercel: `VERCEL === "1"`.
 *   - Netlify Functions: `NETLIFY === "true"` or `AWS_LAMBDA_FUNCTION_NAME`
 *     prefixed (Netlify runs on Lambda under the hood but we already
 *     captured Lambda first; the `NETLIFY=true` check identifies
 *     Netlify Functions specifically when Lambda env vars aren't set).
 *   - Heroku: `DYNO` (the dyno identifier; uniquely Heroku).
 *   - Render: `RENDER === "true"` + `RENDER_INSTANCE_ID`.
 *   - Railway: `RAILWAY_ENVIRONMENT`.
 *   - Fly.io: `FLY_APP_NAME` + `FLY_REGION`.
 *   - Kubernetes: `KUBERNETES_SERVICE_HOST` — generic fallback for
 *     containerised Node not on a more-specific platform.
 *   - Else: plain Node — long-lived servers, dev machines, test runs.
 */
function detectHost(env: NodeJS.ProcessEnv): HostDetection {
  const pid = safePid();

  if (env.AWS_LAMBDA_FUNCTION_NAME) {
    return {
      host: "aws-lambda",
      region: env.AWS_REGION ?? null,
      serviceName: env.AWS_LAMBDA_FUNCTION_NAME,
      serviceVersion: env.AWS_LAMBDA_FUNCTION_VERSION ?? null,
      instanceId: env.AWS_LAMBDA_LOG_STREAM_NAME ?? pid,
    };
  }

  if (env.FUNCTIONS_WORKER_RUNTIME && env.WEBSITE_INSTANCE_ID) {
    return {
      host: "azure-functions",
      region: env.REGION_NAME ?? env.WEBSITE_LOCATION ?? null,
      serviceName: env.WEBSITE_SITE_NAME ?? null,
      serviceVersion: env.WEBSITE_BUILD_ID ?? null,
      instanceId: env.WEBSITE_INSTANCE_ID,
    };
  }

  if (env.GAE_APPLICATION) {
    return {
      host: "google-app-engine",
      region: env.GAE_REGION ?? env.GOOGLE_CLOUD_REGION ?? null,
      serviceName: env.GAE_SERVICE ?? null,
      serviceVersion: env.GAE_VERSION ?? null,
      instanceId: env.GAE_INSTANCE ?? pid,
    };
  }

  if (env.K_SERVICE && env.K_REVISION) {
    const isFirebase = Boolean(env.FIREBASE_CONFIG || env.GCLOUD_PROJECT);
    return {
      host: isFirebase ? "firebase-functions-v2" : "cloud-run",
      region: env.FUNCTION_REGION ?? env.GOOGLE_CLOUD_REGION ?? null,
      serviceName: env.K_SERVICE,
      serviceVersion: env.K_REVISION,
      instanceId: `${env.K_REVISION}:${pid}`,
    };
  }

  if (env.FUNCTION_NAME && env.FUNCTION_REGION) {
    return {
      host: "firebase-functions-v1",
      region: env.FUNCTION_REGION,
      serviceName: env.FUNCTION_NAME,
      serviceVersion: env.X_GOOGLE_FUNCTION_VERSION ?? null,
      instanceId: pid,
    };
  }

  if (env.VERCEL === "1") {
    return {
      host: "vercel",
      region: env.VERCEL_REGION ?? null,
      serviceName: env.VERCEL_URL ?? null,
      serviceVersion: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      instanceId: pid,
    };
  }

  if (env.NETLIFY === "true" || env.NETLIFY_BUILD_BASE) {
    return {
      host: "netlify",
      region: env.AWS_REGION ?? null,
      serviceName: env.SITE_NAME ?? env.SITE_ID ?? null,
      serviceVersion: env.COMMIT_REF?.slice(0, 7) ?? null,
      instanceId: pid,
    };
  }

  if (env.DYNO) {
    return {
      host: "heroku",
      region: null,
      serviceName: env.HEROKU_APP_NAME ?? null,
      serviceVersion: env.HEROKU_RELEASE_VERSION ?? env.HEROKU_SLUG_COMMIT?.slice(0, 7) ?? null,
      instanceId: env.DYNO,
    };
  }

  if (env.RENDER === "true" || env.RENDER_INSTANCE_ID) {
    return {
      host: "render",
      region: env.RENDER_SERVICE_REGION ?? null,
      serviceName: env.RENDER_SERVICE_NAME ?? null,
      serviceVersion: env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
      instanceId: env.RENDER_INSTANCE_ID ?? pid,
    };
  }

  if (env.RAILWAY_ENVIRONMENT) {
    return {
      host: "railway",
      region: env.RAILWAY_REGION ?? null,
      serviceName: env.RAILWAY_SERVICE_NAME ?? null,
      serviceVersion: env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      instanceId: env.RAILWAY_REPLICA_ID ?? pid,
    };
  }

  if (env.FLY_APP_NAME) {
    return {
      host: "fly",
      region: env.FLY_REGION ?? null,
      serviceName: env.FLY_APP_NAME,
      serviceVersion: env.FLY_IMAGE_REF?.slice(-7) ?? null,
      instanceId: env.FLY_ALLOC_ID ?? pid,
    };
  }

  if (env.KUBERNETES_SERVICE_HOST) {
    return {
      host: "kubernetes",
      region: null,
      serviceName: env.POD_NAME ?? env.HOSTNAME ?? null,
      serviceVersion: null,
      instanceId: env.POD_NAME ?? env.HOSTNAME ?? pid,
    };
  }

  return {
    host: "node",
    region: null,
    serviceName: null,
    serviceVersion: null,
    instanceId: pid,
  };
}

function safeHostname(): string {
  try {
    return osHostname();
  } catch {
    return "unknown";
  }
}

function safePlatform(): string {
  try {
    return osPlatform();
  } catch {
    return "unknown";
  }
}

function safeRelease(): string {
  try {
    return osRelease();
  } catch {
    return "unknown";
  }
}

function safePid(): string {
  try {
    return typeof process !== "undefined" && process.pid ? String(process.pid) : "0";
  } catch {
    return "0";
  }
}

/**
 * Flatten `RuntimeInfo` into a property bag suitable for merging onto
 * every event. Keys are namespaced under `runtime.*` to keep top-level
 * event properties clean and to match the dashboard's runtime column
 * group.
 *
 * Null fields are omitted so downstream property bags don't fill with
 * empty columns.
 */
export function runtimeInfoToProperties(info: RuntimeInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {
    "runtime.nodeVersion": info.nodeVersion,
    "runtime.platform": info.platform,
    "runtime.platformRelease": info.platformRelease,
    "runtime.hostname": info.hostname,
    "runtime.host": info.host,
  };
  if (info.region) out["runtime.region"] = info.region;
  if (info.serviceName) out["runtime.serviceName"] = info.serviceName;
  if (info.serviceVersion) out["runtime.serviceVersion"] = info.serviceVersion;
  if (info.instanceId) out["runtime.instanceId"] = info.instanceId;
  if (info.appVersion) out.appVersion = info.appVersion;
  return out;
}
