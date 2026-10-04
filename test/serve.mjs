/**
 * 本地验证夹具：完全按宿主的方式挂载插件，跑在一个真实 HTTP 服务器上。
 *
 *   /demo        —— 模拟宿主 index（head 顶部注入样式、body 开头注入脚本）
 *   /settings    —— 模拟 DSH 设置弹窗，把面板 mount 进 section 容器
 *   /eyecare-bg  —— 插件自己的设置页
 *   /eyecare-bg/api/config —— 配置 API
 *
 * DSH_HOME 指向临时目录，绝不碰真实配置。
 * 运行：node test/serve.mjs [port]
 */
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'eyecare-bg-serve-'));
process.env.DSH_HOME = HOME;

const { apply, internals } = await import('../host.js');

let route;
const listeners = [];
apply({
  on: (event, listener) => listeners.push(listener),
  inject: (services, callback) =>
    callback({
      effect: (fn) => fn(),
      webServer: {
        register: (r) => {
          route = r;
          return () => {};
        },
      },
    }),
});

// 宿主是**每次 index 渲染都重新 emit 一次注入表**，所以这里也必须按请求采集，
// 否则配置改动（比如关掉浮签）在夹具里永远反映不出来。每行渲染成独立标签：
// 合并成一个 <style> 会让面板的认领逻辑把自己的壳样式一起关掉。
function injectedMarkup() {
  const rows = [];
  for (const listener of listeners) listener(rows);
  return {
    styles: rows
      .filter((row) => row.kind === 'style')
      .map((row) => `<style>${row.text}</style>`)
      .join('\n'),
    script: rows.find((row) => row.kind === 'script').text,
  };
}

