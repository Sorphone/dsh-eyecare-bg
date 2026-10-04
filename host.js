/**
 * dsh-eyecare-bg — 把 DSH 的背景换成护眼绿，并自带一个设置面板。
 *
 * 覆盖：整个「背景」家族——画布、卡片、侧栏、菜单/弹层、输入框、代码块、
 *       代码顶栏、状态条、浮层按钮……凡是官方浅色主题里解析为白色系的表面。
 * 不碰：字体、字号、圆角、布局、文字颜色、边框、强调色、阴影。
 *
 * 原理
 * ----
 * 1. DSH 的界面颜色全部走 `--dsw-*` 设计 token。ui-layout 的 presenter 把当前主题的
 *    token 以**内联样式**写到 `<body>` 上（`body.style.setProperty(name, value)`），
 *    普通样式压不过它，所以注入的规则必须带 `!important`。
 * 2. 宿主网页服务器每次渲染 index.html 会广播一次 `webserver/index-inject`；订阅者往
 *    回传的表里 push 行即可注入标记。`kind:"style"` 的行由
 *    `@deepseek-ai/dsh-host-webserver` 的 `renderRow()` 固定放进 `<head>`，
 *    `kind:"script"` 的行放在 `<body>` 开头。
 * 3. 设置面板就是第 2 条里的那段 script：纯 DOM，不用 React、不需要客户端 bundle、
 *    不需要构建。它通过插件自己的回环路由 `/eyecare-bg/api/config` 读写配置。
 * 4. `webServer` 路由由插件自己拥有，webserver 本身没有认证层，所以
 *    `http://127.0.0.1:19387/eyecare-bg` 可以直接在任意本机浏览器打开——这是设置面板的
 *    第二个入口（第一个是页面左侧边缘那个小色块标签）。路由自带回环 Host + 同源校验。
 *
 * 本插件只有宿主半边：没有 client bundle、不需要构建、零依赖、不写 localStorage、
 * 不改 app.asar。配置存在 `$DSH_HOME/eyecare-bg.json`（与 profile 的 cordis.patch.yml
 * 里的 config 合并，文件优先）。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const name = 'eyecare-bg';

/** 面板与路由共用的路径前缀。 */
const ROUTE = '/eyecare-bg';
/** 配置 API。 */
const API_PATH = `${ROUTE}/api/config`;
/** 状态文件名（放在 $DSH_HOME 下，跨 profile 一致）。 */
const STATE_FILENAME = 'eyecare-bg.json';
/** 请求体上限：配置只有几个字段，超过这个体积一律拒绝。 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * 注入样式独有的标记注释。
 *
 * 面板接管后需要把注入的那份样式关掉（否则面板改小「表面染色」开关时，注入样式里
 * 的旧声明仍然生效）。标记只出现在注入行、不出现在面板生成的实时样式里，所以
 * 面板能凭它精确认领自己的那份，而不会误伤应用自己的 token 样式表。
 */
const MARKER = '/*eyecare-bg*/';

/** 默认配置，也是回退值。 */
const DEFAULTS = Object.freeze({
  color: '#C7EDCC',
  colorDark: '#0F2116',
  surfaces: true,
  tab: true,
});

/**
 * 需要跟着底色走的表面 token。
 *
 * 每项 `[token, 浅色比例, 深色比例]`；比例为正表示往白里提（纸面/抬起），
 * 为负表示往黑压（下沉/内嵌）。深浅两套各自插值，所以同一个 token 在深色模式下
 * 会自动往亮里走——这也是官方深色主题里各层的实际关系。
 *
 * 取值来自对官方 `design-platform.css` 的实测解析：下面每一条在官方浅色主题里都解析为
 * #fff / #f9fafb / #f5f6f7 / #f1f3f5 / #ebeef2 / #e9ecf2 之一，
 * 也就是绿底上仍然会发白的那些表面。
 */
