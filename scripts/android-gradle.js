const { spawn } = require('node:child_process');
const path = require('node:path');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/android-gradle.js <gradle-task> [extra args...]');
  process.exit(1);
}

const androidDir = path.resolve(__dirname, '..', 'android');
const isWindows = process.platform === 'win32';
const command = isWindows ? (process.env.ComSpec || 'cmd.exe') : './gradlew';
const commandArgs = isWindows ? ['/d', '/s', '/c', 'gradlew.bat', ...args] : args;

const child = spawn(command, commandArgs, {
  cwd: androidDir,
  stdio: 'inherit',
  shell: false,
});

child.once('error', (error) => {
  console.error('[android-gradle] ' + error.message);
  process.exit(1);
});

child.once('exit', (code) => {
  process.exit(code ?? 0);
});
