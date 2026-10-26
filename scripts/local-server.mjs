import { spawn } from "node:child_process";

const mode = process.argv[2] === "start" ? "start" : "dev";
const envMode = mode === "start" ? "production" : "development";
// Load the same local file precedence as Next before starting the worker.
// process.loadEnvFile keeps values already provided by the shell or an earlier file.
for (const file of [
  `.env.${envMode}.local`,
  ".env.local",
  `.env.${envMode}`,
  ".env",
]) {
  try {
    process.loadEnvFile(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const children = [
  spawn(process.execPath, ["--import", "tsx", "scripts/iphone-worker.ts"], {
    stdio: "inherit",
    env: process.env,
  }),
  spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", mode, "--hostname", "127.0.0.1"],
    { stdio: "inherit", env: process.env },
  ),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children)
    if (child.exitCode === null) child.kill("SIGTERM");
  process.exitCode = code;
}
for (const child of children) {
  child.on("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    stop(1);
  });
  child.on("exit", (code) => stop(code || 0));
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