const SURFACE_TOKENS = Object.freeze([
  // 层级表面
  ['--dsw-alias-bg-layer-1', 0.32, 0.07],
  ['--dsw-alias-bg-layer-2', 0.24, 0.11],
  ['--dsw-alias-bg-layer-3', 0.16, 0.15],
  ['--dsw-alias-bg-overlay', 0.44, 0.2],
  ['--dsw-alias-bg-document-preview', 0.1, 0.05],
  ['--dsw-alias-bg-module-platform', 0.24, 0.11],
  ['--dsw-alias-bg-multi-select', 0.24, 0.11],
  // 按钮面
  ['--dsw-alias-button-elevated-fill', 0.4, 0.09],
  ['--dsw-alias-button-floating-fill', 0.4, 0.09],
  ['--dsw-alias-button-floating-hover', 0.26, 0.13],
  ['--dsw-alias-button-ghost-active-fill', 0.1, 0.1],
  ['--dsw-alias-button-ghost-active-hover', 0.14, 0.13],
  ['--dsw-alias-button-primary-dimmed', 0.1, 0.08],
  ['--dsw-alias-interactive-bg-hover-solid', 0.18, 0.09],
  // Markdown / 代码
  ['--dsw-alias-markdown-citation', 0.1, 0.08],
  ['--dsw-alias-markdown-code-block', -0.07, 0.08],
  ['--dsw-alias-markdown-code-block-banner', -0.11, 0.12],
  ['--dsw-alias-markdown-code-segment-selected', 0.4, 0.09],
  ['--dsw-alias-markdown-code-segment-unselected', 0.18, 0.12],
  ['--dsw-alias-markdown-placeholder', 0.24, 0.11],
  ['--dsw-alias-markdown-tag', 0.18, 0.12],
  ['--dsw-alias-turn-trigger-bg', -0.04, 0.08],
  // 气泡 / 输入 / 侧栏 / 提示
  ['--dsw-specific-bubble', 0.45, 0.12],
  ['--dsw-specific-bubble-highlight', 0.25, 0.2],
  ['--dsw-specific-input-major', 0.42, 0.09],
  ['--dsw-specific-login-input', 0.3, 0.12],
  ['--dsw-specific-selector', 0.24, 0.11],
  ['--dsw-specific-sidebar-fill', -0.06, -0.28],
  ['--dsw-specific-sidebar-nav-item-active', 0.1, 0.08],
  ['--dsw-specific-sidebar-nav-item-hover', 0.18, 0.09],
  ['--dsw-specific-tip', 0.24, 0.11],
]);

// ── 颜色 ───────────────────────────────────────────────────────────────────

/** 只接受 #rgb / #rrggbb，返回 [r,g,b]；其它写法一律报错。 */
function toRgb(value, field) {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} 必须是 "#rgb" 或 "#rrggbb" 字符串，收到 ${typeof value}`);
  }
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (match === null) {
    throw new TypeError(`${field} 不是合法的十六进制颜色：${JSON.stringify(value)}`);
  }
  const hex =
    match[1].length === 3
      ? match[1]
          .split('')
          .map((c) => c + c)
          .join('')
      : match[1];
  return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
}

/** `[r,g,b]` → `#RRGGBB`。 */
const toHex = (rgb) =>
  '#' +
  rgb
    .map((v) => Math.round(v).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

/** 在 rgb 与 target（0=黑 / 255=白）之间按 ratio 插值。 */
const blend = (rgb, target, ratio) => rgb.map((v) => v + (target - v) * ratio);

/** 带符号插值：正数往白里提，负数往黑里压。 */
const shade = (rgb, amount) => toHex(blend(rgb, amount >= 0 ? 255 : 0, Math.abs(amount)));

/** 校验并规范化一个颜色值。 */
const normalizeColor = (value, field) => toHex(toRgb(value, field));

// ── 配置 ───────────────────────────────────────────────────────────────────

/** 只挑出已知字段并逐个校验；未知字段忽略。 */
function coerceConfig(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  if (input.color !== undefined) out.color = normalizeColor(input.color, 'color');
  if (input.colorDark !== undefined) out.colorDark = normalizeColor(input.colorDark, 'colorDark');
  if (input.surfaces !== undefined) out.surfaces = Boolean(input.surfaces);
  if (input.tab !== undefined) out.tab = Boolean(input.tab);
  return out;
}

/** 逐层合并，每层都过一遍校验，因此不会把非法值带进去。 */
const mergeConfig = (...layers) => Object.assign({}, ...layers.map(coerceConfig));

/** `$DSH_HOME`（与宿主的 resolveDshHome 同口径）。 */
function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh');
}

