// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  vite: {
    resolve: {
      alias: {
        // @solana/web3.js imports rpc-websockets for its subscription API, and
        // that package exposes no export-map entry for the Cloudflare Worker
        // condition set, which breaks the production bundle. We only use
        // web3.js for key handling and transaction signing (all RPC is plain
        // HTTP JSON-RPC), so the websocket client is stubbed out.
        "rpc-websockets/dist/lib/client": fileURLToPath(new URL("./src/lib/memecoin/rpc-websockets-stub.ts", import.meta.url)),
        "rpc-websockets/dist/lib/client/websocket.browser": fileURLToPath(new URL("./src/lib/memecoin/rpc-websockets-stub.ts", import.meta.url)),
        "rpc-websockets": fileURLToPath(new URL("./src/lib/memecoin/rpc-websockets-stub.ts", import.meta.url)),
      },
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

