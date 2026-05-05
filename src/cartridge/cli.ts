// src/cartridge/cli.ts
// Standalone entry point: starts the cartridge adapter and parks until
// SIGINT. Run with: tsx src/cartridge/cli.ts [--port 7424]

import { startCartridgeAdapter } from './adapter';

const args = process.argv.slice(2);
let port = 7424;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log('Usage: tsx src/cartridge/cli.ts [--port 7424]');
    console.log('');
    console.log('Starts a WebSocket cartridge adapter that exposes the robot');
    console.log('as a method-callable cartridge to upstream LLM-OS frontends');
    console.log('(skillos_mini, llm_os browser demo).');
    console.log('');
    console.log('Methods scaffolded but not yet wired to runtime: navigate,');
    console.log('observe, describe, stop, set_speed. See src/cartridge/methods.ts.');
    process.exit(0);
  }
}

const server = startCartridgeAdapter({ port });

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[cartridge] shutting down...');
  await server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
