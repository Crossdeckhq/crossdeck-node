#!/usr/bin/env node
/**
 * guard-ci-publish — make a local `npm publish` STRUCTURALLY impossible.
 *
 * Wired as this package's `prepublishOnly`, so npm runs it before any publish.
 * It refuses unless we're inside the GitHub Actions release workflow. A future
 * session (or a tired human) that types `npm publish` from a laptop is stopped
 * by the package itself — with instructions — instead of hitting the npm 2FA
 * one-time-pin prompt, which is the wrong door.
 *
 * Publishing happens EXCLUSIVELY through trusted publishing in
 * .github/workflows/release.yml on a version-tag push. There is no token and
 * no OTP in that path; OIDC proves the publisher.
 */

const inGitHubActions = process.env.GITHUB_ACTIONS === "true";
// The release workflow stamps this so we fail-closed even if some other CI
// (with GITHUB_ACTIONS set) ever runs npm publish for a different reason.
const inReleaseWorkflow = process.env.CROSSDECK_RELEASE === "1";

if (inGitHubActions && inReleaseWorkflow) {
  process.exit(0);
}

console.error(
  [
    "",
    "  ✗ Refusing to publish @cross-deck SDK from here.",
    "",
    "  Publishing is automated and trusted-publishing only — never local.",
    "  A local `npm publish` would demand a one-time pin (correct npm",
    "  behaviour, wrong door) and bypass the changelog + test gates.",
    "",
    "  To release: bump the version + CHANGELOG, then push the version tag.",
    "  The repo's .github/workflows/release.yml builds, tests, and publishes",
    "  via OIDC trusted publishing — zero prompts.",
    "",
    `  (guard: GITHUB_ACTIONS=${process.env.GITHUB_ACTIONS ?? "unset"}, CROSSDECK_RELEASE=${process.env.CROSSDECK_RELEASE ?? "unset"})`,
    "",
  ].join("\n"),
);
process.exit(1);
