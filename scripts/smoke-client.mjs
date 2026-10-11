#!/usr/bin/env node
/**
 * 客户端 bundle 冒烟测试——不需要 DSH，也不需要浏览器，只要 node。
 *
 * 它用最小的桩把产物真实跑一遍：
 *   window.__ModuleLoader__.load  ← 捕获工厂注册
 *   require                       ← 三个平台模块的最小实现
 *   ctx                           ← 记录 register/effect/inject 调用的假上下文
 *
 * 验证五件事：
 *   1. bundle 恰好注册一次工厂，且 id 正确；
 *   2. 工厂执行后导出插件契约 { name, inject, apply }；
 *   3. apply(ctx) 不抛错；
 *   4. apply 真的注册了：页签类型（含 guide 条目）、正文/标题 keyed slot、
 *      左侧会话行菜单项、locale 中英字典、样式 effect；
 *   5. 正文组件**真的渲染一遍**（极简渲染器，不跑 effect），断言可观察到的面板行为——
 *      目前是「筛选会话」三档下拉（与 DSH 侧栏对齐）：全部 / 隐藏已归档 / 仅显示已归档，
 *      含旧版布尔取值的迁移与无法识别取值的回落。
 *
 * 用法：node scripts/smoke-client.mjs [产物路径]
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const target = process.argv[2] ?? resolve(here, '..', 'dist', 'client.js')

const checks = []
const failures = []
function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition), detail })
  if (!condition) failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// ── 1. 捕获工厂注册 ──────────────────────────────────────────────────────────
const registrations = []
// localStorage 桩：插件用它写激活探针，这里顺便断言探针真的写了。
const storage = new Map()
const localStorageStub = {
  getItem: key => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)) },
  removeItem: key => { storage.delete(key) },
}
const sandbox = {
  window: { __ModuleLoader__: { load: entry => registrations.push(entry) }, localStorage: localStorageStub },
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  AbortController,
}
vm.createContext(sandbox)
try {
  vm.runInContext(readFileSync(target, 'utf8'), sandbox, { filename: target })
} catch (error) {
  console.error(`产物在顶层求值时抛错：${String(error)}`)
  process.exit(1)
}

check('注册了恰好一次工厂', registrations.length === 1, `实际 ${registrations.length} 次`)
const entry = registrations[0]
check('工厂 id 为 dsh-conversation-manager', entry?.id === 'dsh-conversation-manager', `实际 ${String(entry?.id)}`)
check('工厂是函数', typeof entry?.factory === 'function')

// ── 2. 执行工厂：平台模块用最小桩 ────────────────────────────────────────────
/* 桩比"最小"多了两件东西，因为第 6 节要把正文组件真的渲染出来：
 *   · hook 有**按渲染路径分格的状态存储**——useState/useMemo 跨渲染保值，
 *     useEffect 故意不执行（面板的 effect 会发异步请求、起定时器，测试不需要它们）；
 *   · jsx/jsxs 产出 { type, props, key } 节点，而不是空对象——否则没有树可遍历。 */
const hookStores = new Map()
let activeStore = null
function storeFor(path) {
  let store = hookStores.get(path)
  if (store === undefined) {
    store = { slots: [], index: 0 }
    hookStores.set(path, store)
  }
  store.index = 0
  return store
}
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  Fragment: Symbol('Fragment'),
  useState: (initial) => {
    if (activeStore === null) throw new Error('useState 被组件外调用')
    const store = activeStore
    const at = store.index++
    if (store.slots.length <= at) {
      store.slots.push({ value: typeof initial === 'function' ? initial() : initial })
    }
    const slot = store.slots[at]
    return [slot.value, (next) => {
      slot.value = typeof next === 'function' ? next(slot.value) : next
    }]
  },
  useEffect: () => {}, // 副作用不在冒烟测试的射程内：不跑，就不可能有未处理拒绝。
  useMemo: (factory, deps) => {
    const store = activeStore
    const at = store.index++
    const slot = store.slots[at]
    const same = slot !== undefined && Array.isArray(slot.deps)
      && Array.isArray(deps) && slot.deps.length === deps.length
      && slot.deps.every((value, i) => value === deps[i])
    if (same) return slot.value
    store.slots[at] = { deps, value: factory() }
    return store.slots[at].value
  },
  useRef: value => ({ current: value }),
}
const jsxRuntimeStub = {
  jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
  jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
  Fragment: Symbol('Fragment'),
}
const primitivesStub = { MenuItemButton: () => ({}) }
const moduleTable = {
  'react': reactStub,
  'react/jsx-runtime': jsxRuntimeStub,
  '@deepseek-ai/dsh-client-ui-primitives': primitivesStub,
}
const requested = []
const requireStub = specifier => {
  requested.push(specifier)
  if (!(specifier in moduleTable)) throw new Error(`模块表没有 ${specifier}`)
  return moduleTable[specifier]
}