/** 原子写：先写临时文件再改名；Windows 上改名被占用时回退直写。 */
function writeFileAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch {
    writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 });
    rmSync(tmp, { force: true });
  }
}

/**
 * 有状态、可持久化的配置。
 *
 * 优先级：DEFAULTS ← profile 的 cordis.patch.yml config ← `$DSH_HOME/eyecare-bg.json`。
 * 文件优先，这样面板改过之后 YAML 不会把它顶回去；「恢复默认」则是删掉文件、退回 YAML。
 */
function createState(yamlConfig) {
  const statePath = join(dshHome(), STATE_FILENAME);
  const base = mergeConfig(DEFAULTS, yamlConfig ?? {});
  let saved = {};
  try {
    saved = coerceConfig(JSON.parse(readFileSync(statePath, 'utf8')));
  } catch {
    saved = {}; // 文件不存在或损坏都按「没存过」处理
  }
  return {
    path: statePath,
    /** 生效配置。 */
    get: () => mergeConfig(base, saved),
    /** 试算：不落盘，用于面板实时预览。 */
    preview: (patch) => mergeConfig(base, saved, patch),
    /** 保存：落盘并返回生效配置。 */
    save(patch) {
      saved = mergeConfig(saved, patch);
      writeFileAtomic(statePath, `${JSON.stringify(saved, null, 2)}\n`);
      return mergeConfig(base, saved);
    },
    /** 恢复默认：删掉状态文件。 */
    reset() {
      saved = {};
      rmSync(statePath, { force: true });
      return mergeConfig(base, {});
    },
  };
}

// ── 样式表 ─────────────────────────────────────────────────────────────────

/** body 上是内联样式，所以每条声明都必须带 `!important`。 */
const declarations = (tokens) =>
  Object.entries(tokens)
    .map(([variable, value]) => `${variable}:${value}!important`)
    .join(';');

/**
 * 生成注入 `<head>` 的样式表。
 *
 * 纯 ASCII、无换行：这段标记会插在 `<head>` 顶部。
 *
 * @param config - 生效配置
 * @returns CSS 文本
 */
export function buildStylesheet(config = {}) {
  const effective = mergeConfig(DEFAULTS, config);
  const lightBase = toRgb(effective.color, 'color');
  const darkBase = toRgb(effective.colorDark, 'colorDark');

  const lightTokens = { '--dsw-alias-bg-base': toHex(lightBase) };
  const darkTokens = { '--dsw-alias-bg-base': toHex(darkBase) };
  if (effective.surfaces) {
    for (const [token, lightAmount, darkAmount] of SURFACE_TOKENS) {
      lightTokens[token] = shade(lightBase, lightAmount);
      darkTokens[token] = shade(darkBase, darkAmount);
    }
  }

  const canvasLight = `background-color:${toHex(lightBase)}!important;--dsh-boot-bg:${toHex(lightBase)}!important`;
  const canvasDark = `background-color:${toHex(darkBase)}!important;--dsh-boot-bg:${toHex(darkBase)}!important`;

  return [
    `html,body{${canvasLight}}`,
    `body:not([data-ds-dark-theme]){${declarations(lightTokens)}}`,
    `html:has(body[data-ds-dark-theme]){${canvasDark}}`,
    `body[data-ds-dark-theme]{${canvasDark};${declarations(darkTokens)}}`,
  ].join('');
}

// ── 设置面板 ───────────────────────────────────────────────────────────────

/**
 * 面板样式。
 *
 * 外观集中在 `.ecb-form` 上，所以**同一份表单**既能放进浮层，也能直接嵌进
 * DSH 设置页（`#eyecare-bg-panel` 只负责浮层那层壳）。全部用官方 token 打底，
 * 即使某个 token 没被覆盖也能看。
 */
