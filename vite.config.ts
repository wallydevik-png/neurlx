// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { fileURLToPath } from "node:url";

// @solana/spl-token pulls in the 2.0.0-rc.1 line of @solana/* helper packages.
// Their export maps only declare "browser" / "node" / "react-native" — there is
// no "default" entry — so resolving them under the Cloudflare Worker condition
// set (workerd, worker, import, …) fails the production build outright. These
// are pure-JS codec/error helpers with no browser-only APIs, so pointing each
// one at its ESM browser build is safe on the Worker runtime.
const SOLANA_RC_PKGS = [
  "@solana/codecs",
  "@solana/codecs-core",
  "@solana/codecs-data-structures",
  "@solana/codecs-numbers",
  "@solana/codecs-strings",
  "@solana/errors",
  "@solana/options",
];

const solanaAliases = SOLANA_RC_PKGS.map((name) => ({
  find: new RegExp(`^${name.replace("/", "\\/")}$`),
  replacement: fileURLToPath(
    new URL(`./node_modules/${name}/dist/index.browser.mjs`, import.meta.url),
  ),
}));

export default defineConfig({
  vite: {
    resolve: {
      alias: [
        ...solanaAliases,
        ...Object.entries({
        // @solana/web3.js imports rpc-websockets for its subscription API, and
        // that package exposes no export-map entry for the Cloudflare Worker
        // condition set, which breaks the production bundle. We only use
        // web3.js for key handling and transaction signing (all RPC is plain
        // HTTP JSON-RPC), so the websocket client is stubbed out.
        "rpc-websockets/dist/lib/client": fileURLToPath(new URL("./src/lib/memecoin/rpc-websockets-stub.ts", import.meta.url)),
        "rpc-websockets/dist/lib/client/websocket.browser": fileURLToPath(new URL("./src/lib/memecoin/rpc-websockets-stub.ts", import.meta.url)),
        "rpc-websockets": fileURLToPath(new URL("./src/lib/memecoin/rpc-websockets-stub.ts", import.meta.url)),
        }).map(([find, replacement]) => ({ find, replacement })),
      ],
    },
  },
  nitro: {
    // External GitHub → Cloudflare deployments must build as Cloudflare Pages.
    // Without this, the repo can be treated as a static/GitHub Pages site and
    // SSR routes return 404 instead of running the TanStack Start worker.
    preset: "cloudflare-pages",
    cloudflare: { nodeCompat: true, deployConfig: true },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});

