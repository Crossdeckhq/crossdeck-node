import { beforeEach } from "vitest";
import { CrossdeckServer } from "../src/crossdeck-server";

// The SDK returns the SAME instance for the same credentials (the Next.js
// re-instantiation guard). Tests construct many servers with the same test key and
// need per-test isolation, so clear the singleton cache before each test — a fresh
// `new CrossdeckServer()` then builds a fresh instance with the test's own spies.
beforeEach(() => {
  CrossdeckServer.clearSingletonCache();
});
