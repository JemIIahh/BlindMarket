// Starts the published MCP server package over stdio and prints its tools/list as JSON.
// Usage: node scripts/dump-mcp-tools.mjs [version] > out.json
import { spawn } from 'node:child_process';

const version = process.argv[2] ?? 'latest';
const child = spawn('npx', ['-y', `@blindmarket/mcp-server@${version}`], {
  stdio: ['pipe', 'pipe', 'ignore'],
  // No API key or wallet: the server starts read-only, which is enough to list tools.
  env: { ...process.env, BLINDMARKET_API_KEY: '', BLINDMARKET_PRIVATE_KEY: '' },
});

let buf = '';
const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
child.stdout.on('data', (d) => {
  buf += d;
  for (;;) {
    const i = buf.indexOf('\n');
    if (i < 0) break;
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 1) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    } else if (m.id === 2) {
      process.stdout.write(JSON.stringify({ server: m.result.serverInfo ?? null, version, tools: m.result.tools }, null, 2));
      child.kill();
      process.exit(0);
    }
  }
});
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'docs-generator', version: '0' } } });
setTimeout(() => { console.error('timed out'); child.kill(); process.exit(1); }, 180_000);
