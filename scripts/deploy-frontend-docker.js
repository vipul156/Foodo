const { execSync } = require("child_process");
const path = require("path");
const os = require("os");

const rootDir = path.resolve(__dirname, "..");
const awsConfigDir = path.join(os.homedir(), ".aws");

console.log("==> Building frontend deployment container (Linux / Debian)...");
execSync("docker build -f Dockerfile.frontend-deploy -t foodo-frontend-deploy .", {
  cwd: rootDir,
  stdio: "inherit",
});

console.log("==> Running deployment container with AWS credentials...");
const envArgs = [];
if (process.env.AWS_ACCESS_KEY_ID) {
  envArgs.push(`-e AWS_ACCESS_KEY_ID="${process.env.AWS_ACCESS_KEY_ID}"`);
}
if (process.env.AWS_SECRET_ACCESS_KEY) {
  envArgs.push(`-e AWS_SECRET_ACCESS_KEY="${process.env.AWS_SECRET_ACCESS_KEY}"`);
}
if (process.env.AWS_SESSION_TOKEN) {
  envArgs.push(`-e AWS_SESSION_TOKEN="${process.env.AWS_SESSION_TOKEN}"`);
}
if (process.env.AWS_DEFAULT_REGION) {
  envArgs.push(`-e AWS_DEFAULT_REGION="${process.env.AWS_DEFAULT_REGION}"`);
}
if (process.env.STAGE) {
  envArgs.push(`-e STAGE="${process.env.STAGE}"`);
}

const mountAws = `-v "${awsConfigDir}:/root/.aws:ro"`;
const runCmd = `docker run --rm ${envArgs.join(" ")} ${mountAws} foodo-frontend-deploy`;

execSync(runCmd, {
  cwd: rootDir,
  stdio: "inherit",
});

console.log("==> Frontend deployment via Docker completed successfully!");