let plugin
try {
  plugin = entry.factory(requireStub)
} catch (error) {
  console.error(`工厂执行时抛错：${String(error)}`)
  process.exit(1)
}

check('导出 name', plugin?.name === 'dsh-conversation-manager', `实际 ${String(plugin?.name)}`)
check('导出 apply 函数', typeof plugin?.apply === 'function')
check('导出 inject 数组', Array.isArray(plugin?.inject))
for (const service of ['slots', 'locale', 'remote', 'remote.workspaceFiles', 'sessions', 'workspaces', 'sidebarRightTabs', 'sidebarRight']) {
  check(`inject 声明了 ${service}`, plugin?.inject?.includes(service))
}
check('没有请求平台模块表之外的依赖', requested.every(s => s in moduleTable), requested.join(', '))

// ── 3. 假 ctx：记录 apply 的每一次注册 ───────────────────────────────────────
const recorded = { tabs: [], slots: [], locales: [], effects: [], tabOpens: [] }
const sessionsStub = {
  list: { getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready' }) },
  refresh: async () => {},
  search: async () => ({ ok: true, value: { items: [], hasMore: false } }),
  fork: async () => 'child',
  using: async (target, options, operation) => operation({
    sessionId: target,
    binding: { session: { rename: async title => ({ ok: true, value: { title } }) } },
  }),
}
const workspacesStub = {
  list: { getSnapshot: () => ({ items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null }) },
  initializeDefault: async () => undefined,
  pinSession: async () => {},
  unpinSession: async () => {},
  archiveSession: async () => {},
  unarchiveSession: async () => {},
}
const uiWorkspaceStub = { openSession: () => {}, startSession: () => {}, openWorkspace: async () => {}, forkSession: async () => 'x' }

const ctx = {
  effect: (fn, label) => { recorded.effects.push(label); const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  get: name => ({ sessions: sessionsStub, workspaces: workspacesStub, uiWorkspace: uiWorkspaceStub })[name],
  locale: {
    bind: ns => (key, params) => (params === undefined ? `${ns}.${key}` : `${ns}.${key}(${JSON.stringify(params)})`),
    register: (ns, dicts) => { recorded.locales.push({ ns, dicts }); return () => {} },
  },
  sidebarRightTabs: { register: definition => { recorded.tabs.push(definition); return () => {} } },
  sidebarRight: { openTab: (kind, options) => { recorded.tabOpens.push({ kind, options }) } },
  slots: {
    inject: (name, callback) => { callback(); return () => {} },
    register: (registration, component) => { recorded.slots.push({ registration, component }); return () => {} },
  },
}

try {
  plugin.apply(ctx)
} catch (error) {
  console.error(`apply(ctx) 抛错：${String(error)}\n${String(error?.stack ?? '')}`)
  process.exit(1)
}
check('apply(ctx) 未抛错', true)

// ── 4. 注册内容断言 ─────────────────────────────────────────────────────────
const tab = recorded.tabs[0]
check('注册了一个页签类型', recorded.tabs.length === 1)
check('页签 id 正确', tab?.id === 'dsh-conversation-manager', String(tab?.id))
check('页签 kind 正确', tab?.kind === 'conversation-manager', String(tab?.kind))
check('页签 priority 为 extension', tab?.priority === 'extension', String(tab?.priority))
check('title 是 thunk 且返回字符串', typeof tab?.title === 'function' && typeof tab.title('x') === 'string')
check('guide 是数组且有一条', Array.isArray(tab?.guide) && tab.guide.length === 1)
const guide = tab?.guide?.[0]
check('guide 条目有 id 与数字 order', typeof guide?.id === 'string' && typeof guide?.order === 'number')
check('guide title/description 是 thunk', typeof guide?.title === 'function' && typeof guide?.description === 'function')

const slotNames = recorded.slots.map(s => s.registration.name)
check('注册了正文 keyed slot', slotNames.includes('sidebar.right.pane.tab'))
check('注册了标题 keyed slot', slotNames.includes('sidebar.right.pane.tab.title'))
check('注册了会话行菜单项', slotNames.includes('sidebar.workspaces.session.menu.item'))
check('注册了会话头部按钮', slotNames.includes('conversation.session.header.actions'))
const bodySlot = recorded.slots.find(s => s.registration.name === 'sidebar.right.pane.tab')
check('正文 slot 的 key 等于页签 id', bodySlot?.registration.key === 'dsh-conversation-manager', String(bodySlot?.registration.key))
check('正文 slot 声明了 locale', bodySlot?.registration.locale === 'dsh-conversation-manager')
check('正文组件是函数', typeof bodySlot?.component === 'function')
const menuSlot = recorded.slots.find(s => s.registration.name === 'sidebar.workspaces.session.menu.item')
check('菜单项有 id 与数字 order', typeof menuSlot?.registration.id === 'string' && typeof menuSlot?.registration.order === 'number')

/* inject face：注册项把它投影给组件的能力。这里用桩服务真的跑一遍，
 * 验证"宿主只回 {sessionId, snippet} → 面板补齐"这条契约没有被写错。 */
const face = bodySlot?.registration.inject?.()
check('正文 slot 提供 inject face', face !== undefined && typeof face === 'object')
check('face 暴露搜索、打开、归档、刷新、读镜像', face !== undefined
  && typeof face.searchContent === 'function'
  && typeof face.openSession === 'function'
  && typeof face.setArchived === 'function'
  && typeof face.refreshSessions === 'function'
  && typeof face.readTrashMirror === 'function')

sessionsStub.search = async () => ({
  ok: true,
  value: { items: [{ sessionId: 's-1', snippet: '命中的一句话' }, { sessionId: 's-2' }, { snippet: '没有 id 应被丢弃' }], hasMore: true },
})
const searched = face === undefined ? undefined : await face.searchContent('  插件  ', new AbortController().signal)
check('搜索把宿主返回映射成命中（丢弃缺 sessionId 的条目）', searched?.ok === true
  && searched.hits.length === 2
  && searched.hits[0].sessionId === 's-1'
  && searched.hits[0].snippet === '命中的一句话'
  && searched.hits[1].snippet === undefined
  && searched.hasMore === true, JSON.stringify(searched))

let calledWith
sessionsStub.search = async (query) => { calledWith = query; return { ok: true, value: { items: [], hasMore: false } } }
await face.searchContent('  前后空格  ', new AbortController().signal)
check('搜索前会 trim 查询词（宿主拒绝空白查询）', calledWith === '前后空格', String(calledWith))

sessionsStub.search = async () => ({ ok: false, error: { code: 'SESSION_QUERY_SEARCH_DISABLED', message: 'search is disabled' } })
const disabled = await face.searchContent('任意', new AbortController().signal)
check('索引关闭时如实回传错误码（不能假装"没有结果"）', disabled.ok === false
  && disabled.code === 'SESSION_QUERY_SEARCH_DISABLED'
  && disabled.message === 'search is disabled', JSON.stringify(disabled))

sessionsStub.search = async () => ({ ok: true, value: { items: [{ sessionId: 's-3' }], hasMore: false } })
const blank = await face.searchContent('   ', new AbortController().signal)
check('空白查询不发请求（直接回空）', blank.ok === true && blank.hits.length === 0)

check('注册了 locale 字典', recorded.locales.length === 1)
const dicts = recorded.locales[0]?.dicts
check('字典同时含 en 与 zh', dicts !== undefined && dicts.en !== undefined && dicts.zh !== undefined)
check('en 与 zh 键集合一致', dicts !== undefined
  && JSON.stringify(Object.keys(dicts.en).sort()) === JSON.stringify(Object.keys(dicts.zh).sort()))
for (const lang of ['en', 'zh']) {
  check(`${lang} 字典有「筛选会话」三档的文案（三个档位 + 说明）`, dicts !== undefined
    && typeof dicts[lang]?.archivedFilterAll === 'string' && dicts[lang].archivedFilterAll.length > 0
    && typeof dicts[lang]?.archivedFilterHide === 'string' && dicts[lang].archivedFilterHide.length > 0
    && typeof dicts[lang]?.archivedFilterOnly === 'string' && dicts[lang].archivedFilterOnly.length > 0
    && typeof dicts[lang]?.archivedFilterHint === 'string' && dicts[lang].archivedFilterHint.length > 0,
  JSON.stringify({
    all: dicts?.[lang]?.archivedFilterAll,
    hide: dicts?.[lang]?.archivedFilterHide,
    only: dicts?.[lang]?.archivedFilterOnly,
  }))
  check(`${lang} 三个档位的文案互不相同`, dicts !== undefined
    && new Set([dicts[lang]?.archivedFilterAll, dicts[lang]?.archivedFilterHide, dicts[lang]?.archivedFilterOnly]).size === 3,
  JSON.stringify([dicts?.[lang]?.archivedFilterAll, dicts?.[lang]?.archivedFilterHide, dicts?.[lang]?.archivedFilterOnly]))
}
check('注册了样式 effect', recorded.effects.some(label => String(label).includes('styles')))

// ── 5. 激活探针 ─────────────────────────────────────────────────────────────
const probeRaw = storage.get('dsh-conversation-manager/activation')
check('激活探针写入了 localStorage', typeof probeRaw === 'string', String(probeRaw))
if (typeof probeRaw === 'string') {
  let log
  try { log = JSON.parse(probeRaw) } catch { log = undefined }
  check('探针记录的是数组', Array.isArray(log), JSON.stringify(log))
  check('记录了两条：enter + done', Array.isArray(log) && log.length === 2, JSON.stringify(log))
  check('第一条是 enter', log?.[0]?.phase === 'enter')
  check('第二条是 done 且 ok', log?.[1]?.phase === 'done' && log[1]?.ok === true, JSON.stringify(log?.[1]))
  check('done 记录了注册的 slot 名', Array.isArray(log?.[1]?.slots) && log[1].slots.includes('sidebar.right.pane.tab'))
  check('每条都有时间戳', log?.every(entry => typeof entry?.at === 'string'))
}

// ── 6. 面板行为：「筛选会话」三档下拉 ──────────────────────────────────────
/* 极简渲染器：把正文组件的 JSX 树摊平成宿主元素清单（元素 + 属性 + 其下文本）。
 * 只做三件事：函数组件按渲染路径分格存 hook 状态、Fragment 展开、其余原样收集。
 * 不跑 effect —— 所以这里不会有任何网络、定时器或未处理拒绝。 */
function invokeComponent(fn, props, path) {
  const previous = activeStore
  activeStore = storeFor(path)
  try {
    return fn(props)
  } finally {
    activeStore = previous
  }
}
function walk(node, path, host) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child, index) => walk(child, `${path}[${index}]`, host)).join('')
  if (typeof node !== 'object') return ''
  const { type, props } = node
  if (type === undefined) return ''
  if (typeof type === 'function') {
    const childPath = `${path}/${type.name === '' || type.name === undefined ? 'anonymous' : type.name}`
    return walk(invokeComponent(type, props ?? {}, childPath), childPath, host)
  }
  if (typeof type === 'symbol') return walk(props?.children, `${path}/fragment`, host)
  const text = walk(props?.children, `${path}/${String(type)}`, host)
  host.push({ type, props, path, text })
  return text
}
let panelSeq = 0
/** 渲染一次正文。path 不传就新开一格状态（等于"重新打开面板"），传同一个值则延续状态。 */
function renderPanel(props, path) {
  const used = path ?? `panel-${++panelSeq}`
  const host = []
  walk(invokeComponent(bodySlot.component, props, used), used, host)
  return host
}

