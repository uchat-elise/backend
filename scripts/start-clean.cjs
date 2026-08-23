const { execFileSync, spawn } = require('node:child_process');

const port = Number(process.env.API_PORT || 3000);
const useTestMode = process.env.E2E_TEST_MODE === 'true' || process.env.NODE_ENV === 'test';

if (!useTestMode && (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY)) {
  console.error('[startup] Missing SUPABASE_URL or SUPABASE_KEY. Set them or use E2E_TEST_MODE=true.');
  process.exit(1);
}

function run(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore', windowsHide: true });
  } catch {
    // No process on the port is a successful cleanup result.
  }
}

function freePort() {
  if (process.platform === 'win32') {
    let output = '';
    try {
      output = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
    } catch {
      return;
    }

    const pids = new Set();
    for (const line of output.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/);
      if (columns[0] === 'TCP' && columns[1]?.endsWith(':' + port) && columns[3] === 'LISTENING') {
        if (columns[4]) pids.add(columns[4]);
      }
    }
    for (const pid of pids) run('taskkill', ['/PID', pid, '/T', '/F']);
    return;
  }

  try {
    const pids = execFileSync('lsof', ['-ti', ':' + port], { encoding: 'utf8' });
    for (const pid of pids.split(/\s+/).filter(Boolean)) run('kill', ['-TERM', pid]);
  } catch {
    run('fuser', ['-k', String(port) + '/tcp']);
  }
}

freePort();
const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'start'], {
  cwd: __dirname + '/..',
  env: process.env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  windowsHide: false,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

process.once('exit', () => {
  if (!child.killed) child.kill('SIGTERM');
});

child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