const PANEL_CSS = [
  '#eyecare-bg-tab{position:fixed;left:0;top:44%;width:22px;height:64px;z-index:2147482000;',
  'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-left:0;border-radius:0 9px 9px 0;',
  'cursor:pointer;opacity:.45;transition:opacity .15s,width .15s;box-shadow:0 2px 8px rgba(0,0,0,.12)}',
  '#eyecare-bg-tab:hover{opacity:1;width:28px}',
  '#eyecare-bg-backdrop{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.28);',
  'display:flex;align-items:center;justify-content:center}',
  '#eyecare-bg-panel{width:352px;box-sizing:border-box;padding:18px;border-radius:16px;',
  'background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));',
  'box-shadow:0 18px 48px rgba(0,0,0,.24)}',
  '.ecb-form{box-sizing:border-box;max-width:520px;color:var(--dsw-alias-label-primary,#111);',
  'font:13px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif}',
  '.ecb-row{display:flex;align-items:center;gap:8px;margin:10px 0}',
  '.ecb-title{font-size:15px;font-weight:600;margin:0 0 4px}',
  '.ecb-sub{font-size:12px;opacity:.65;margin:0 0 10px}',
  '.ecb-label{flex:0 0 84px;font-size:12px;opacity:.8}',
  '.ecb-sw{width:34px;height:22px;border-radius:11px;flex:0 0 auto;padding:0}',
  '.ecb-hex{flex:1;min-width:0;font:12px/1 ui-monospace,Consolas,monospace;padding:6px 8px;',
  'border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));',
  'background:var(--dsw-alias-bg-layer-1,transparent);color:inherit}',
  '.ecb-presets{display:flex;gap:6px;flex-wrap:wrap;margin:2px 0 12px}',
  '.ecb-preset{display:flex;align-items:center;gap:5px;font-size:12px;padding:5px 9px;border-radius:8px;',
  'cursor:pointer;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:transparent;color:inherit}',
  '.ecb-preset:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
  '.ecb-dot{width:11px;height:11px;border-radius:3px;display:inline-block}',
  '.ecb-check{display:flex;align-items:center;gap:7px;font-size:12px;margin:12px 0;cursor:pointer}',
  '.ecb-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}',
  '.ecb-btn{font:inherit;font-size:12px;padding:7px 14px;border-radius:9px;cursor:pointer;',
  'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:transparent;color:inherit}',
  '.ecb-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
  '.ecb-btn-primary{background:var(--dsw-alias-brand-primary,#111);color:var(--dsw-alias-label-primary-inverted,#fff);',
  'border-color:transparent}',
  '.ecb-status{font-size:12px;min-height:18px;opacity:.7;margin-top:6px;text-align:right}',
].join('');

/**
 * 生成面板模块脚本。同一份实现用于三个载体：
 *   - 随 index 注入（`tab: true`）：左侧边缘标签 + 居中浮层，随手入口；
 *   - `/eyecare-bg` 页面（`autoOpen: true`）：直接铺开浮层；
 *   - `/eyecare-bg/panel.js`（两个都 false）：只挂 `window.__EYECARE_BG__`，
 *     由客户端插件在 DSH 设置页里 `mount()` 到自己的容器 —— 一份代码两处界面。
 *
 * 面板只做加法：自己建节点、只监听自己的元素，不触碰宿主自己的节点。
 */
