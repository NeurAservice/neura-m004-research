const fs = require('fs');
const d = JSON.parse(fs.readFileSync('output/smoke-results.json', 'utf-8'));
const r = d.results.results;

console.log('=== Golden Set Smoke Results — Detailed Metrics ===\n');

r.forEach((x, i) => {
  const q = (x.vars && x.vars.query ? x.vars.query : '?').substring(0, 65);
  const ok = x.success;

  try {
    const resp = JSON.parse(x.response ? x.response.output : '{}');
    const grade = resp.result ? resp.result.grade : 'N/A';
    const composite = resp.result && resp.result.quality ? resp.result.quality.compositeScore : 0;
    const cost = resp.usage ? resp.usage.estimated_cost_usd : 0;
    const reportLen = resp.result && resp.result.report ? resp.result.report.length : 0;
    const sources = resp.result && resp.result.sources ? resp.result.sources.length : 0;
    const claims = resp.result && resp.result.claims ? resp.result.claims.length : 0;

    console.log((i + 1) + '. ' + (ok ? 'PASS' : 'FAIL') + ' | ' + q);
    console.log('   Grade: ' + grade + ' | Composite: ' + (composite ? composite.toFixed(3) : '0') + ' | Cost: $' + (cost ? cost.toFixed(4) : '0') + ' | Report: ' + reportLen + ' chars | Sources: ' + sources + ' | Claims: ' + claims);

    // Show assertion details
    const asserts = x.gradingResult && x.gradingResult.componentResults ? x.gradingResult.componentResults : [];
    asserts.forEach((a, j) => {
      const status = a.pass ? '✓' : '✗';
      const score = a.score !== undefined ? a.score.toFixed(2) : '?';
      console.log('   ' + status + ' [' + score + '] ' + (a.reason ? a.reason.substring(0, 100) : 'no reason'));
    });
    console.log('');
  } catch (e) {
    console.log('   Error: ' + e.message);
  }
});

// Summary
console.log('=== Summary ===');
const passed = r.filter(x => x.success).length;
console.log('Total: ' + r.length + ' | Passed: ' + passed + ' | Failed: ' + (r.length - passed));
console.log('Duration: ' + (d.results.stats ? d.results.stats.tokenUsage : 'N/A'));
