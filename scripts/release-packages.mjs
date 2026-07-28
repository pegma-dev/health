import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = {
  directory: "health",
  name: "@pegma/health",
};
const REPOSITORY_URL = "git+https://github.com/pegma-dev/health.git";
const REVIEWED_NPM_VERSION = "11.18.0";
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export const RELEASE_PACKAGES = [PACKAGE];

function fail(message) {
  throw new Error(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: options.shell ?? false,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
    fail(
      `${command} ${arguments_.join(" ")} failed with exit code ${String(result.status)}${detail ? `:\n${detail}` : ""}`,
    );
  }
  return result;
}

function runNpm(arguments_, options = {}) {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath === undefined
    ? run(process.platform === "win32" ? "npm.cmd" : "npm", arguments_, {
        ...options,
        shell: process.platform === "win32",
      })
    : run(process.execPath, [npmExecPath, ...arguments_], options);
}

function gitCommand() {
  return process.platform === "win32" ? "git.exe" : "git";
}

function hashTarball(bytes) {
  return {
    shasum: createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.values(value).flatMap(exportTargets);
  }
  return [];
}

export function validateReleaseTag(options = {}) {
  const root = resolve(options.root ?? defaultRoot());
  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  const expectedReleaseCommit =
    options.expectedReleaseCommit ?? process.env.RELEASE_COMMIT;
  if (releaseTag === undefined || !/^v\d+\.\d+\.\d+$/u.test(releaseTag)) {
    fail("a stable release tag is required");
  }
  if (
    expectedReleaseCommit === undefined ||
    !/^[0-9a-f]{40,64}$/u.test(expectedReleaseCommit)
  ) {
    fail("an exact release event commit is required");
  }

  const tagRef = `refs/tags/${releaseTag}`;
  const type = run(gitCommand(), ["cat-file", "-t", tagRef], {
    cwd: root,
    capture: true,
    allowFailure: true,
  });
  if (type.status !== 0 || type.stdout.trim() !== "tag") {
    fail("the release ref must be an annotated tag object");
  }
  const headCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  const tagCommit = run(gitCommand(), ["rev-parse", `${tagRef}^{commit}`], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  if (
    !safeEqual(headCommit, tagCommit) ||
    !safeEqual(headCommit, expectedReleaseCommit)
  ) {
    fail(
      "the release checkout, signed tag target, and release event commit must match",
    );
  }
  const signature = run(gitCommand(), ["verify-tag", "--raw", tagRef], {
    cwd: root,
    capture: true,
    allowFailure: true,
  });
  if (signature.status !== 0) {
    fail("the release tag signature is not valid for an approved signer");
  }
  const onMain = run(
    gitCommand(),
    ["merge-base", "--is-ancestor", tagCommit, "refs/remotes/origin/main"],
    { cwd: root, capture: true, allowFailure: true },
  );
  if (onMain.status !== 0) {
    fail("the release tag commit must be contained in origin/main");
  }
  return { headCommit, releaseTag };
}

export async function validateRepository(options = {}) {
  const root = resolve(options.root ?? defaultRoot());
  const rootManifest = await readJson(join(root, "package.json"));
  const packageDirectory = join(root, "packages", PACKAGE.directory);
  const manifest = await readJson(join(packageDirectory, "package.json"));
  const lockfile = await readJson(join(root, "package-lock.json"));
  const lockEntry = lockfile.packages?.[`packages/${PACKAGE.directory}`];

  if (
    rootManifest.private !== true ||
    rootManifest.packageManager !== `npm@${REVIEWED_NPM_VERSION}`
  ) {
    fail(`the private root must pin npm@${REVIEWED_NPM_VERSION}`);
  }
  if (
    manifest.name !== PACKAGE.name ||
    !STABLE_SEMVER.test(manifest.version) ||
    manifest.private === true ||
    manifest.license !== "MIT" ||
    manifest.type !== "module" ||
    manifest.publishConfig?.access !== "public" ||
    manifest.engines?.node !== ">=22" ||
    manifest.repository?.type !== "git" ||
    manifest.repository?.url !== REPOSITORY_URL ||
    manifest.repository?.directory !== `packages/${PACKAGE.directory}`
  ) {
    fail(`${PACKAGE.name} has invalid public package metadata`);
  }
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.some((entry) => !entry.startsWith("dist/")) ||
    typeof manifest.scripts?.prepack !== "string" ||
    !manifest.scripts.prepack.includes("build")
  ) {
    fail(`${PACKAGE.name} has an unsafe package allowlist or prepack`);
  }
  const targets = exportTargets(manifest.exports);
  if (
    targets.length === 0 ||
    targets.some(
      (target) =>
        typeof target !== "string" ||
        !target.startsWith("./dist/") ||
        target.includes(".."),
    )
  ) {
    fail(`${PACKAGE.name} exports must point into dist`);
  }
  await stat(join(packageDirectory, "README.md"));
  await stat(join(packageDirectory, "LICENSE"));
  if (lockEntry?.version !== manifest.version) {
    fail(`${PACKAGE.name} version is not synchronized with package-lock.json`);
  }

  const publicWorkspaces = [];
  for (const entry of await readdir(join(root, "packages"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    try {
      const workspace = await readJson(
        join(root, "packages", entry.name, "package.json"),
      );
      if (workspace.private !== true) publicWorkspaces.push(workspace.name);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (publicWorkspaces.length !== 1 || publicWorkspaces[0] !== PACKAGE.name) {
    fail("public workspace inventory does not match the reviewed release list");
  }

  if (options.requireClean) {
    const status = run(gitCommand(), ["status", "--porcelain"], {
      cwd: root,
      capture: true,
    }).stdout;
    if (status.trim() !== "")
      fail("release preparation requires a clean checkout");
  }
  if (options.requireMainAncestor) {
    const head = run(gitCommand(), ["rev-parse", "HEAD"], {
      cwd: root,
      capture: true,
    }).stdout.trim();
    const onMain = run(
      gitCommand(),
      ["merge-base", "--is-ancestor", head, "refs/remotes/origin/main"],
      { cwd: root, capture: true, allowFailure: true },
    );
    if (onMain.status !== 0) {
      fail("release commit must be contained in origin/main");
    }
  }

  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  if (releaseTag !== undefined && releaseTag !== `v${manifest.version}`) {
    fail(`release tag must be v${manifest.version}`);
  }
  const prerelease =
    options.releasePrerelease ?? process.env.RELEASE_PRERELEASE ?? false;
  if (prerelease === true || prerelease === "true") {
    fail("prereleases cannot publish packages");
  }
  if (options.requireReleaseTag) {
    validateReleaseTag({
      root,
      releaseTag,
      expectedReleaseCommit: options.expectedReleaseCommit,
    });
  }
  return { root, manifest, packageDirectory, releaseTag };
}

function verifyPackedFiles(manifest, files) {
  const paths = files.map(({ path }) => path);
  for (const required of ["package.json", "README.md", "LICENSE"]) {
    if (!paths.includes(required))
      fail(`${manifest.name} is missing ${required}`);
  }
  if (
    paths.some(
      (path) =>
        !["package.json", "README.md", "LICENSE"].includes(path) &&
        !path.startsWith("dist/"),
    )
  ) {
    fail(`${manifest.name} tarball contains an unreviewed file`);
  }
  for (const target of exportTargets(manifest.exports)) {
    const path = target.replace(/^\.\//u, "");
    if (!paths.includes(path)) fail(`${manifest.name} is missing ${path}`);
  }
}

async function smokeTestTarball(tarball, manifest) {
  const directory = await mkdtemp(join(tmpdir(), "health-release-smoke-"));
  try {
    await writeFile(
      join(directory, "package.json"),
      '{"name":"health-release-smoke","private":true,"type":"module"}\n',
    );
    runNpm(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        tarball,
      ],
      { cwd: directory, capture: true },
    );
    for (const key of Object.keys(manifest.exports)) {
      const specifier =
        key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`;
      run(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `await import(${JSON.stringify(specifier)})`,
        ],
        { cwd: directory, capture: true },
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function prepareRelease(options = {}) {
  const { root, manifest, packageDirectory, releaseTag } =
    await validateRepository(options);
  const gitCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  const output = resolve(root, options.output ?? ".release");
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length !== 0) {
    fail(`release output directory must be empty: ${output}`);
  }

  runNpm(["run", "build"], { cwd: root });
  const result = runNpm(
    ["pack", packageDirectory, "--json", "--pack-destination", output],
    { cwd: root, capture: true },
  );
  const [packed] = JSON.parse(result.stdout);
  if (
    packed?.name !== manifest.name ||
    packed?.version !== manifest.version ||
    typeof packed.filename !== "string" ||
    !Array.isArray(packed.files)
  ) {
    fail("npm pack returned invalid metadata");
  }
  verifyPackedFiles(manifest, packed.files);
  const tarballPath = join(output, basename(packed.filename));
  const hashes = hashTarball(await readFile(tarballPath));
  if (
    !safeEqual(hashes.integrity, packed.integrity) ||
    !safeEqual(hashes.shasum, packed.shasum)
  ) {
    fail("tarball hashes do not match npm pack metadata");
  }
  await smokeTestTarball(tarballPath, manifest);

  const prepared = {
    schemaVersion: 1,
    gitCommit,
    releaseTag: releaseTag ?? null,
    package: {
      name: manifest.name,
      version: manifest.version,
      tarball: basename(tarballPath),
      integrity: hashes.integrity,
      shasum: hashes.shasum,
      files: packed.files
        .map(({ path, size }) => ({ path, size }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    },
  };
  const manifestPath = join(output, "package-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(prepared, null, 2)}\n`);
  return { manifestPath, manifest: prepared };
}

function queryRegistryIntegrity(name, version) {
  const spec = `${name}@${version}`;
  const result = runNpm(["view", spec, "dist.integrity", "--json"], {
    capture: true,
    allowFailure: true,
  });
  if (result.status === 0) {
    const integrity = JSON.parse(result.stdout);
    if (typeof integrity !== "string" || integrity.length === 0) {
      fail(`${spec} exists without dist.integrity`);
    }
    return integrity;
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (/\bE404\b/u.test(output)) return null;
  fail(`npm registry lookup failed for ${spec}:\n${output.trim()}`);
}

export function decidePublication(localIntegrity, registryIntegrity) {
  if (registryIntegrity === null) return "publish";
  if (safeEqual(localIntegrity, registryIntegrity)) return "skip";
  fail("the registry version exists with different tarball integrity");
}

function requireTrustedPublishingNpm() {
  const version = runNpm(["--version"], { capture: true }).stdout.trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/u.exec(version);
  if (match === null) fail(`could not parse npm version ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (
    major < 11 ||
    (major === 11 && minor < 5) ||
    (major === 11 && minor === 5 && patch < 1)
  ) {
    fail("trusted publishing requires npm 11.5.1 or newer");
  }
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function confirmRegistryIntegrity(record) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const integrity = queryRegistryIntegrity(record.name, record.version);
    if (integrity !== null && safeEqual(record.integrity, integrity)) return;
    if (attempt < 5) wait(2 ** attempt * 1000);
  }
  fail(
    `${record.name}@${record.version} did not expose the prepared integrity`,
  );
}

async function verifyPreparedManifest(path) {
  const prepared = await readJson(path);
  const record = prepared.package;
  if (
    prepared.schemaVersion !== 1 ||
    !/^[0-9a-f]{40,64}$/u.test(prepared.gitCommit) ||
    prepared.releaseTag !== `v${record?.version}` ||
    record?.name !== PACKAGE.name ||
    !STABLE_SEMVER.test(record.version) ||
    typeof record.integrity !== "string" ||
    typeof record.shasum !== "string" ||
    !Array.isArray(record.files)
  ) {
    fail("prepared package manifest is invalid");
  }
  const currentCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: defaultRoot(),
    capture: true,
  }).stdout.trim();
  if (!safeEqual(currentCommit, prepared.gitCommit)) {
    fail("prepared package manifest commit does not match the checkout");
  }
  const expectedTarball = `${PACKAGE.name
    .slice(1)
    .replace("/", "-")}-${record.version}.tgz`;
  if (record.tarball !== expectedTarball)
    fail("prepared tarball name is invalid");
  const tarball = resolve(dirname(path), record.tarball);
  if (dirname(tarball) !== resolve(dirname(path))) {
    fail("prepared tarball must be beside the package manifest");
  }
  const hashes = hashTarball(await readFile(tarball));
  if (
    !safeEqual(hashes.integrity, record.integrity) ||
    !safeEqual(hashes.shasum, record.shasum)
  ) {
    fail("prepared tarball has changed");
  }
  return prepared;
}

export async function publishPreparedRelease(options = {}) {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_EVENT_NAME !== "release"
  ) {
    fail("release:publish is restricted to a GitHub release workflow");
  }
  requireTrustedPublishingNpm();
  const path = resolve(options.manifest ?? ".release/package-manifest.json");
  const prepared = await verifyPreparedManifest(path);
  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  const expectedCommit =
    options.expectedReleaseCommit ?? process.env.RELEASE_COMMIT;
  if (releaseTag !== prepared.releaseTag) {
    fail("prepared manifest must match the release tag");
  }
  if (
    expectedCommit === undefined ||
    !/^[0-9a-f]{40,64}$/u.test(expectedCommit) ||
    !safeEqual(expectedCommit, prepared.gitCommit)
  ) {
    fail("prepared package manifest must match the release event commit");
  }

  const record = prepared.package;
  const decision = decidePublication(
    record.integrity,
    queryRegistryIntegrity(record.name, record.version),
  );
  if (decision === "skip") {
    process.stdout.write(
      `Verified existing ${record.name}@${record.version}; skipping.\n`,
    );
    return;
  }
  runNpm(
    [
      "publish",
      resolve(dirname(path), record.tarball),
      "--access",
      "public",
      "--provenance",
    ],
    { cwd: dirname(path) },
  );
  confirmRegistryIntegrity(record);
}

export function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") continue;
    if (argument === "--require-main-ancestor") {
      options.requireMainAncestor = true;
      continue;
    }
    if (argument === "--require-clean") {
      options.requireClean = true;
      continue;
    }
    if (argument === "--require-release-tag") {
      options.requireReleaseTag = true;
      continue;
    }
    const key =
      argument === "--root"
        ? "root"
        : argument === "--output"
          ? "output"
          : argument === "--manifest"
            ? "manifest"
            : argument === "--expected-release-commit"
              ? "expectedReleaseCommit"
              : null;
    if (key === null || arguments_[index + 1] === undefined) {
      fail(`unknown or incomplete argument: ${argument}`);
    }
    options[key] = arguments_[index + 1];
    index += 1;
  }
  return options;
}

function defaultRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  const options = parseArguments(arguments_);
  if (command === "check") {
    await validateRepository(options);
    process.stdout.write("Release metadata is valid.\n");
    return;
  }
  if (command === "pack") {
    const { manifestPath } = await prepareRelease(options);
    process.stdout.write(`Prepared release package at ${manifestPath}.\n`);
    return;
  }
  if (command === "publish") {
    await publishPreparedRelease(options);
    return;
  }
  fail("usage: release-packages.mjs <check|pack|publish> [options]");
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