function panelScript(options = {}) {
  const wantsTab = options.tab === true;
  const autoOpen = options.autoOpen === true;
  return `(function () {
  if (window.__EYECARE_BG__) return;
  var API = ${JSON.stringify(API_PATH)};
  var MARKER = ${JSON.stringify(MARKER)};
  var PRESETS = [['护眼绿', '#C7EDCC'], ['豆沙绿', '#CCE8CF'], ['更浅', '#E3F0E4'], ['更深', '#B7E3BE']];
  var current = null, claimed = false, overlay = null, overlayForm = null, forms = [];

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /**
   * 认领并关掉随 index 注入的那份样式：面板自己生成的实时样式从此是唯一权威，
   * 于是「表面染色」这类收窄型改动才能立刻生效（不刷新页面）。
   * 只认带 MARKER 的那一份，绝不碰应用自己的样式表。
   */
  function claimInjected() {
    if (claimed) return;
    var tags = document.head.querySelectorAll('style');
    for (var i = 0; i < tags.length; i++) {
      var node = tags[i];
      if (node.id === 'eyecare-bg-live') continue;
      if (node.textContent && node.textContent.indexOf(MARKER) !== -1) {
        node.disabled = true;
        claimed = true;
      }
    }
  }

  function liveStyle(css) {
    var node = document.getElementById('eyecare-bg-live');
    if (node === null) {
      node = document.createElement('style');
      node.id = 'eyecare-bg-live';
      document.head.appendChild(node);
    }
    node.textContent = css;
    // 先写实时样式，再关注入样式，避免中间出现一帧官方白色调色板。
    claimInjected();
    var dot = document.getElementById('eyecare-bg-tab');
    if (dot !== null && current !== null) dot.style.background = current.color;
  }

  function api(method, payload, done) {
    var init = { method: method };
    if (payload !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(payload);
    }
    fetch(API, init).then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.ok) {
        current = data.config;
        liveStyle(data.css);
        for (var i = 0; i < forms.length; i++) forms[i].sync(data.config);
        done(null, data);
      } else done(new Error((data && data.error) || '请求失败'), null);
    }).catch(function (error) { done(error, null); });
  }

  /**
   * 把表单建进 container，返回 { sync, destroy }。表单自带全部状态，
   * 所以浮层里和 DSH 设置页里可以同时各有一份，互不干扰。
   */
  function mountForm(container) {
    var status = null, inputs = {}, timer = null, alive = true;

    function gather() {
      return {
        color: inputs.color.value,
        colorDark: inputs.dark.value,
        surfaces: inputs.surfaces.checked,
        tab: inputs.tab.checked,
      };
    }

    function sync(config) {
      if (!alive || !config) return;
      inputs.color.value = config.color;
      inputs.colorHex.value = config.color.toUpperCase();
      inputs.dark.value = config.colorDark;
      inputs.surfaces.checked = config.surfaces !== false;
      inputs.tab.checked = config.tab !== false;
    }

    function preview() {
      inputs.colorHex.value = inputs.color.value.toUpperCase();
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (alive) api('POST', { config: gather(), preview: true }, function () {});
      }, 120);
    }

    var form = el('div', 'ecb-form');
    form.appendChild(el('div', 'ecb-title', '护眼绿背景'));
    form.appendChild(el('div', 'ecb-sub', '只改背景；文字、边框、强调色保持官方配色。'));

    var row1 = el('div', 'ecb-row');
    row1.appendChild(el('span', 'ecb-label', '主背景'));
    inputs.color = el('input', 'ecb-sw');
    inputs.color.type = 'color';
    inputs.colorHex = el('input', 'ecb-hex');
    inputs.colorHex.spellcheck = false;
    row1.appendChild(inputs.color);
    row1.appendChild(inputs.colorHex);
    form.appendChild(row1);

    var presets = el('div', 'ecb-presets');
    PRESETS.forEach(function (pair) {
      var button = el('button', 'ecb-preset');
      var dot = el('span', 'ecb-dot');
      dot.style.background = pair[1];
      button.appendChild(dot);
      button.appendChild(document.createTextNode(pair[0]));
      button.addEventListener('click', function () { inputs.color.value = pair[1]; preview(); });
      presets.appendChild(button);
    });
    form.appendChild(presets);

    var check = el('label', 'ecb-check');
    inputs.surfaces = el('input');
    inputs.surfaces.type = 'checkbox';
    check.appendChild(inputs.surfaces);
    check.appendChild(document.createTextNode('同时给卡片、代码块、输入框等表面染色'));
    form.appendChild(check);

    // 浮签是随 index 注入时建的，所以这一项保存后要刷新页面才看得到变化。
    var tabCheck = el('label', 'ecb-check');
    inputs.tab = el('input');
    inputs.tab.type = 'checkbox';
    tabCheck.appendChild(inputs.tab);
    tabCheck.appendChild(document.createTextNode('显示左侧边缘的浮签（保存并刷新页面后生效）'));
    form.appendChild(tabCheck);

    var row2 = el('div', 'ecb-row');
    row2.appendChild(el('span', 'ecb-label', '深色模式'));
    inputs.dark = el('input', 'ecb-sw');
    inputs.dark.type = 'color';
    row2.appendChild(inputs.dark);
    form.appendChild(row2);

    var foot = el('div', 'ecb-foot');
    var reset = el('button', 'ecb-btn', '恢复默认');
    var save = el('button', 'ecb-btn ecb-btn-primary', '保存');
    reset.addEventListener('click', function () {
      api('POST', { reset: true }, function (error) {
        if (status !== null) status.textContent = error ? error.message : '已恢复默认';
      });
    });
    save.addEventListener('click', function () {
      api('POST', { config: gather() }, function (error) {
        if (status !== null) status.textContent = error ? error.message : '已保存';
      });
    });
    foot.appendChild(reset);
    foot.appendChild(save);
    form.appendChild(foot);

    status = el('div', 'ecb-status', '');
    form.appendChild(status);

    inputs.color.addEventListener('input', preview);
    inputs.dark.addEventListener('input', preview);
    inputs.surfaces.addEventListener('change', preview);
    inputs.colorHex.addEventListener('change', function () {
      var value = inputs.colorHex.value.trim();
      if (/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value)) {
        inputs.color.value = value.charAt(0) === '#' ? value : '#' + value;
        preview();
      } else {
        inputs.colorHex.value = inputs.color.value.toUpperCase();
      }
    });

    container.appendChild(form);
    var record = {
      sync: sync,
      destroy: function () {
        alive = false;
        clearTimeout(timer);
        form.remove();
        forms = forms.filter(function (item) { return item !== record; });
      },
    };
    forms.push(record);
    api('GET', undefined, function (error, data) { if (!error) sync(data.config); });
    return record;
  }

  function openOverlay() {
    if (overlay === null) {
      overlay = el('div');
      overlay.id = 'eyecare-bg-backdrop';
      overlay.addEventListener('click', closeOverlay);
      var panel = el('div');
      panel.id = 'eyecare-bg-panel';
      panel.addEventListener('click', function (event) { event.stopPropagation(); });
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      document.addEventListener('keydown', function (event) { if (event.key === 'Escape') closeOverlay(); });
      overlayForm = mountForm(panel);
    }
    overlay.style.display = 'flex';
    api('GET', undefined, function (error, data) { if (!error && overlayForm !== null) overlayForm.sync(data.config); });
  }

  function closeOverlay() {
    if (overlay !== null) overlay.style.display = 'none';
  }

  /**
   * 对外的唯一接口：
   *   - mount(container)：设置页 section 用它把表单嵌进自己的容器，返回清理函数；
   *   - open() / close()：开合浮层（左侧标签走这条）。
   */
  window.__EYECARE_BG__ = {
    mount: function (container) { return mountForm(container).destroy; },
    open: openOverlay,
    close: closeOverlay,
  };

  function start() {
    api('GET', undefined, function () {});
    if (${wantsTab ? 'true' : 'false'}) {
      var dot = el('div');
      dot.id = 'eyecare-bg-tab';
      dot.title = '护眼绿背景设置';
      dot.addEventListener('click', openOverlay);
      document.body.appendChild(dot);
    }
    if (${autoOpen ? 'true' : 'false'}) openOverlay();
  }

  if (document.body === null) document.addEventListener('DOMContentLoaded', start);
  else start();
})();`;
}