/* 固定夹具：一个未归档 + 一个已归档的示例行（中性词，不含任何真实对话内容）。 */
function panelFixture() {
  const sessions = {
    ids: ['s-live', 's-archived'],
    byId: {
      's-live': { id: 's-live', displayTitle: '示例对话（未归档）', running: true, blank: false, updatedAt: 2000 },
      's-archived': { id: 's-archived', displayTitle: '示例对话（已归档）', running: false, blank: false, updatedAt: 1000 },
    },
    phase: 'ready',
  }
  const status = new Map([
    ['s-live', { running: true, pendingInteraction: false, completionUnread: false }],
    ['s-archived', { running: false, pendingInteraction: false, completionUnread: false }],
  ])
  const workspaces = {
    items: [{ workspaceId: 'w-demo', title: '示例工作区', path: '/tmp/demo', sessionIds: ['s-live', 's-archived'] }],
    archivedSessionIds: ['s-archived'],
    pinnedSessionIds: [],
  }
  // t 保持可断言：带参数时把参数也拼进文本，测试直接读得到数字。
  const t = (key, params) => (params === undefined ? key : `${key}=${JSON.stringify(params)}`)
  return {
    t,
    useSessions: selector => selector(sessions),
    useSessionStatus: selector => selector(status),
    useWorkspaces: selector => selector(workspaces),
    useSession: selector => selector({ sessionId: 's-panel' }),
    openSession: () => ({ ok: true }),
    setArchived: async () => ({ ok: true }),
    readTrashMirror: async () => ({ ok: false, code: 'not-needed-in-smoke' }),
    refreshSessions: async () => ({ ok: true }),
    searchContent: async () => ({ ok: true, hits: [], hasMore: false }),
  }
}
const ARCHIVED_FILTER_KEY = 'dsh-conversation-manager/show-archived'
/** 只取总表数据行（表头的 tr 没有 dshm-row 类名）。 */
const dataRows = host => host.filter(node => typeof node.props?.className === 'string' && node.props.className.includes('dshm-row'))
const rowTitles = host => dataRows(host).map(node => node.text)
/** 找到「筛选会话」三档下拉：靠它的说明文案（title）定位，再读/写它的取值。 */
function archivedSelect(host) {
  return host.find(node => node.type === 'select' && node.props?.title === 'archivedFilterHint')
}
/** 下拉里三个档位的 value 列表（顺序即渲染顺序）。 */
function archivedOptions(host) {
  const children = archivedSelect(host)?.props?.children
  const list = Array.isArray(children) ? children : children === undefined ? [] : [children]
  return list.map(option => option?.props?.value).filter(value => typeof value === 'string')
}
/** 把下拉切到某一档（等于用户在下拉里点了一下）。 */
function pickArchivedFilter(host, value) {
  archivedSelect(host)?.props?.onChange({ target: { value } })
}
const badgeText = (host, prefix) => host.find(node => node.type === 'span' && node.text.startsWith(prefix))?.text

