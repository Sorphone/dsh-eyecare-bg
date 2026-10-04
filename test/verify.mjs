/**
 * dsh-eyecare-bg 离线自检。
 *
 * 覆盖：导出契约 / 注入行 / CSS 卫生 / 表面 token 覆盖 / 配置校验 /
 *      apply() 的订阅与路由注册 / HTTP 路由层（用假 req/res 跑真实处理函数）。
 *
 * 运行：node test/verify.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 状态文件必须写到临时目录，绝不能碰真实的 $DSH_HOME。
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'eyecare-bg-test-'));
process.env.DSH_HOME = FAKE_HOME;

const { buildStylesheet, internals, name, apply } = await import('../host.js');

let passed = 0;
const check = (label, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${label}`);
  } catch (error) {
    console.error(`FAIL  ${label}\n      ${error.message}`);
    process.exitCode = 1;
  }
};
const asyncCheck = async (label, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${label}`);
  } catch (error) {
    console.error(`FAIL  ${label}\n      ${error.message}`);
    process.exitCode = 1;
  }
};

console.log('dsh-eyecare-bg 自检\n');

// ── 挂载（与宿主同形状的假 ctx）────────────────────────────────────────────
const listeners = [];
const routeLabels = [];
const routes = [];
const fakeCtx = {
  on(event, listener) {
    listeners.push({ event, listener });
  },
  inject(services, callback) {
    assert.deepEqual(services, ['webServer']);
    callback({
      effect(fn, label) {
        routeLabels.push(label);
        return fn();
      },
      webServer: {
        register(route) {
          routes.push(route);
          return () => {};
        },
      },
    });
  },
};
apply(fakeCtx, {});

const table = [];
for (const { listener } of listeners) listener(table);
const styleRows = table.filter((row) => row.kind === 'style');
const themeRow = styleRows[0];
const panelCssRow = styleRows[1];
const scriptRow = table.find((row) => row.kind === 'script');
const css = themeRow?.text ?? '';
const panelCss = panelCssRow?.text ?? '';
const panel = scriptRow?.text ?? '';
const needed = (token) => new RegExp(`--dsw-[a-z0-9-]*${token}[a-z0-9-]*:[^;{}]+!important`, 'g');

console.log('导出与挂载');
check('导出 name / apply / buildStylesheet', () => {
  assert.equal(name, 'eyecare-bg');
  assert.equal(typeof apply, 'function');
  assert.equal(typeof buildStylesheet, 'function');
});
check('订阅 webserver/index-inject 一次', () => {
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].event, 'webserver/index-inject');
});
check('注入三行：主题样式 + 面板样式 + body 脚本', () => {
  assert.equal(table.length, 3);
  assert.equal(themeRow.kind, 'style');
  assert.equal(panelCssRow.kind, 'style');
  assert.equal(scriptRow.kind, 'script');
  assert.equal(scriptRow.placement, 'body');
});
check('面板壳样式独立成行且不带认领标记（否则面板一认领就关掉自己的样式）', () => {
  assert.ok(panelCss.includes('.ecb-btn'), '面板样式行缺内容');
  assert.ok(!panelCss.includes('/*eyecare-bg*/'), '面板样式行不该带标记');
  assert.ok(panelCss.includes('/*eyecare-bg*/') === false);
});
check('注册了 /eyecare-bg 前缀路由并打了 effect 标签', () => {
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, internals.ROUTE);
  assert.equal(typeof routes[0].handler, 'function');
  assert.deepEqual(routeLabels, ['eyecare-bg: settings route']);
});

// ── 表面覆盖 ───────────────────────────────────────────────────────────────
console.log('\n表面 token 覆盖（这些就是之前仍然发白的表面）');
const MUST_COVER = [
  ['bg-base', '主画布'],
  ['markdown-code-block', '代码块'],
  ['markdown-code-block-banner', '代码块顶栏'],
  ['input-major', '输入框'],
  ['bubble', '消息气泡'],
  ['sidebar-fill', '侧栏'],
  ['bg-layer-1', '卡片'],
  ['bg-overlay', '菜单/弹层'],
  ['bg-module-platform', '平台模块面'],
  ['button-floating-fill', '浮层按钮'],
  ['markdown-tag', '行内标签'],
  ['markdown-placeholder', '占位块'],
];
for (const [token, label] of MUST_COVER) {
  check(`${label} (${token}) 被覆盖且带 !important`, () => {
    assert.ok((css.match(needed(token)) ?? []).length >= 2, `${token} 的浅色/深色声明不完整`);
  });
}
check('表面 token 表完整（31 项，深浅两套都进 CSS）', () => {
  assert.equal(internals.SURFACE_TOKENS.length, 31);
  for (const [token] of internals.SURFACE_TOKENS) {
    assert.ok(css.includes(`${token}:`), `${token} 缺失`);
  }
});
check('代码块比底色深（下沉），卡片比底色浅（抬起）', () => {
  const red = (token) => {
    const m = new RegExp(`${token}:(#[0-9A-F]{6})!important`).exec(css);
    return Number.parseInt(m[1].slice(1, 3), 16);
  };
  const base = red('--dsw-alias-bg-base');
  assert.ok(red('--dsw-alias-markdown-code-block') < base, '代码块没有下沉');
  assert.ok(red('--dsw-alias-bg-layer-1') > base, '卡片没有抬起');
});
check('surfaces:false 时只留主画布', () => {
  const bare = buildStylesheet({ surfaces: false });
  assert.ok(bare.includes('--dsw-alias-bg-base'));
  assert.ok(!bare.includes('--dsw-alias-markdown-code-block'));
  assert.ok(bare.length < css.length / 4);
});