// ── 路由 ───────────────────────────────────────────────────────────────────

/** 回环 Host + 同源校验：防 DNS rebinding，不是鉴权（本机单用户场景）。 */
function isTrusted(req) {
  const authority = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
  const host = typeof req.headers.host === 'string' ? req.headers.host : '';
  if (!authority.test(host)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin !== undefined && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) return false;
  return true;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 读请求体；超过上限就中断连接。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** `/eyecare-bg` 页面版：面板本身，页面背景用当前底色铺。 */
function settingsPage(config, css) {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>护眼绿背景 · 设置</title>
<style>${PANEL_CSS}
html,body{margin:0;min-height:100%;background:${config.color}}
#eyecare-bg-backdrop{background:transparent}
#eyecare-bg-panel{position:relative;margin:48px auto}
</style>
<style>${css}</style></head>
<body>
<script>${panelScript({ autoOpen: true })}</script>
</body></html>`;
}
/** 处理插件路由。任何分支都不抛：出口统一收敛成 JSON。 */
async function handleRequest(req, res, state) {
  if (!isTrusted(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

  if (pathname === API_PATH) {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, config: state.get(), css: buildStylesheet(state.get()) });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch (error) {
      sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${error.message}` });
      return;
    }
    try {
      const config =
        body.reset === true ? state.reset() : body.preview === true ? state.preview(body.config) : state.save(body.config);
      sendJson(res, 200, { ok: true, config, css: buildStylesheet(config) });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (pathname === `${ROUTE}/panel.js`) {
    const source = panelScript({ tab: false, autoOpen: false });
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(source),
    });
    res.end(source);
    return;
  }

  if (pathname === ROUTE || pathname === `${ROUTE}/`) {
    const config = state.get();
    const html = settingsPage(config, buildStylesheet(config));
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(html),
    });
    res.end(html);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
}

