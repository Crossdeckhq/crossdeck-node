import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectRuntimeInfo, resetRuntimeInfoCache } from "../src/runtime-info";

const HOST_ENV_KEYS = [
  "AWS_LAMBDA_FUNCTION_NAME",
  "AWS_LAMBDA_FUNCTION_VERSION",
  "AWS_LAMBDA_LOG_STREAM_NAME",
  "AWS_REGION",
  "K_SERVICE",
  "K_REVISION",
  "K_CONFIGURATION",
  "GOOGLE_CLOUD_REGION",
  "FIREBASE_CONFIG",
  "GCLOUD_PROJECT",
  "FUNCTION_NAME",
  "FUNCTION_REGION",
  "X_GOOGLE_FUNCTION_VERSION",
  "VERCEL",
  "VERCEL_REGION",
  "VERCEL_URL",
  "VERCEL_GIT_COMMIT_SHA",
] as const;

function clearHostEnv(): void {
  for (const key of HOST_ENV_KEYS) {
    delete process.env[key];
  }
}

describe("collectRuntimeInfo — Node basics", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    clearHostEnv();
    resetRuntimeInfoCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetRuntimeInfoCache();
  });

  it("returns nodeVersion from process.versions.node", () => {
    expect(collectRuntimeInfo().nodeVersion).toBe(process.versions.node);
  });

  it("returns os.platform + os.release", () => {
    const info = collectRuntimeInfo();
    expect(info.platform).toBeTypeOf("string");
    expect(info.platform.length).toBeGreaterThan(0);
    expect(info.platformRelease).toBeTypeOf("string");
  });

  it("returns os.hostname()", () => {
    expect(collectRuntimeInfo().hostname).toBeTypeOf("string");
  });

  it("returns process.pid as instanceId base when no platform signal", () => {
    expect(collectRuntimeInfo().instanceId).toBe(String(process.pid));
  });
});