/** 模拟宿主 index：尽量用真实的 token 名，好让配色差异看得见。 */
function mockPage() {
  const { styles, script } = injectedMarkup();
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>mock dsh</title>
<style>
body{margin:0;font:14px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;color:var(--dsw-alias-label-primary,#0f1115);
background:var(--dsw-alias-bg-base,#fff);display:flex;height:100vh;overflow:hidden}
.side{width:228px;flex:0 0 228px;background:var(--dsw-specific-sidebar-fill,#f9fafb);padding:14px 12px;box-sizing:border-box;border-right:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}
.brand{font-weight:700;font-size:15px;margin-bottom:14px}
.newchat{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:10px;padding:9px 12px;font-size:13px;margin-bottom:16px}
.nav{padding:7px 10px;border-radius:8px;font-size:13px;color:var(--dsw-alias-label-secondary,#61666b)}
.nav.active{background:var(--dsw-specific-sidebar-nav-item-active,#ebeef2);color:var(--dsw-alias-label-primary,#0f1115)}
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.head{padding:14px 20px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));display:flex;gap:10px;align-items:center}
.pill{font-size:12px;padding:5px 12px;border-radius:8px;background:var(--dsw-alias-bg-module-platform,#f5f6f7)}
.pill.primary{background:var(--dsw-alias-brand-primary,#0f1115);color:var(--dsw-alias-label-primary-inverted,#fff)}
.body{flex:1;overflow:auto;padding:20px}
.card{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:12px;padding:14px 16px;margin-bottom:14px}
.code{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:12px;overflow:hidden;margin-bottom:14px}
.code .bar{background:var(--dsw-alias-markdown-code-block-banner,#f9fafb);padding:7px 12px;font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);display:flex;justify-content:space-between}
.code pre{margin:0;padding:14px;background:var(--dsw-alias-markdown-code-block,#f9fafb);font:12.5px/1.6 ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-primary,#0f1115)}
.bubble{background:var(--dsw-specific-bubble,#edf3fe);border-radius:12px;padding:10px 14px;display:inline-block;margin-bottom:14px}
.composer{margin:0 20px 18px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:14px;background:var(--dsw-specific-input-major,#fff);padding:12px 14px;color:var(--dsw-alias-label-secondary,#61666b);display:flex;justify-content:space-between;align-items:center}
.send{width:34px;height:34px;border-radius:50%;background:var(--dsw-alias-brand-primary,#0f1115);color:var(--dsw-alias-label-primary-inverted,#fff);display:flex;align-items:center;justify-content:center}
.float{position:absolute;right:26px;bottom:96px;width:30px;height:30px;border-radius:50%;background:var(--dsw-alias-button-floating-fill,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));display:flex;align-items:center;justify-content:center;font-size:13px}
</style>
<style>${styles}</style>
</head>
<body>
<script>${script}</script>
<div class="side">
  <div class="brand">deepseek · mock</div>
  <div class="newchat">＋ 新会话</div>
  <div class="nav active">会话</div><div class="nav">插件</div><div class="nav">设置</div>
  <div class="nav" style="margin-top:18px;opacity:.6">工作区</div>
  <div class="nav">DSH_DESKTOP</div>
</div>
<div class="main">
  <div class="head"><span class="pill">智能体团队</span><span class="pill">标准模式</span><span class="pill primary">费用明细</span></div>
  <div class="body">
    <div class="bubble">把背景换成护眼绿。</div>
    <div class="card">这是一张卡片（bg-layer-1）。文字、边框、强调色保持官方配色。</div>
    <div class="code"><div class="bar"><span>javascript</span><span>复制</span></div><pre>const green = '#C7EDCC';\n// 代码块现在应该也是护眼绿，而不是白色</pre></div>
    <div class="card">行内标签：<span style="background:var(--dsw-alias-markdown-tag,#f1f3f5);border-radius:4px;padding:1px 6px;font-size:12px">token</span></div>
  </div>
  <div class="composer"><span>发消息或创建任务，/ 调用指令，@ 文件或对话</span><span class="send">↑</span></div>
</div>
<div class="float">⌄</div>
</body></html>`;
}

/**
 * 模拟 DSH 设置弹窗：左导航栏杆 + 右内容区，内容区里有一个 section 容器。
 * 页面末尾那句 mount() 就是客户端 bundle 里 Section 组件做的事。
 */
function mockSettingsPage() {
  const { styles, script } = injectedMarkup();
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>mock dsh settings</title>
<style>
body{margin:0;height:100vh;overflow:hidden;background:var(--dsw-alias-bg-base,#fff);
font:14px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;color:var(--dsw-alias-label-primary,#0f1115)}
.mask{position:fixed;inset:0;background:rgba(0,0,0,.2);display:flex;align-items:center;justify-content:center}
.dialog{width:780px;height:496px;display:flex;border-radius:16px;overflow:hidden;
background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));
box-shadow:0 18px 48px rgba(0,0,0,.24)}
.nav{width:194px;flex:0 0 194px;padding:16px 12px;box-sizing:border-box;
border-right:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.05))}
.navTitle{font-weight:600;margin-bottom:14px}
.cell{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:8px;font-size:13px;color:var(--dsw-alias-label-secondary,#61666b)}
.cell.active{background:var(--dsw-specific-sidebar-nav-item-active,#ebeef2);color:var(--dsw-alias-label-primary,#0f1115)}
.content{flex:1;min-width:0;padding:22px 26px;overflow:auto}
.content h1{font-size:17px;font-weight:600;margin:0 0 18px}
</style>
<style>${styles}</style>
</head>
<body>
<script>${script}</script>
<div class="mask"><div class="dialog">
  <div class="nav">
    <div class="navTitle">设置</div>
    <div class="cell">⚙ 通用</div>
    <div class="cell">◱ 模型</div>
    <div class="cell">◫ 插件</div>
    <div class="cell active">🌿 护眼绿背景</div>
  </div>
  <div class="content"><h1>护眼绿背景</h1><div id="eyecare-section"></div></div>
</div></div>
<script>
  // 客户端 bundle 里 Section 组件做的就是这一句：把同一个面板 mount 进自己的容器。
  if (window.__EYECARE_BG__) window.__EYECARE_BG__.mount(document.getElementById('eyecare-section'));
</script>
</body></html>`;
}

const port = Number(process.argv[2] ?? 19488);
createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  if (pathname === route.path || pathname.startsWith(`${route.path}/`)) {
    route.handler(req, res);
    return;
  }
  const page = pathname === '/settings' ? mockSettingsPage() : pathname === '/demo' || pathname === '/' ? mockPage() : null;
  if (page !== null) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(page) });
    res.end(page);
    return;
  }
  res.writeHead(404).end('nope');
}).listen(port, '127.0.0.1', () => {
  console.log(`harness listening on http://127.0.0.1:${port}`);
  console.log(`  demo     http://127.0.0.1:${port}/demo`);
  console.log(`  settings http://127.0.0.1:${port}/settings`);
  console.log(`  page     http://127.0.0.1:${port}${internals.ROUTE}`);
  console.log(`  state    ${join(HOME, internals.STATE_FILENAME)}`);
});
