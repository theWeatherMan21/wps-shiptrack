// 非交互调用 wpsjs 的 buildWithArgs（官方 CLI 会弹 inquirer 菜单，无法脚本化）
const path = require('path');
const root = path.resolve(__dirname, '..');
process.chdir(root);
const build = require(path.join(root, 'node_modules/wpsjs/src/lib/build.js'));
build.buildWithArgs({ pluginType: process.argv[2] || 'online' })
  .then(d => { console.log('BUILD_OK ' + d); process.exit(0); })
  .catch(e => { console.error('BUILD_FAIL ' + (e && e.stack || e)); process.exit(1); });
