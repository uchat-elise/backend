const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const tsxLoader = pathToFileURL(path.resolve(root, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

// Run the source through tsx so E2E never serves stale generated JavaScript.
const result = spawnSync(process.execPath, ['--import', tsxLoader, 'src/index.ts'], {
	cwd: root,
	stdio: 'inherit',
});

process.exit(result.status ?? 1);
