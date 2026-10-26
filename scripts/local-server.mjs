import { spawn } from "node:child_process";

const mode = process.argv[2] === "start" ? "start" : "dev";
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
