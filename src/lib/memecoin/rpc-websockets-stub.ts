// @solana/web3.js pulls in `rpc-websockets` for its subscription API, but that
// package has no export map entry for the Cloudflare Worker condition set, so
// the production bundle fails to resolve it. We only use web3.js for key
// handling and transaction signing (all RPC goes over plain HTTP JSON-RPC in
// jupiter.server.ts), so the websocket client is aliased to this inert stub.
class UnsupportedWebSocketClient {
  constructor() {
    throw new Error("WebSocket RPC subscriptions are not supported in this runtime");
  }
}

export default UnsupportedWebSocketClient;
export { UnsupportedWebSocketClient as Client, UnsupportedWebSocketClient as CommonClient };
export const createRpc = () => {
  throw new Error("WebSocket RPC subscriptions are not supported in this runtime");
};
