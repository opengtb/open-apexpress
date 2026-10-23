import { startServer } from "./server";
import { VERSION } from "./version";

const args = new Set(Bun.argv.slice(2));
const argValue = (name: string) => {
  const i = Bun.argv.indexOf(name);
  return i > 0 ? Bun.argv[i + 1] : undefined;
};

if (args.has("--version") || args.has("-v")) {
  console.log(VERSION);
  process.exit(0);
}

if (args.has("--help") || args.has("-h")) {
  console.log(`Open Apexpress ${VERSION} - deploy containers on Distech ECLYPSE APEX

Usage: open-apexpress [--port 7380] [--no-open] [--self-test]

  --port <n>     local port of the interface (default 7380, random if taken)
  --no-open      do not open the browser
  --self-test    deploy every recipe on the built-in simulated APEX and exit`);
  process.exit(0);
}

if (args.has("--self-test")) {
  const { selfTest } = await import("./self-test");
  process.exit((await selfTest()) ? 0 : 1);
}

function listen() {
  const wanted = Number(argValue("--port") ?? 7380);
  try {
    return startServer({ port: wanted, onQuit: quit });
  } catch {
    return startServer({ port: 0, onQuit: quit });
  }
}

function quit() {
  console.log("\n  Open Apexpress fermé. À bientôt !\n");
  server.stop();
  process.exit(0);
}

const server = listen();

const c = (code: number, s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
console.log(`
  ${c(1, c(36, "Open Apexpress"))} ${c(2, `v${VERSION}`)}
  ${c(2, "Vos conteneurs sur ECLYPSE APEX, en express.")}

  Interface : ${c(4, server.url)}

  ${c(2, "Laissez cette fenêtre ouverte pendant l'utilisation. Fermez-la pour quitter.")}
`);

if (!args.has("--no-open")) {
  const url = server.url;
  const cmd =
    process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : process.platform === "darwin"
        ? ["open", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    console.log("  Ouvrez l'adresse ci-dessus dans votre navigateur.");
  }
}

process.on("SIGINT", quit);
