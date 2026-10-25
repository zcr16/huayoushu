'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const packaged = process.argv.includes('--packaged');
const onlyReceipt = process.argv.includes('--receipt');
const run = (file, env = process.env) => {
  const result = spawnSync(process.execPath, [path.join(root, file)], { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
};

// Set the mode in Node, avoiding shell-specific environment assignment syntax.
if (packaged) run('harmonyos/scripts/package-web.mjs');
for (const file of onlyReceipt ? ['ui-receipt.cjs'] : ['ui-v2.cjs', 'ui-float.cjs', 'ui-receipt.cjs']) {
  run('tests/' + file, { ...process.env, HYS_TEST_PACKAGED: packaged ? '1' : '0' });
}