// ── 入口 ───────────────────────────────────────────────────────────────────

/**
 * 宿主插件入口。
 *
 * @param ctx - 宿主 cordis 上下文
 * @param config - profile 的 cordis.patch.yml 里按行 id `eyecare-bg` 给出的配置
 */
export function apply(ctx, config) {
  // 插件工厂抛错会连累整条 profile 的加载，而本插件只是给背景上色：任何异常都只告警。
  try {
    let state;
    try {
      state = createState(config);
    } catch (error) {
      // YAML 里写错颜色不应该让整套背景直接消失——退回默认护眼绿并说明原因。
      console.warn(`[eyecare-bg] 配置不可用（${error.message}），已回退到默认护眼绿。`);
      state = createState();
    }

    ctx.on('webserver/index-inject', (table) => {
      const config = state.get();
      // 两个样式行是故意分开的：
      //   1) 主题 token 覆盖 + 认领标记 —— 面板接管后会被 disabled；
      //   2) 面板自身的壳样式 —— **不带标记**，所以永远不会被关掉。
      // 合成一行的话，面板一认领就把自己的按钮/间距样式也一起关了。
      table.push({ kind: 'style', text: `${buildStylesheet(config)}${MARKER}` });
      table.push({ kind: 'style', text: PANEL_CSS });
      // 脚本行暴露 window.__EYECARE_BG__：设置页里的客户端 section 会 mount() 到自己的容器；
      // tab 打开时同时给出左侧边缘那个随手入口。
      table.push({ kind: 'script', placement: 'body', text: panelScript({ tab: config.tab !== false }) });
    });

    // 路由依赖 webServer。用 ctx.inject 等待而不是顶层 inject，
    // 这样即使某个组合没有 webserver，样式注入也照常工作。
    if (typeof ctx.inject !== 'function') return;
    ctx.inject(['webServer'], (child) => {
      child.effect(
        () =>
          child.webServer.register({
            kind: 'prefix',
            path: ROUTE,
            handler: (req, res) => {
              handleRequest(req, res, state).catch((error) => {
                console.warn(`[eyecare-bg] 路由出错：${error?.message ?? error}`);
                if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal' });
              });
            },
          }),
        'eyecare-bg: settings route',
      );
    });
  } catch (error) {
    console.warn(`[eyecare-bg] 未生效：${error?.message ?? error}`);
  }
}

/** 供自检使用的内部引用（不属于宿主契约）。 */
export const internals = { DEFAULTS, SURFACE_TOKENS, API_PATH, ROUTE, STATE_FILENAME };