// ── CSS / 脚本卫生 ─────────────────────────────────────────────────────────
console.log('\n注入标记卫生');
check('样式表纯 ASCII、无换行（插在 <head> 顶部）', () => {
  // eslint-disable-next-line no-control-regex
  assert.ok(/^[\x20-\x7e]*$/.test(css), '样式含非 ASCII 或换行');
});
check('样式表括号平衡', () => {
  assert.equal((css.match(/{/g) ?? []).length, (css.match(/}/g) ?? []).length);
});
check('脚本行语法正确（new Function 只解析不执行）', () => {
  assert.doesNotThrow(() => new Function(panel));
});
check('脚本行不含 </script>（会提前闭合注入的标签）', () => {
  assert.ok(!panel.includes('</script>'));
});
check('注入样式带认领标记，面板脚本会凭标记关掉它', () => {
  assert.ok(css.includes('/*eyecare-bg*/'), '注入样式缺标记');
  assert.ok(panel.includes('/*eyecare-bg*/'), '面板不知道标记');
  assert.ok(panel.includes('claimInjected'), '面板没有认领逻辑');
  assert.ok(panel.includes('disabled = true'), '认领后没有关掉注入样式');
});
check('面板生成的实时样式不含标记（否则会把自己关掉）', () => {
  assert.ok(!buildStylesheet({ color: '#C7EDCC' }).includes('/*eyecare-bg*/'));
});
check('大小可控', () => {
  assert.ok(css.length < 16384, `CSS ${css.length} 字节`);
  assert.ok(panel.length < 16384, `面板脚本 ${panel.length} 字节`);
});

// ── 配置 ───────────────────────────────────────────────────────────────────
console.log('\n配置');
check('默认是经典护眼绿', () => {
  assert.ok(css.includes('--dsw-alias-bg-base:#C7EDCC!important'));
});
check('自定义色生效、#rgb 短写被规范化', () => {
  assert.ok(buildStylesheet({ color: '#0f0' }).includes('--dsw-alias-bg-base:#00FF00!important'));
});
check('非法颜色报错', () => {
  assert.throws(() => buildStylesheet({ color: 'green' }), /不是合法的十六进制颜色/);
  assert.throws(() => buildStylesheet({ color: '#12345' }), /不是合法的十六进制颜色/);
});
check('apply() 遇非法配置只降级不抛错', () => {
  const warn = console.warn;
  const captured = [];
  console.warn = (m) => captured.push(String(m));
  try {
    const local = [];
    apply({ on: (event, listener) => local.push(listener), inject: () => {} }, { color: 'nope' });
    const rows = [];
    local[0](rows);
    assert.ok(rows[0].text.includes('#C7EDCC'));
  } finally {
    console.warn = warn;
  }
  assert.match(captured[0], /\[eyecare-bg\] 配置不可用/);
});
check('宿主上下文异常时 apply() 也不向外抛', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.doesNotThrow(() =>
      apply({
        on: () => {
          throw new Error('boom');
        },
      }),
    );
  } finally {
    console.warn = warn;
  }
});

// ── HTTP 路由层 ────────────────────────────────────────────────────────────
console.log('\nHTTP 路由层');
const handler = routes[0].handler;

function makeReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const handlers = new Map();
  const req = {
    method,
    url,
    headers,
    on(event, fn) {
      handlers.set(event, fn);
      return req;
    },
    destroy() {},
    flush() {
      if (body !== undefined) handlers.get('data')?.(Buffer.from(body));
      handlers.get('end')?.();
    },
  };
  return req;
}
function makeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body ?? '';
    },
  };
}
async function call(spec) {
  const req = makeReq(spec);
  const res = makeRes();
  const running = handler(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  req.flush();
  await running;
  await new Promise((resolve) => setImmediate(resolve));
  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = undefined;
  }
  return { res, json };
}
const loopback = { host: '127.0.0.1:19387' };