// 6.1 没存过取值 = 默认「全部对话」（本插件一直以来的行为）。
storage.delete(ARCHIVED_FILTER_KEY)
{
  const host = renderPanel(panelFixture())
  check('默认把已归档的行也列出来', rowTitles(host).length === 2
    && rowTitles(host).some(text => text.includes('示例对话（已归档）')), JSON.stringify(rowTitles(host)))
  check('三档下拉默认停在「全部对话」', archivedSelect(host)?.props?.value === 'all',
    String(archivedSelect(host)?.props?.value))
  check('下拉恰好提供三档：全部 / 隐藏已归档 / 仅显示已归档',
    JSON.stringify(archivedOptions(host)) === JSON.stringify(['all', 'hide', 'only']), JSON.stringify(archivedOptions(host)))
  check('下拉挂着说明（与侧栏同名功能对齐、搜索结果不受它限制）',
    archivedSelect(host)?.props?.title === 'archivedFilterHint', String(archivedSelect(host)?.props?.title))
  check('时间筛选未开、档位为「全部」时不出「符合条件」徽标',
    badgeText(host, 'filteredCount=') === undefined, String(badgeText(host, 'filteredCount=')))
}

// 6.2 旧版存过 'false'（布尔）→ 迁移成「隐藏已归档」。
storage.set(ARCHIVED_FILTER_KEY, 'false')
{
  const host = renderPanel(panelFixture())
  const titles = rowTitles(host)
  check('旧值 \'false\' 迁移为「隐藏已归档」：已归档的行从总表消失',
    titles.length === 1 && titles[0].includes('示例对话（未归档）'), JSON.stringify(titles))
  check('迁移后下拉如实显示在「隐藏已归档」档', archivedSelect(host)?.props?.value === 'hide',
    String(archivedSelect(host)?.props?.value))
  check('顶部统计仍如实报告 1 个已归档（统计不跟着筛选）',
    badgeText(host, 'statsLine=')?.includes('"archived":1') === true, String(badgeText(host, 'statsLine=')))
  check('隐藏后补出当前可见条数徽标', badgeText(host, 'filteredCount=')?.includes('"count":1') === true,
    String(badgeText(host, 'filteredCount=')))
}

