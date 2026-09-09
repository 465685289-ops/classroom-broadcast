const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'shixing-points-routes.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('shared points expose one workbench-neutral config and payment flow', () => {
  assert.match(source, /GET|app\.get\('\/api\/points\/config'/);
  assert.match(source, /app\.post\('\/api\/points\/payments\/package'/);
  assert.match(source, /source_product: 'workbench'/);
  assert.match(source, /page=family&points_order=/);
  assert.match(server, /installShixingPointsRoutes\(app\)/);
});

test('workbench AI debit is server-authenticated, fixed-price and idempotent', () => {
  assert.match(source, /x-workbench-points-secret/);
  assert.match(source, /WORKBENCH_POINT_PRODUCTS\.has\(product\)/);
  assert.match(source, /observation_structure/);
  assert.match(source, /student_profile/);
  assert.match(source, /class_report/);
  assert.match(source, /intervention_plan/);
  assert.match(source, /consumeShixingPoints/);
  assert.doesNotMatch(source, /req\.body\.(cost|points)/);
});
