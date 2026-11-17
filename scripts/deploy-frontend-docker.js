const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const rootDir = path.resolve(__dirname, "..");
const webDir = path.join(rootDir, "apps", "web");
const awsConfigDir = path.join(os.homedir(), ".aws");

// `deploy` is the default. The state migration after an SST major version bump
// (AWS provider v6 -> v7) has to run in this same Linux image, so the sst
// subcommand is a parameter:
//
//   node scripts/deploy-frontend-docker.js diff
//   node scripts/deploy-frontend-docker.js refresh
//   node scripts/deploy-frontend-docker.js deploy
const sstCommand = process.argv[2] || "deploy";
const extraArgs = process.argv.slice(3);

// `.sst/` is excluded from the build context, so the container has no
// `.sst/stage` to fall back on and would resolve a different stage on its own.
// Pin it here instead, from the last stage used on this checkout.
function resolveStage() {
  if (process.env.SST_STAGE) return process.env.SST_STAGE;
  if (process.env.STAGE) return process.env.STAGE;
  try {
    return fs.readFileSync(path.join(webDir, ".sst", "stage"), "utf8").trim();
  } catch {
    return undefined;
  }
}

console.log("==> Building frontend deployment container (Linux / Debian)...");
execFileSync(
  "docker",
  ["build", "-f", "Dockerfile.frontend-deploy", "-t", "foodo-frontend-deploy", "."],
  { cwd: rootDir, stdio: "inherit" },
);

const stage = resolveStage();

console.log(
  `==> Running "sst ${sstCommand}"${stage ? ` --stage ${stage}` : ""} with AWS credentials...`,
);

const dockerArgs = ["run", "--rm"];

for (const name of [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_DEFAULT_REGION",
]) {
  if (process.env[name]) dockerArgs.push("-e", `${name}=${process.env[name]}`);
}

dockerArgs.push("-v", `${awsConfigDir}:/root/.aws:ro`);
// Pulumi downloads its providers (aws-7.x is ~250 MB) into the container's
// home directory. Without a volume that download repeats on every run, because
// the image itself stays free of SST/Pulumi caches.
dockerArgs.push("-v", "foodo-pulumi-plugins:/root/.pulumi");
dockerArgs.push("foodo-frontend-deploy", "pnpm", "exec", "sst", sstCommand);

if (stage) dockerArgs.push("--stage", stage);
dockerArgs.push(...extraArgs);

execFileSync("docker", dockerArgs, {
  cwd: rootDir,
  stdio: "inherit",
});

console.log(`==> Frontend "${sstCommand}" via Docker completed successfully!`);
