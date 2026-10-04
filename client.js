/**
 * dsh-eyecare-bg — 客户端半边。
 *
 * 职责只有一个：把设置面板挂进 DSH 设置页。
 *
 * 契约（对着官方 `@deepseek-ai/dsh-client-ui-settings-general` 的注册示例抄的）：
 *
 *   ctx.slots.inject("settings.section", () => ctx.slots.register({
 *     name: "settings.section",   // list 槽位
 *     id: "eyecare-bg",           // 必需：SlotCore 会拒绝没有 id 的条目
 *     order: 40,                  // 导航里的排序
 *     label: () => "护眼绿背景",   // 导航标签，由 resolveSlotLabel 解析
 *   }, Section));
 *
 * 侧栏导航就是 `ctx.slots.entries("settings.section")` 按 order 排出来的，
 * 点子项时 shell 用 `renderSlot("settings.section", { close }, { only: active })`
 * 渲染对应 id 的条目 —— 所以不需要改宿主任何一行。
 *
 * 面板本体不在这里：宿主半边把 `window.__EYECARE_BG__`（含 `mount(container)`）
 * 随 index 注入，这里只管把它挂进自己的容器，因此浮层与设置页共用同一份实现。
 *
 * 这个 bundle 是手写的，但走的是官方运行时协议（`__ModuleLoader__.load` 的
 * factory 形式），不需要 tsdown/Vite 构建。它只 require 平台模块 `react`，
 * 所以不会在组合阶段请求任何外部提供方。
 */
window.__ModuleLoader__.load({
  id: 'dsh-eyecare-bg',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');

    /** 面板模块的兜底加载器：正常情况下宿主注入的脚本已经把它挂好了。 */
    function loadPanelModule() {
      return new Promise((resolve, reject) => {
        if (window.__EYECARE_BG__) {
          resolve(window.__EYECARE_BG__);
          return;
        }
        const settle = () => {
          if (window.__EYECARE_BG__) resolve(window.__EYECARE_BG__);
          else reject(new Error('eyecare-bg: 面板模块没有挂上'));
        };
        const existing = document.getElementById('eyecare-bg-panel-module');
        if (existing) {
          existing.addEventListener('load', settle);
          existing.addEventListener('error', () => reject(new Error('eyecare-bg: 面板模块加载失败')));
          return;
        }
        const script = document.createElement('script');
        script.id = 'eyecare-bg-panel-module';
        script.src = '/eyecare-bg/panel.js';
        script.addEventListener('load', settle);
        script.addEventListener('error', () => reject(new Error('eyecare-bg: 面板模块加载失败')));
        document.head.appendChild(script);
      });
    }

    /**
     * 设置页里的「护眼绿背景」页面。
     *
     * 自己只画一个空容器，真正的表单由宿主半边的模块 mount 进来 —— 于是浮层与
     * 设置页永远是同一份实现、同一套 token、同一套保存逻辑。
     */
    function EyecareSection() {
      const host = React.useRef(null);
      React.useEffect(() => {
        let dispose;
        let cancelled = false;
        const mount = (api) => {
          if (cancelled || host.current === null || typeof api.mount !== 'function') return;
          dispose = api.mount(host.current);
        };
        if (window.__EYECARE_BG__) mount(window.__EYECARE_BG__);
        else loadPanelModule().then(mount).catch((error) => console.warn(String(error)));
        return () => {
          cancelled = true;
          if (typeof dispose === 'function') dispose();
        };
      }, []);
      return React.createElement('div', { className: 'ecb-section', ref: host });
    }

    /**
     * 注册设置分区。
     *
     * 整段包在 try/catch 里：槽位条目不合格时 SlotCore 会抛，但那只是这一块界面
     * 不出现，绝不该影响宿主自己的设置页 —— 客户端异常必须止步于此。
     */
    function apply(ctx) {
      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'eyecare-bg',
              order: 40,
              label: () => '护眼绿背景',
            },
            EyecareSection,
          ),
        );
      } catch (error) {
        console.warn('[eyecare-bg] 设置分区未挂上：', error);
      }
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
