/**
 * Build the standalone executables.
 *   bun run build            -> Windows x64 + Linux x64
 *   bun run build windows    -> only Windows
 */
import { $ } from "bun";
import pkg from "../package.json";

const root = `${import.meta.dir}/..`;
const only = Bun.argv[2];
const targets = [
  { id: "windows", target: "bun-windows-x64", out: `dist/OpenApexpress-${pkg.version}-windows-x64.exe` },
  { id: "linux", target: "bun-linux-x64", out: `dist/open-apexpress-${pkg.version}-linux-x64` },
].filter((t) => !only || t.id === only);

await $`mkdir -p ${root}/dist`;
for (const t of targets) {
  const windowsFlags =
    // Icon and metadata can only be embedded when compiling on Windows (done in CI).
    t.id === "windows" && process.platform === "win32"
      ? [
          `--windows-icon=${root}/assets/icon.ico`,
          "--windows-title=Open Apexpress",
          "--windows-publisher=OpenGTB",
          `--windows-version=${pkg.version}.0`,
          "--windows-description=Open Apexpress - conteneurs sur ECLYPSE APEX",
          "--windows-copyright=MIT - OpenGTB",
        ]
      : [];
  console.log(`Building ${t.out}…`);
  await $`bun build ${root}/src/main.ts --compile --minify --target=${t.target} --outfile ${root}/${t.out} ${windowsFlags}`.env({
    ...process.env,
    NODE_ENV: "production",
  });
}
await $`ls -lh ${root}/dist`;
