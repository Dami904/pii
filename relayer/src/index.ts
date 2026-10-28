/**
 * relayer/src/index.ts
 * Bun.serve entry point — delegates to the platform-neutral handler.
 */

import { PORT, account, POOL_ADDRESS, chain } from "./config.js";
import { handleRequest } from "./handler.js";

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    return handleRequest(req);
  },
});

console.log(`Pii relayer listening on port ${server.port}`);
console.log(`  address: ${account.address}`);
console.log(`  pool:    ${POOL_ADDRESS}`);
console.log(`  chainId: ${chain.id}`);