// 6.3 旧版存过 'true' → 迁移成「全部对话」。
storage.set(ARCHIVED_FILTER_KEY, 'true')
{
  const host = renderPanel(panelFixture())
  check('旧值 \'true\' 迁移为「全部对话」：两行都在', rowTitles(host).length === 2, JSON.stringify(rowTitles(host)))
  check('迁移后下拉停在「全部对话」档', archivedSelect(host)?.props?.value === 'all',
    String(archivedSelect(host)?.props?.value))
}

// 6.4 新增档「仅显示已归档」：总表里只剩已归档的行。
storage.set(ARCHIVED_FILTER_KEY, 'only')
{
  const host = renderPanel(panelFixture())
  const titles = rowTitles(host)
  check('「仅显示已归档」：总表里只剩已归档的那一行',
    titles.length === 1 && titles[0].includes('示例对话（已归档）'), JSON.stringify(titles))
  check('未归档的行在该档下不出现', !titles.some(text => text.includes('示例对话（未归档）')), JSON.stringify(titles))
  check('该档同样补出可见条数徽标', badgeText(host, 'filteredCount=')?.includes('"count":1') === true,
    String(badgeText(host, 'filteredCount=')))
}

// 6.5 换档：把取值写进 localStorage（面板重开后仍是这个取舍），且不认识的取值回落到「全部」。
storage.set(ARCHIVED_FILTER_KEY, 'all')
{
  const props = panelFixture()
  const path = 'panel-archived-filter'
  check('切换前：两行都在', rowTitles(renderPanel(props, path)).length === 2)
  pickArchivedFilter(renderPanel(props, path), 'only')
  const only = renderPanel(props, path)
  check('切到「仅显示已归档」：只剩已归档的行', rowTitles(only).length === 1
    && rowTitles(only)[0].includes('示例对话（已归档）'), JSON.stringify(rowTitles(only)))
  check('取值写进了 localStorage', storage.get(ARCHIVED_FILTER_KEY) === 'only', String(storage.get(ARCHIVED_FILTER_KEY)))
  pickArchivedFilter(only, 'hide')
  const hidden = renderPanel(props, path)
  check('切到「隐藏已归档」：只剩未归档的行', rowTitles(hidden).length === 1
    && rowTitles(hidden)[0].includes('示例对话（未归档）'), JSON.stringify(rowTitles(hidden)))
  check('取值同样被记住', storage.get(ARCHIVED_FILTER_KEY) === 'hide', String(storage.get(ARCHIVED_FILTER_KEY)))
  pickArchivedFilter(hidden, 'all')
  const all = renderPanel(props, path)
  check('切回「全部对话」：两行都回来', rowTitles(all).length === 2, JSON.stringify(rowTitles(all)))
  check('回落后取值也是 all', storage.get(ARCHIVED_FILTER_KEY) === 'all', String(storage.get(ARCHIVED_FILTER_KEY)))
}

// 6.6 存了不认识的取值 → 回落到默认的「全部对话」，不能白屏或空表。
storage.set(ARCHIVED_FILTER_KEY, 'nonsense')
{
  const host = renderPanel(panelFixture())
  check('无法识别的存储取值回落到「全部对话」', archivedSelect(host)?.props?.value === 'all'
    && rowTitles(host).length === 2, `${String(archivedSelect(host)?.props?.value)} / ${JSON.stringify(rowTitles(host))}`)
}

// ── 报告 ────────────────────────────────────────────────────────────────────
for (const item of checks) console.log(`${item.ok ? '✓' : '✗'} ${item.label}${item.ok ? '' : ` — ${item.detail}`}`)
console.log(`\n${checks.length - failures.length}/${checks.length} 项通过`)
if (failures.length > 0) {
  console.error('\n失败项：')
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('通过：产物可加载，插件契约与注册内容符合预期。')
