const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const tsxLoader = pathToFileURL(path.resolve(root, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

const result = spawnSync(process.execPath, ['--import', tsxLoader, '--test', 'test/*.test.js'], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'test' },
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
