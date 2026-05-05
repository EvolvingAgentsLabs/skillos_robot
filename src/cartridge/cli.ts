// src/cartridge/cli.ts
// Standalone entry point: starts the cartridge adapter and parks until
// SIGINT. Optionally connects to the ESP32 via UDP for methods that
// drive motors (stop, set_speed, navigate).
//
// Run with: tsx src/cartridge/cli.ts [--port 7424]
//                                     [--robot-host 192.168.1.100]
//                                     [--robot-port 4210]

import { startCartridgeAdapter } from './adapter';
import { setRobotState } from './state';
import { UDPTransmitter } from '../bridge/udp_transmitter';

const args = process.argv.slice(2);
let port = 7424;
let robotHost: string | undefined;
let robotPort = 4210;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--port' && args[i + 1]) { port = parseInt(args[++i], 10); }
  else if (a === '--robot-host' && args[i + 1]) { robotHost = args[++i]; }
  else if (a === '--robot-port' && args[i + 1]) { robotPort = parseInt(args[++i], 10); }
  else if (a === '--help' || a === '-h') {
    console.log(`Usage: tsx src/cartridge/cli.ts [options]

Options:
  --port <n>            WebSocket port for upstream OS callers (default 7424)
  --robot-host <ip>     ESP32 IP address (omit to skip motor wiring; methods
                        that need motor control return HARDWARE_UNAVAILABLE)
  --robot-port <n>      ESP32 UDP port (default 4210)
  --help                Show this message

Starts a WebSocket cartridge adapter that exposes the robot as a
method-callable cartridge to upstream LLM-OS frontends (skillos_mini,
llm_os browser demo).

Methods wired (real): stop
Methods scaffolded   : navigate, observe, describe, set_speed
See src/cartridge/methods.ts for status of each.`);
    process.exit(0);
  }
}

async function main() {
  // Optional: wire the UDP transmitter so motor-driving methods work.
  if (robotHost) {
    const transmitter = new UDPTransmitter({ host: robotHost, port: robotPort });
    try {
      await transmitter.connect();
      setRobotState({ transmitter });
      console.log(`[cartridge] UDP transmitter connected: ${robotHost}:${robotPort}`);
    } catch (err) {
      console.error(`[cartridge] UDP connect failed: ${(err as Error).message}`);
      console.error('[cartridge] starting adapter without motor wiring; stop/set_speed/navigate will return HARDWARE_UNAVAILABLE');
    }
  } else {
    console.log('[cartridge] no --robot-host provided; motor methods return HARDWARE_UNAVAILABLE');
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
}

main().catch((err) => {
  console.error('[cartridge] fatal:', err);
  process.exit(1);
});
