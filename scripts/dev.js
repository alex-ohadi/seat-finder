/**
 * Dev runner: starts the scraper API and the Vite dev server together, and
 * makes sure neither is left running when the other stops.
 */
import { spawn } from 'node:child_process';

const children = [];

function start(name, command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, ...env },
  });
  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.log(`\n[dev] ${name} exited (${code}); shutting down.`);
      shutdown(code ?? 0);
    }
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const API_PORT = process.env.API_PORT ?? '8787';
const WEB_PORT = process.env.PORT ?? '5173';

// PORT is cleared for the API so it cannot claim the web port.
start('api', process.execPath, ['server/index.js'], { API_PORT, PORT: '' });
start('vite', 'npx', ['vite', '--port', WEB_PORT, '--strictPort'], { API_PORT });
