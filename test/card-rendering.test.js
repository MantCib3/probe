'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadScript(filename) {
  const pivotLists = Object.fromEntries(
    ['Email', 'Phone', 'Name', 'Shared'].map(mode => [`pivot${mode}List`, { innerHTML: '' }]));
  const scanButton = {
    attributes: {},
    classList: { toggle: (name, active) => { scanButton.done = active; } },
    setAttribute: (name, value) => { scanButton.attributes[name] = value; },
  };
  const context = vm.createContext({
    URL,
    document: {
      getElementById: id => id === 'cancelBtn' ? scanButton : pivotLists[id] || null,
      addEventListener: () => {},
      createElement: () => ({ dataset: {}, style: {} }),
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), context);
  return context;
}

for (const filename of ['script.js', 'script.min.js']) {
  const context = loadScript(filename);
  test(`${filename}: pivots have unique tools and only prefill compatible inputs`, () => {
    const names = vm.runInContext('Object.values(PIVOT_SOURCES).flat().map(source => source.name)', context);
    assert.equal(new Set(names).size, names.length);
    assert.equal(names.includes('Google'), false);
    assert.equal(names.includes('TruePeople'), false);
    for (const [target, mode, expected] of [
      ['john', 'phone', ''], ['john', 'email', ''], ['john', 'name', ''],
      ['alice@example.com', 'email', 'alice@example.com'],
      ['+1 (202) 555-0123', 'phone', '+1 (202) 555-0123'],
    ]) {
      vm.runInContext(`lastScannedTarget = ${JSON.stringify(target)}`, context);
      assert.equal(vm.runInContext(`pivotTarget(${JSON.stringify(mode)})`, context), expected);
    }
    vm.runInContext("currentMode = 'name'; lastScannedTarget = 'Jane Doe'", context);
    assert.equal(vm.runInContext("pivotTarget('name')", context), 'Jane Doe');
    vm.runInContext("renderPivotSources()", context);
    const shared = vm.runInContext("$('pivotSharedList').innerHTML", context);
    assert.equal((shared.match(/class="wmn-source-name"/g) || []).length, 1);
    assert.ok(shared.includes('results?name=Jane%20Doe'));
    assert.ok(shared.includes('Phone / Name'));
    vm.runInContext("currentMode = 'username'; lastScannedTarget = 'john'; renderPivotSources()", context);
    const phoneHtml = vm.runInContext("$('pivotPhoneList').innerHTML", context);
    assert.equal(phoneHtml.includes('/phone/john'), false);
    assert.equal(phoneHtml.includes('phoneno='), false);
    assert.ok(phoneHtml.includes('aria-label="Open ThatsThem: enter a phone manually"'));
  });
  test(`${filename}: scan actions stay icon-only with accessible state labels`, () => {
    for (const done of [false, true, false]) {
      vm.runInContext(`setScanAction(${done})`, context);
      const button = vm.runInContext('cancelBtn', context);
      assert.equal(button.textContent, done ? '✓' : '✕');
      assert.equal(button.attributes['aria-label'], done ? 'Done - return to search' : 'Cancel scan');
      assert.equal(button.title, button.attributes['aria-label']);
      assert.equal(button.done, done);
    }
  });
  test(`${filename}: all card modes put the source name beside its accessible status dot`, () => {
    for (const factory of ['makeCard', 'makeIntelCard', 'makeNameCard']) {
      const card = vm.runInContext(`${factory}({
        name: 'Example <source>', category: 'developer', status: 'found',
        statusCode: 200, url: 'https://example.com/alice'
      })`, context);
      assert.match(card.innerHTML, /class="card-heading"><span class="status-badge found"[^>]*aria-label="FOUND"/);
      assert.match(card.innerHTML, /class="site-name"[^>]*>Example &lt;source&gt;<\/div><\/div>/);
      assert.equal((card.innerHTML.match(/class="site-name"/g) || []).length, 1);
    }
  });

  test(`${filename}: categories use short labels without losing full accessible names`, () => {
    const categories = ['social', 'developer', 'gaming', 'content', 'forum', 'professional', 'shopping', 'misc', 'intel', 'people-finder'];
    for (const category of categories) {
      const html = vm.runInContext(`categoryBadgeHtml(${JSON.stringify(category)})`, context);
      assert.match(html, />[A-Z]{3,4}<\/span>$/);
      assert.ok(html.includes(`aria-label="${category}"`));
      assert.ok(html.includes(`title="${category}"`));
    }
  });
}