await asyncCheck('GET /api/config 返回配置与 CSS', async () => {
  const { res, json } = await call({ url: internals.API_PATH, headers: loopback });
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.config.color, '#C7EDCC');
  assert.ok(json.css.includes('--dsw-alias-bg-base:#C7EDCC!important'));
});

await asyncCheck('GET /eyecare-bg 返回设置页面', async () => {
  const { res } = await call({ url: internals.ROUTE, headers: loopback });
  assert.equal(res.status, 200);
  assert.match(res.headers['Content-Type'], /text\/html/);
  assert.ok(res.body.includes('护眼绿背景'));
  assert.ok(res.body.includes('eyecare-bg-panel'));
});

await asyncCheck('POST save 落盘，GET 能读回', async () => {
  const { res, json } = await call({
    method: 'POST',
    url: internals.API_PATH,
    headers: loopback,
    body: JSON.stringify({ config: { color: '#CCE8CF', surfaces: false } }),
  });
  assert.equal(res.status, 200);
  assert.equal(json.config.color, '#CCE8CF');
  const again = await call({ url: internals.API_PATH, headers: loopback });
  assert.equal(again.json.config.color, '#CCE8CF');
  assert.equal(again.json.config.surfaces, false);
  const onDisk = JSON.parse(readFileSync(join(FAKE_HOME, internals.STATE_FILENAME), 'utf8'));
  assert.equal(onDisk.color, '#CCE8CF');
});

await asyncCheck('POST preview 不落盘', async () => {
  const before = readFileSync(join(FAKE_HOME, internals.STATE_FILENAME), 'utf8');
  const { json } = await call({
    method: 'POST',
    url: internals.API_PATH,
    headers: loopback,
    body: JSON.stringify({ config: { color: '#123456' }, preview: true }),
  });
  assert.equal(json.config.color, '#123456');
  assert.equal(readFileSync(join(FAKE_HOME, internals.STATE_FILENAME), 'utf8'), before);
});

await asyncCheck('POST reset 删掉状态文件并退回默认', async () => {
  const { json } = await call({
    method: 'POST',
    url: internals.API_PATH,
    headers: loopback,
    body: JSON.stringify({ reset: true }),
  });
  assert.equal(json.config.color, '#C7EDCC');
  assert.throws(() => readFileSync(join(FAKE_HOME, internals.STATE_FILENAME), 'utf8'));
});

await asyncCheck('非法颜色返回 400 且带人类可读原因', async () => {
  const { res, json } = await call({
    method: 'POST',
    url: internals.API_PATH,
    headers: loopback,
    body: JSON.stringify({ config: { color: 'red' } }),
  });
  assert.equal(res.status, 400);
  assert.equal(json.ok, false);
  assert.match(json.error, /不是合法的十六进制颜色/);
});

await asyncCheck('坏 JSON 返回 400', async () => {
  const { res } = await call({ method: 'POST', url: internals.API_PATH, headers: loopback, body: '{oops' });
  assert.equal(res.status, 400);
});

await asyncCheck('非回环 Host 返回 403', async () => {
  const { res } = await call({ url: internals.API_PATH, headers: { host: 'evil.example.com' } });
  assert.equal(res.status, 403);
});

