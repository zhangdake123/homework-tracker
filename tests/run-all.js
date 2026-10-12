'use strict';

// 一次跑完全部测试：服务器版（SQLite）、静态版业务规则、云开发驱动、静态版启动流程
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SUITES = [
  ['服务器版（SQLite）业务场景', 'tests/scenarios.test.js'],
  ['静态版业务规则（内存驱动）', 'tests/static-store.test.js'],
  ['云开发数据库驱动', 'tests/cloudbase-driver.test.js'],
  ['静态版启动流程（假浏览器）', 'tests/static-boot.test.js'],
];

let failed = 0;
const results = [];

SUITES.forEach((suite) => {
  console.log('\n########## ' + suite[0] + ' ##########');
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', suite[1])], { stdio: 'inherit' });
  const ok = result.status === 0;
  if (!ok) failed += 1;
  results.push((ok ? 'PASS  ' : 'FAIL  ') + suite[0]);
});

console.log('\n############ 汇总 ############');
results.forEach((line) => console.log('  ' + line));
console.log(failed ? '\n有 ' + failed + ' 项测试套件失败' : '\n全部测试套件通过');
process.exit(failed ? 1 : 0);
