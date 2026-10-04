/**
 * 安装后验证：完全按宿主的解析方式走一遍。
 *
 * 1. 从 profile 的 node_modules 解析本插件（junction → 工作区）
 * 2. 导入宿主入口，检查导出契约
 * 3. 用与宿主同形状的假 ctx 挂载：检查 index 注入行与路由注册
 * 4. 用宿主自带的 yaml 解析 cordis.patch.yml
 * 5. 检查 profile 侧的依赖与 bundles 登记
 *
 * 只读，不写任何文件。
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// profile 目录：DSH 自己会注入 DSH_PROFILE_DIR，也可以用第一个参数显式指定。
const profileDir = process.env.DSH_PROFILE_DIR ?? process.argv[2];
if (!profileDir) {
  throw new Error('请给出 profile 目录：设置 DSH_PROFILE_DIR，或用第一个参数传入（如 .../profiles/desktop）');
}
const pkgName = 'dsh-eyecare-bg';

const require = createRequire(join(profileDir, 'package.json'));

// ── 1. 宿主用 resolveBundleDir 找包目录；这里用同一套 node 解析 ────────────
const entry = require.resolve(`${pkgName}/package.json`);
const pkgDir = dirname(entry);
const manifest = JSON.parse(readFileSync(entry, 'utf8'));
console.log(`解析到包目录: ${pkgDir}`);
console.log(`package.json  : ${manifest.name}@${manifest.version}`);
console.log(`dsh.bundle    : ${JSON.stringify(manifest.dsh?.bundle)}`);

const patchRel = manifest.dsh?.bundle?.patch;
if (patchRel === undefined) throw new Error('包没有声明 dsh.bundle.patch —— 宿主会拒绝作为 profile 层');
const patchPath = join(pkgDir, patchRel);
if (!existsSync(patchPath)) throw new Error(`patch 文件不存在: ${patchPath}`);
console.log(`patch 文件    : ${patchPath} (存在)`);

// ── 2. 导入宿主入口 ────────────────────────────────────────────────────────
const entryFile = join(pkgDir, manifest.main ?? 'index.js');
const mod = await import(pathToFileURL(entryFile).href);
console.log(`\n入口导入成功  : ${entryFile}`);
console.log(`导出 name     : ${mod.name}`);
console.log(`导出 apply    : ${typeof mod.apply}`);

// ── 3. 用与宿主同形状的假 ctx 挂载 ────────────────────────────────────────
const seen = { handler: undefined, injectServices: [], routes: [], effectLabels: [] };
const originalWarn = console.warn;
const warnings = [];
console.warn = (message) => warnings.push(String(message));
try {
  mod.apply(
    {
      on(event, listener) {
        if (event === 'webserver/index-inject') seen.handler = listener;
      },
      inject(services, callback) {
        seen.injectServices.push(services.join(','));
        callback({
          effect(fn, label) {
            seen.effectLabels.push(label);
            return fn();
          },
          webServer: {
            register(route) {
              seen.routes.push(route);
              return () => {};
            },
          },
        });
      },
    },
    // 故意给一个坏配置：验证降级路径在真实入口上同样成立
    { color: 'not-a-color' },
  );
} finally {
  console.warn = originalWarn;
}

if (seen.handler === undefined) throw new Error('没有订阅 webserver/index-inject');
const table = [];
seen.handler(table);
const styleRow = table.find((row) => row.kind === 'style');
const scriptRow = table.find((row) => row.kind === 'script');
console.log(`\n注入行        : ${table.length} 行（样式 ${styleRow?.text.length} 字节 / 面板 ${scriptRow?.text.length} 字节）`);
console.log(`坏配置告警    : ${warnings.length} 条 → ${warnings[0] ?? '(无)'}`);
console.log(`routes 注入   : ${seen.injectServices.join(' | ')} → ${seen.routes.length} 条路由`);
console.log(`effect 标签   : ${seen.effectLabels.join(' | ')}`);
if (!styleRow.text.includes('#C7EDCC')) throw new Error('坏配置没有回退到默认护眼绿');
if (!styleRow.text.includes('--dsw-alias-markdown-code-block')) throw new Error('代码块 token 没有被覆盖');
if (!styleRow.text.includes('--dsw-specific-input-major')) throw new Error('输入框 token 没有被覆盖');
if (seen.routes.length !== 1 || seen.routes[0].path !== '/eyecare-bg') throw new Error('设置路由没有注册');
if (!new Function(scriptRow.text)) throw new Error('面板脚本语法错误');

// ── 4. 用宿主自带的 yaml 解析 patch ───────────────────────────────────────
const YAML = require('yaml');
const parsed = YAML.parse(readFileSync(patchPath, 'utf8'));
const inserted = parsed[0]?.insert ?? [];
console.log(`\npatch 解析    : ${inserted.length} 条插入`);
for (const row of inserted) console.log(`  id=${row.id} name=${row.name}`);
if (!inserted.some((row) => row.name === pkgName)) throw new Error('patch 里没有插入本插件');

// ── 5. profile 侧登记 ─────────────────────────────────────────────────────
const profileManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
const inDeps = pkgName in (profileManifest.dependencies ?? {});
const inBundles = (profileManifest.dsh?.profile?.bundles ?? []).includes(pkgName);
console.log(`\nprofile 依赖  : ${inDeps}  (${profileManifest.dependencies?.[pkgName]})`);
console.log(`profile bundles: ${inBundles}`);
if (!inDeps || !inBundles) throw new Error('profile 没有完整登记本插件');

// ── 6. 客户端半边：宿主按 exports["./client"] 找 bundle ────────────────────
const clientEntry = require.resolve(`${pkgName}/client`);
const clientDeclared = manifest.dsh?.client?.platform === 'web';
console.log(`\n客户端半边    : ${clientEntry}`);
console.log(`dsh.client    : ${JSON.stringify(manifest.dsh?.client)}`);
if (!clientDeclared) throw new Error('package.json 没有声明 dsh.client.platform = web');
if (!existsSync(clientEntry)) throw new Error('exports["./client"] 指向的文件不存在');
const clientSource = readFileSync(clientEntry, 'utf8');
if (!clientSource.includes('__ModuleLoader__')) throw new Error('client.js 不是运行时协议的 bundle');
new Function(clientSource); // 语法检查；只解析不执行
console.log('客户端 bundle : 可解析、走 __ModuleLoader__ 协议');

console.log('\n全部通过 ✓');
