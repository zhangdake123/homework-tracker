'use strict';

// 一次跑完全部测试：服务器版（SQLite）、静态版业务规则、云开发驱动、静态版启动流程、真实浏览器 E2E
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SUITES = [
  ['服务器版（SQLite）业务场景', 'tests/scenarios.test.js', false],
  ['静态版业务规则（内存驱动）', 'tests/static-store.test.js', false],
  ['云开发数据库驱动', 'tests/cloudbase-driver.test.js', false],
  ['静态版启动流程（假浏览器）', 'tests/static-boot.test.js', false],
  // 需要本机有 Edge/Chrome 并且先生成过 outputs/static-site；没有就自动跳过
  ['真实浏览器 E2E（Edge + CDP，页面真的是浏览器打开的）', 'tests/browser-e2e.js', true],
];

let failed = 0;
let skipped = 0;
const results = [];

SUITES.forEach((suite) => {
  const name = suite[0];
  const file = suite[1];
  const capture = suite[2];
  console.log('\n########## ' + name + ' ##########');
  const result = capture
    ? spawnSync(process.execPath, [path.join(__dirname, '..', file)], { encoding: 'utf8' })
    : spawnSync(process.execPath, [path.join(__dirname, '..', file)], { stdio: 'inherit' });
  if (capture) {
    const out = (result.stdout || '') + (result.stderr || '');
    process.stdout.write(out);
    if (/跳过（/.test(out)) {
      skipped += 1;
      results.push('SKIP  ' + name);
      return;
    }
  }
  const ok = result.status === 0;
  if (!ok) failed += 1;
  results.push((ok ? 'PASS  ' : 'FAIL  ') + name);
});

console.log('\n############ 汇总 ############');
results.forEach((line) => console.log('  ' + line));
if (failed) {
  console.log('\n有 ' + failed + ' 项测试套件失败');
} else if (skipped) {
  console.log('\n全部可运行的测试套件通过（' + skipped + ' 项因环境缺少浏览器被跳过）');
} else {
  console.log('\n全部测试套件通过');
}
process.exit(failed ? 1 : 0);
