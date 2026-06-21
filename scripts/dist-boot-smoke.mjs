import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

const listenMode = process.argv.includes("--lan") ? "0.0.0.0:0" : "127.0.0.1:0";
const expectedOpenLine = process.argv.includes("--lan")
  ? /^Open on your local network (http:\/\/\S+)/
  : /^Open (http:\/\/\S+)/;

const server = spawn(process.execPath, ["dist/cli.js", "--listen", listenMode], {
  stdio: ["ignore", "pipe", "pipe"],
});

const outputLines = [];

try {
  const url = await waitForOpenUrl(server, outputLines);
  await runBootSmoke(`${url.endsWith("/") ? url.slice(0, -1) : url}/?pocodexDebug=1`);
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: process.argv.includes("--lan") ? "lan" : "local",
        url,
      },
      null,
      2,
    ),
  );
} finally {
  server.kill("SIGTERM");
  await once(server, "exit").catch(() => undefined);
}

async function waitForOpenUrl(process, lines) {
  const stdout = createInterface({ input: process.stdout });
  const stderr = createInterface({ input: process.stderr });

  stderr.on("line", (line) => {
    lines.push(line);
  });

  const timeout = setTimeout(() => {
    process.kill("SIGTERM");
  }, 30_000);

  try {
    for await (const line of stdout) {
      lines.push(line);
      const match = expectedOpenLine.exec(line);
      if (match?.[1]) {
        return match[1];
      }
    }
  } finally {
    clearTimeout(timeout);
    stdout.close();
    stderr.close();
  }

  throw new Error(`Pocodex dist server did not print an open URL.\n${lines.join("\n")}`);
}

async function runBootSmoke(url) {
  const smoke = spawn(process.execPath, ["scripts/mobile-boot-smoke.mjs"], {
    env: {
      ...process.env,
      POCODEX_SMOKE_URL: url,
    },
    stdio: "inherit",
  });

  const [code, signal] = await once(smoke, "exit");
  if (code !== 0) {
    throw new Error(`dist boot smoke failed with ${signal ?? `exit code ${code}`}`);
  }
}