describe("collectRuntimeInfo — serverless host detection", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    clearHostEnv();
    resetRuntimeInfoCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetRuntimeInfoCache();
  });

  it("detects AWS Lambda via AWS_LAMBDA_FUNCTION_NAME → host: 'aws-lambda', functionName, region (AWS_REGION)", () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "my-fn";
    process.env.AWS_LAMBDA_FUNCTION_VERSION = "42";
    process.env.AWS_LAMBDA_LOG_STREAM_NAME = "log-stream-id";
    process.env.AWS_REGION = "us-east-1";
    const info = collectRuntimeInfo();
    expect(info.host).toBe("aws-lambda");
    expect(info.serviceName).toBe("my-fn");
    expect(info.serviceVersion).toBe("42");
    expect(info.region).toBe("us-east-1");
    expect(info.instanceId).toBe("log-stream-id");
  });

  it("detects Firebase / Cloud Functions v2 via K_SERVICE + K_REVISION + FIREBASE_CONFIG → host: 'firebase-functions-v2'", () => {
    process.env.K_SERVICE = "my-fn";
    process.env.K_REVISION = "my-fn-00007-abc";
    process.env.FIREBASE_CONFIG = '{"projectId":"proj"}';
    process.env.FUNCTION_REGION = "us-central1";
    const info = collectRuntimeInfo();
    expect(info.host).toBe("firebase-functions-v2");
    expect(info.serviceName).toBe("my-fn");
    expect(info.serviceVersion).toBe("my-fn-00007-abc");
    expect(info.region).toBe("us-central1");
  });

  it("detects Cloud Run via K_SERVICE + K_REVISION (without FIREBASE_CONFIG/GCLOUD_PROJECT) → host: 'cloud-run'", () => {
    process.env.K_SERVICE = "my-svc";
    process.env.K_REVISION = "my-svc-00001";
    process.env.GOOGLE_CLOUD_REGION = "us-central1";
    const info = collectRuntimeInfo();
    expect(info.host).toBe("cloud-run");
    expect(info.serviceName).toBe("my-svc");
    expect(info.serviceVersion).toBe("my-svc-00001");
  });

  it("detects Firebase Functions v1 via FUNCTION_NAME + FUNCTION_REGION → host: 'firebase-functions-v1'", () => {
    process.env.FUNCTION_NAME = "my-fn";
    process.env.FUNCTION_REGION = "us-central1";
    process.env.X_GOOGLE_FUNCTION_VERSION = "v1.0";
    const info = collectRuntimeInfo();
    expect(info.host).toBe("firebase-functions-v1");
    expect(info.serviceName).toBe("my-fn");
    expect(info.serviceVersion).toBe("v1.0");
    expect(info.region).toBe("us-central1");
  });

  it("detects Vercel via VERCEL === '1' → host: 'vercel'", () => {
    process.env.VERCEL = "1";
    process.env.VERCEL_REGION = "iad1";
    process.env.VERCEL_URL = "my-app.vercel.app";
    process.env.VERCEL_GIT_COMMIT_SHA = "abcdef1234567890";
    const info = collectRuntimeInfo();
    expect(info.host).toBe("vercel");
    expect(info.region).toBe("iad1");
    expect(info.serviceName).toBe("my-app.vercel.app");
    // SHA is truncated to 7 chars
    expect(info.serviceVersion).toBe("abcdef1");
  });

  it("falls back to host: 'node' when no serverless env var is present", () => {
    expect(collectRuntimeInfo().host).toBe("node");
  });

  it("detects Azure Functions via FUNCTIONS_WORKER_RUNTIME + WEBSITE_INSTANCE_ID → 'azure-functions'", () => {
    process.env.FUNCTIONS_WORKER_RUNTIME = "node";
    process.env.WEBSITE_INSTANCE_ID = "instance_abc";
    process.env.WEBSITE_SITE_NAME = "my-app";
    process.env.WEBSITE_BUILD_ID = "build_42";
    process.env.REGION_NAME = "westus2";
    const info = collectRuntimeInfo();
    expect(info.host).toBe("azure-functions");
    expect(info.serviceName).toBe("my-app");
    expect(info.serviceVersion).toBe("build_42");
    expect(info.region).toBe("westus2");
    expect(info.instanceId).toBe("instance_abc");
  });

  it("detects Google App Engine via GAE_APPLICATION → 'google-app-engine' (precedence over K_SERVICE)", () => {
    process.env.GAE_APPLICATION = "s~my-project";
    process.env.GAE_SERVICE = "default";
    process.env.GAE_VERSION = "v7";
    process.env.GAE_INSTANCE = "instance_xyz";
    // Even with K_SERVICE set (gen-2 GAE), the GAE_APPLICATION env var
    // takes precedence.
    process.env.K_SERVICE = "default";
    process.env.K_REVISION = "v7-001";
    const info = collectRuntimeInfo();
    expect(info.host).toBe("google-app-engine");
    expect(info.serviceName).toBe("default");
    expect(info.serviceVersion).toBe("v7");
    expect(info.instanceId).toBe("instance_xyz");
  });

  it("detects Netlify Functions via NETLIFY='true' → 'netlify'", () => {
    process.env.NETLIFY = "true";
    process.env.SITE_NAME = "my-site";
    process.env.COMMIT_REF = "abcdef1234567890";
    const info = collectRuntimeInfo();
    expect(info.host).toBe("netlify");
    expect(info.serviceName).toBe("my-site");
    expect(info.serviceVersion).toBe("abcdef1");
  });

  it("detects Heroku via DYNO → 'heroku'", () => {
    process.env.DYNO = "web.1";
    process.env.HEROKU_APP_NAME = "my-app";
    process.env.HEROKU_RELEASE_VERSION = "v42";
    const info = collectRuntimeInfo();
    expect(info.host).toBe("heroku");
    expect(info.serviceName).toBe("my-app");
    expect(info.serviceVersion).toBe("v42");
    expect(info.instanceId).toBe("web.1");
  });

  it("detects Render via RENDER='true' → 'render'", () => {
    process.env.RENDER = "true";
    process.env.RENDER_SERVICE_NAME = "my-svc";
    process.env.RENDER_INSTANCE_ID = "instance_abc";
    process.env.RENDER_GIT_COMMIT = "abcdef1234567890";
    process.env.RENDER_SERVICE_REGION = "oregon";
    const info = collectRuntimeInfo();
    expect(info.host).toBe("render");
    expect(info.serviceName).toBe("my-svc");
    expect(info.serviceVersion).toBe("abcdef1");
    expect(info.region).toBe("oregon");
    expect(info.instanceId).toBe("instance_abc");
  });

  it("detects Railway via RAILWAY_ENVIRONMENT → 'railway'", () => {
    process.env.RAILWAY_ENVIRONMENT = "production";
    process.env.RAILWAY_SERVICE_NAME = "my-svc";
    process.env.RAILWAY_GIT_COMMIT_SHA = "abcdef1234567890";
    process.env.RAILWAY_REGION = "us-west1";
    process.env.RAILWAY_REPLICA_ID = "replica_x";
    const info = collectRuntimeInfo();
    expect(info.host).toBe("railway");
    expect(info.serviceName).toBe("my-svc");
    expect(info.serviceVersion).toBe("abcdef1");
    expect(info.region).toBe("us-west1");
    expect(info.instanceId).toBe("replica_x");
  });

  it("detects Fly.io via FLY_APP_NAME → 'fly'", () => {
    process.env.FLY_APP_NAME = "my-app";
    process.env.FLY_REGION = "iad";
    process.env.FLY_ALLOC_ID = "alloc_abc";
    process.env.FLY_IMAGE_REF = "registry.fly.io/my-app:deployment-01HXYZ123";
    const info = collectRuntimeInfo();
    expect(info.host).toBe("fly");
    expect(info.serviceName).toBe("my-app");
    expect(info.region).toBe("iad");
    expect(info.instanceId).toBe("alloc_abc");
  });

  it("detects generic Kubernetes via KUBERNETES_SERVICE_HOST → 'kubernetes' (fallback for containerised Node)", () => {
    process.env.KUBERNETES_SERVICE_HOST = "10.96.0.1";
    process.env.POD_NAME = "my-app-deployment-abc-xyz";
    const info = collectRuntimeInfo();
    expect(info.host).toBe("kubernetes");
    expect(info.serviceName).toBe("my-app-deployment-abc-xyz");
    expect(info.instanceId).toBe("my-app-deployment-abc-xyz");
  });

  it("detection priority — AWS Lambda wins over K_SERVICE if both are set", () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "my-lambda";
    process.env.K_SERVICE = "should-be-ignored";
    process.env.K_REVISION = "rev-1";
    expect(collectRuntimeInfo().host).toBe("aws-lambda");
  });
});

