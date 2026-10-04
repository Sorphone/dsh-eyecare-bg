/**
 * 安装后体检：确认 node_modules 仍满足每个 profile bundle 的依赖闭包。
 *
 * pnpm 这次输出里出现了 "Packages: -16"，说明它顺手清了 16 个包。这个脚本不执行任何
 * 插件代码，只递归检查依赖是否可解析 —— 只读。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// profile 目录：DSH 自己会注入 DSH_PROFILE_DIR，也可以用第一个参数显式指定。
const profileDir = process.env.DSH_PROFILE_DIR ?? process.argv[2];
if (!profileDir) {
  throw new Error('请给出 profile 目录：设置 DSH_PROFILE_DIR，或用第一个参数传入（如 .../profiles/desktop）');
}
const nodeModules = join(profileDir, 'node_modules');
const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
const bundles = manifest.dsh.profile.bundles;

/** 在提升布局下找包目录；找不到再退回 .pnpm 里的同名条目。 */
function findPkgDir(name) {
  const direct = join(nodeModules, name);
  if (existsSync(join(direct, 'package.json'))) return { dir: direct, where: 'top' };
  const pnpmDir = join(nodeModules, '.pnpm');
  if (existsSync(pnpmDir)) {
    const base = name.replace('/', '+');
    for (const entry of readdirSync(pnpmDir)) {
      if (entry === base || entry.startsWith(base + '@')) {
        const nested = join(pnpmDir, entry, 'node_modules', name);
        if (existsSync(join(nested, 'package.json'))) return { dir: nested, where: '.pnpm' };
      }
    }
  }
  return null;
}

const seen = new Set();
const unresolved = [];
let resolved = 0;

function walk(name, requiredBy) {
  if (seen.has(name)) return;
  seen.add(name);
  const found = findPkgDir(name);
  if (found === null) {
    unresolved.push({ name, requiredBy });
    return;
  }
  resolved += 1;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(found.dir, 'package.json'), 'utf8'));
  } catch (error) {
    unresolved.push({ name, requiredBy: `${requiredBy} (package.json 读不了: ${error.message})` });
    return;
  }
  for (const dep of Object.keys(pkg.dependencies ?? {})) walk(dep, name);
  // 还要看 peer：插件常靠 peer 拿宿主包，被误删一样会炸。
  const optionalPeers = new Set(Object.keys(pkg.peerDependenciesMeta ?? {}).filter((k) => pkg.peerDependenciesMeta[k].optional));
  for (const dep of Object.keys(pkg.peerDependencies ?? {})) {
    if (optionalPeers.has(dep)) continue;
    if (dep.startsWith('@deepseek-ai/')) continue; // 由安装锚点提供，不在 profile 里
    walk(dep, `${name} (peer)`);
  }
}

for (const bundle of bundles) walk(bundle, 'profile');

console.log(`profile bundles: ${bundles.length}`);
console.log(`依赖闭包内可解析: ${resolved} 个包`);
console.log(`无法解析: ${unresolved.length}`);
for (const item of unresolved) console.log(`  - ${item.name}  (被 ${item.requiredBy} 需要)`);

const thirdParty = bundles.filter((n) => existsSync(join(nodeModules, n, 'package.json')));
console.log(`\n第三方 bundle (由 profile 提供): ${thirdParty.length}`);
for (const name of thirdParty) {
  const pkg = JSON.parse(readFileSync(join(nodeModules, name, 'package.json'), 'utf8'));
  const main = pkg.main ?? 'index.js';
  const ok = existsSync(join(nodeModules, name, main)) || existsSync(join(nodeModules, name, pkg.exports?.['.']?.default ?? ''));
  console.log(`  ${name.padEnd(45)} 入口 ${main} ${ok ? 'OK' : '缺失!'}`);
}
process.exitCode = unresolved.length === 0 ? 0 : 1;
