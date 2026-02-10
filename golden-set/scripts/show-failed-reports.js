const fs = require('fs');
const d = JSON.parse(fs.readFileSync('output/smoke-results.json', 'utf-8'));
const r = d.results.results;

// Show report snippets for failed tests
r.forEach((x, i) => {
  if (x.success) return;
  console.log('=== Test ' + (i + 1) + ' ===');
  console.log('Query:', (x.vars && x.vars.query ? x.vars.query : '?').substring(0, 80));
  console.log('Key claims:', x.vars ? x.vars.key_claims : 'N/A');

  try {
    const resp = JSON.parse(x.response ? x.response.output : '{}');
    const report = resp.result && resp.result.report ? resp.result.report : '';
    // Show first 800 chars of report
    console.log('Report (first 800 chars):');
    console.log(report.substring(0, 800));
    console.log('...');
    console.log('Report length:', report.length);
    console.log('Grade:', resp.result ? resp.result.grade : 'N/A');
  } catch (e) {
    console.log('Error parsing response:', e.message);
  }
  console.log('');
});
