const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function compileInlineScripts(file) {
  const html = read(file);
  [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1].trim())
    .filter(Boolean)
    .forEach((source, index) => new vm.Script(source, { filename: file + '#script-' + index }));
}

test('the unified invite page explains both rewards and offers all six products', () => {
  const html = read('public/shixing/invite.html');
  assert.match(html, /1625/);
  assert.match(html, /3\s*天/);
  assert.match(html, /双方[^<]{0,20}500|各得\s*500/);
  assert.match(html, /1500/);
  assert.match(html, /30\s*天/);
  assert.match(html, /\/api\/referral\/context/);
  assert.match(html, /\/api\/referral/);
  for (const target of ['notice.yingyuzuowen.asia', 'comment.yingyuzuowen.asia', 'zuowen.yingyuzuowen.asia', '/english.html', '/roundtable/', '/edulab/pro.html']) {
    assert.match(html, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  compileInlineScripts('public/shixing/invite.html');
});

test('invite-code routes render the unified invite page rather than a product homepage', () => {
  const server = read('server.js');
  const route = server.slice(server.indexOf("app.get('/invite/:code'"), server.indexOf("app.get('/',"));
  assert.match(route, /public[^\n]+shixing[^\n]+invite\.html/);
  assert.match(route, /app\.get\('\/invite\.html'/);
});

test('all six products and the homepage expose the same invite center', () => {
  const files = [
    'public/shixing/index.html',
    'public/comment.html',
    'public/zuowen.html',
    'public/english.html',
    'public/roundtable/index.html',
    'public/edulab/pro.html',
    'public/teacher.html'
  ];
  for (const file of files) {
    assert.match(read(file), /https:\/\/shixing\.yingyuzuowen\.asia\/invite\.html\?center=1/, file);
  }
});

test('product referral controls use the global API and registration modals show invite context', () => {
  for (const file of ['public/comment.html', 'public/zuowen.html', 'public/teacher.html']) {
    const html = read(file);
    assert.match(html, /\/api\/referral['"?]/, file);
    assert.match(html, /\/api\/referral\/context/, file);
    assert.doesNotMatch(html, /\/api\/(comment|essay|broadcast)\/referral['"]/, file);
  }
  for (const file of ['public/comment.html', 'public/zuowen.html', 'public/english.html', 'public/teacher.html', 'public/roundtable/index.html', 'public/edulab/pro.html']) {
    compileInlineScripts(file);
  }
});