await asyncCheck('跨站请求返回 403', async () => {
  const { res } = await call({
    url: internals.API_PATH,
    headers: { ...loopback, 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(res.status, 403);
});

await asyncCheck('跨源 Origin 返回 403', async () => {
  const { res } = await call({ url: internals.API_PATH, headers: { ...loopback, origin: 'https://evil.example.com' } });
  assert.equal(res.status, 403);
});

await asyncCheck('未知路径返回 404', async () => {
  const { res } = await call({ url: `${internals.ROUTE}/nope`, headers: loopback });
  assert.equal(res.status, 404);
});

await asyncCheck('GET /eyecare-bg/panel.js 返回面板模块', async () => {
  const { res } = await call({ url: `${internals.ROUTE}/panel.js`, headers: loopback });
  assert.equal(res.status, 200);
  assert.match(res.headers['Content-Type'], /javascript/);
  assert.ok(res.body.includes('window.__EYECARE_BG__'));
});

await asyncCheck('非回环 Host 拿不到面板模块（同一条信任门）', async () => {
  const { res } = await call({ url: `${internals.ROUTE}/panel.js`, headers: { host: 'evil.example.com' } });
  assert.equal(res.status, 403);
});

// ── 客户端 bundle（DSH 设置页里的那个 section）────────────────────────────
console.log('\n客户端 bundle');
const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/**
 * 用假的 __ModuleLoader__ / React 物化 client.js。
 * effect 收集起来由调用方手动 flush —— 真实 React 也是在提交之后才跑 effect，
 * 这样才验得出「组件渲染完才挂载」。
 */
function materialize(options = {}) {
  const entries = [];
  const effects = [];
  const fakeReact = {
    createElement(type, props) {
      const node = { type, props };
      if (props && props.ref) props.ref.current = node;
      return node;
    },
    useRef: (initial) => ({ current: initial }),
    useEffect: (fn) => {
      effects.push(fn);
    },
  };
  const win = { __ModuleLoader__: { load: (entry) => entries.push(entry) } };
  if (options.withoutPanelApi !== true) {
    win.__EYECARE_BG__ = {
      mount(container) {
        options.mounted?.push(container);
        return () => options.cleaned?.push(container);
      },
    };
  }
  const doc = {
    getElementById: () => null,
    head: { appendChild() {} },
    createElement: () => ({ addEventListener() {} }),
  };
  new Function('window', 'document', clientSource)(win, doc);
  const required = [];
  const mod = entries[0].factory((name) => {
    required.push(name);
    if (name === 'react') return fakeReact;
    throw new Error(`未预期的外部模块请求: ${name}`);
  });
  return { entries, mod, required, effects };
}

/** 挂上 section 并返回注册结果。 */
function registerSection(mod) {
  let registered = null;
  mod.apply({
    slots: {
      inject: (name, register) => register(),
      register: (options, Component) => {
        registered = { options, Component };
        return registered;
      },
    },
  });
  return registered;
}

check('client.js 语法正确', () => {
  assert.doesNotThrow(() => new Function(clientSource));
});

check('按官方运行时协议注册 factory，且只 require 平台模块 react', () => {
  const { entries, required, mod } = materialize();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'dsh-eyecare-bg');
  assert.equal(typeof entries[0].factory, 'function');
  assert.deepEqual(required, ['react'], '请求了平台表之外的模块，组合阶段会被拒');
  assert.equal(typeof mod.apply, 'function');
  assert.deepEqual(mod.inject, ['slots']);
});

check('注册的是官方 settings.section 槽位，字段齐全', () => {
  const { mod } = materialize();
  let injectedSlot = null;
  let registered = null;
  mod.apply({
    slots: {
      inject(name, register) {
        injectedSlot = name;
        register();
      },
      register(options, Component) {
        registered = { options, Component };
        return registered;
      },
    },
  });
  assert.equal(injectedSlot, 'settings.section');
  assert.equal(registered.options.name, 'settings.section');
  assert.equal(registered.options.id, 'eyecare-bg');
  assert.equal(typeof registered.options.order, 'number');
  assert.equal(typeof registered.options.label, 'function');
  assert.equal(registered.options.label(), '护眼绿背景');
  assert.equal(typeof registered.Component, 'function');
});

check('组件渲染完才把面板 mount 进自己的容器', () => {
  const mounted = [];
  const { mod, effects } = materialize({ mounted });
  const registered = registerSection(mod);
  const element = registered.Component();
  assert.equal(element.type, 'div');
  assert.equal(mounted.length, 0, 'effect 没跑就已经挂载了');
  const cleanups = effects.map((fn) => fn());
  assert.equal(mounted.length, 1);
  assert.equal(mounted[0], element.props.ref.current);
  assert.equal(typeof cleanups.find((value) => typeof value === 'function'), 'function', '没有返回清理函数');
});

check('槽位注册抛错时 apply() 不向外抛（客户端异常必须止步于此）', () => {
  const { mod } = materialize();
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.doesNotThrow(() =>
      mod.apply({
        slots: {
          inject() {
            throw new Error('slot core rejected');
          },
        },
      }),
    );
  } finally {
    console.warn = warn;
  }
});

check('面板 API 缺失时走兜底加载，不抛错也不假装挂上', () => {
  const mounted = [];
  const { mod, effects } = materialize({ withoutPanelApi: true, mounted });
  const registered = registerSection(mod);
  const warn = console.warn;
  console.warn = () => {};
  try {
    registered.Component();
    assert.doesNotThrow(() => effects.map((fn) => fn()));
  } finally {
    console.warn = warn;
  }
  assert.equal(mounted.length, 0);
});

rmSync(FAKE_HOME, { recursive: true, force: true });
console.log(`\n通过 ${passed} 项检查`);
console.log(`\n--- CSS ${css.length} 字节 / 面板脚本 ${panel.length} 字节 ---`);
console.log(css);
