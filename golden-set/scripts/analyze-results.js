const fs = require('fs');
const d = JSON.parse(fs.readFileSync('output/smoke-results.json', 'utf-8'));
const r = d.results.results;
console.log('Total:', r.length);
let passed = 0, failed = 0;
r.forEach((x, i) => {
  const q = (x.vars && x.vars.query ? x.vars.query : '?').substring(0, 60);
  const ok = x.success;
  if (ok) passed++; else failed++;
  const reasons = (x.gradingResult && x.gradingResult.componentResults ? x.gradingResult.componentResults : [])
    .filter(a => !a.pass)
    .map(a => (a.reason ? a.reason : 'unknown').substring(0, 120));
  console.log((i + 1) + '. ' + (ok ? 'PASS' : 'FAIL') + ' ' + q);
  if (!ok) reasons.forEach(r => console.log('   >> ' + r));
});
console.log('\nPassed:', passed, 'Failed:', failed);