describe("collectRuntimeInfo — caller overrides", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    clearHostEnv();
    resetRuntimeInfoCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetRuntimeInfoCache();
  });

  it("explicit serviceName option wins over env-derived value", () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "from-env";
    const info = collectRuntimeInfo({ serviceName: "from-caller" });
    expect(info.serviceName).toBe("from-caller");
  });

  it("explicit serviceVersion option wins over env-derived value", () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "fn";
    process.env.AWS_LAMBDA_FUNCTION_VERSION = "from-env";
    const info = collectRuntimeInfo({ serviceVersion: "from-caller" });
    expect(info.serviceVersion).toBe("from-caller");
  });

  it("explicit appVersion option is attached as appVersion (parity with web)", () => {
    const info = collectRuntimeInfo({ appVersion: "1.2.3" });
    expect(info.appVersion).toBe("1.2.3");
  });
});

describe("Output stability", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    clearHostEnv();
    resetRuntimeInfoCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetRuntimeInfoCache();
  });

  it("returns the SAME object reference across calls within one process (zero per-event overhead)", () => {
    const a = collectRuntimeInfo();
    const b = collectRuntimeInfo();
    expect(a).toBe(b);
  });

  it("never throws — a missing env var or platform API falls through to partial info", () => {
    expect(() => collectRuntimeInfo()).not.toThrow();
  });
});
