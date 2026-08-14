import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RELEASE_PACKAGES,
  decidePublication,
  parseArguments,
  parsePnpmImporterDependencies,
  validateReleaseTag,
  validateRepository,
} from "../scripts/release-packages.mjs";

const git = process.platform === "win32" ? "git.exe" : "git";
const packageVersion = (
  JSON.parse(
    readFileSync(
      join(process.cwd(), "packages", "health", "package.json"),
      "utf8",
    ),
  ) as { version: string }
).version;

function run(command: string, arguments_: string[], cwd?: string): string {
  return execFileSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("release package metadata", () => {
  it("accepts npm's cross-platform argument separator", () => {
    expect(parseArguments(["--", "--output", ".release"])).toEqual({
      output: ".release",
    });
  });

  it("keeps the exact public package inventory", () => {
    expect(RELEASE_PACKAGES.map(({ name }) => name)).toEqual(["@pegma/health"]);
  });

  it("validates package manifests and the lockfile together", async () => {
    await expect(validateRepository()).resolves.toBeDefined();
  });

  it("matches each lockfile dependency to its own specifier and resolved version", () => {
    const locked = parsePnpmImporterDependencies(`
    dependencies:
      '@pegma/spine':
        specifier: 0.1.1
        version: 0.1.1
      '@pegma/storage-core':
        specifier: 0.4.0
        version: 0.4.0
`);
    expect(locked.get("@pegma/spine")).toEqual({
      specifier: "0.1.1",
      version: "0.1.1",
    });
    expect(locked.get("@pegma/storage-core")).toEqual({
      specifier: "0.4.0",
      version: "0.4.0",
    });

    const swapped = parsePnpmImporterDependencies(`
    dependencies:
      '@pegma/spine':
        specifier: 0.4.0
        version: 0.4.0
      '@pegma/storage-core':
        specifier: 0.1.1
        version: 0.1.1
`);
    expect(swapped.get("@pegma/spine")?.specifier).not.toBe("0.1.1");
    expect(swapped.get("@pegma/spine")?.version).not.toBe("0.1.1");

    const staleResolved = parsePnpmImporterDependencies(`
    dependencies:
      '@pegma/spine':
        specifier: 0.1.1
        version: 999.0.0
`);
    expect(staleResolved.get("@pegma/spine")).toEqual({
      specifier: "0.1.1",
      version: "999.0.0",
    });
  });

  it("requires the release tag to match a public package version", async () => {
    await expect(validateRepository({ releaseTag: "v9.9.9" })).rejects.toThrow(
      `release tag must be v${packageVersion}`,
    );
    await expect(
      validateRepository({
        releaseTag: `v${packageVersion}`,
        releasePrerelease: true,
      }),
    ).rejects.toThrow("prereleases cannot publish packages");
  });
});

describe("release source authentication", () => {
  it("accepts only an approved signed annotated tag at the event commit", () => {
    const root = mkdtempSync(join(tmpdir(), "health-release-tag-"));
    try {
      run(git, ["init", "--quiet"], root);
      run(git, ["config", "user.name", "Release Test"], root);
      run(git, ["config", "user.email", "release@example.com"], root);
      writeFileSync(join(root, "README.md"), "release test\n");
      run(git, ["add", "README.md"], root);
      run(git, ["commit", "--quiet", "-m", "release"], root);
      run(git, ["branch", "-M", "main"], root);
      run(git, ["update-ref", "refs/remotes/origin/main", "HEAD"], root);
      const releaseCommit = run(git, ["rev-parse", "HEAD"], root);

      const signingKey = join(root, "release-signing-key");
      run("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "release@example.com",
        "-f",
        signingKey,
      ]);
      const allowedSigners = join(root, "allowed-signers");
      writeFileSync(
        allowedSigners,
        `release@example.com ${readFileSync(`${signingKey}.pub`, "utf8").trim()}\n`,
      );
      run(git, ["config", "gpg.format", "ssh"], root);
      run(git, ["config", "user.signingkey", signingKey], root);
      run(git, ["config", "gpg.ssh.allowedSignersFile", allowedSigners], root);

      run(git, ["tag", "--sign", "v0.0.0", "--message", "signed"], root);
      expect(
        validateReleaseTag({
          root,
          releaseTag: "v0.0.0",
          expectedReleaseCommit: releaseCommit,
        }),
      ).toEqual({ headCommit: releaseCommit, releaseTag: "v0.0.0" });

      run(git, ["tag", "v0.0.1"], root);
      expect(() =>
        validateReleaseTag({
          root,
          releaseTag: "v0.0.1",
          expectedReleaseCommit: releaseCommit,
        }),
      ).toThrow("annotated tag object");

      run(
        git,
        [
          "-c",
          "commit.gpgsign=false",
          "tag",
          "--annotate",
          "v0.0.2",
          "--message",
          "unsigned",
        ],
        root,
      );
      expect(() =>
        validateReleaseTag({
          root,
          releaseTag: "v0.0.2",
          expectedReleaseCommit: releaseCommit,
        }),
      ).toThrow("not valid for an approved signer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps preparation outside the OIDC-enabled publisher job", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "publish.yml"),
      "utf8",
    );
    const jobsMarker = "\njobs:\n";
    const jobsIndex = workflow.indexOf(jobsMarker);
    expect(jobsIndex).toBeGreaterThanOrEqual(0);
    const header = workflow.slice(0, jobsIndex);
    const jobs = workflow.slice(jobsIndex + jobsMarker.length);
    const prepareStart = jobs.indexOf("  prepare:");
    const publishStart = jobs.indexOf("\n  publish:");
    expect(header).not.toContain("id-token: write");
    expect(prepareStart).toBeGreaterThanOrEqual(0);
    expect(publishStart).toBeGreaterThan(prepareStart);
    const prepare = jobs.slice(prepareStart, publishStart);
    const publish = jobs.slice(publishStart);
    expect(prepare).not.toContain("id-token: write");
    expect(prepare).toContain("npm install --global npm@11.18.0");
    expect(prepare).toContain("node scripts/release-packages.mjs pack");
    expect(publish).toContain("id-token: write");
    expect(publish).not.toContain("npm ci");
    expect(publish).not.toContain("npm install");
    expect(publish).not.toContain("pnpm install");
    expect(publish).not.toContain("corepack");
    expect(publish).not.toContain("pnpm run");
    expect(publish).not.toContain("pnpm/action-setup");
    expect(publish).toContain("node scripts/release-packages.mjs publish");
    expect(workflow).not.toContain("workflow_dispatch");
    expect(workflow).toContain("retention-days: 30");
  });
});

describe("retry-safe publication", () => {
  const integrity = "sha512-cHJlcGFyZWQtdGFyYmFsbA==";

  it("publishes an absent version", () => {
    expect(decidePublication(integrity, null)).toBe("publish");
  });

  it("skips a byte-identical existing version", () => {
    expect(decidePublication(integrity, integrity)).toBe("skip");
  });

  it("rejects an existing version with different bytes", () => {
    expect(() => decidePublication(integrity, "sha512-ZGlmZmVyZW50")).toThrow(
      "different tarball integrity",
    );
  });
});
