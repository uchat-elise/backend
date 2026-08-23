const { spawnSync } = require('node:child_process');

const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', '--test', 'test/*.test.js'], {
  cwd: __dirname + '/..',
  env: { ...process.env, NODE_ENV: 'test' },
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
