// 文档脑图插件：把当前 Markdown 渲染成 Markmap（和你截图那种一模一样的图）。
// 目标：不改宿主；UI 永久驻留（不因失焦关闭）；导出 SVG/PNG。

const MM_LS_LOCALE_KEY = 'flymd.locale'
function mmDetectLocale() {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : null
    const lang = (nav && (nav.language || nav.userLanguage)) || 'en'
    const lower = String(lang || '').toLowerCase()
    if (lower.startsWith('zh')) return 'zh'
  } catch {}
  return 'en'
}
function mmGetLocale() {
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage : null
    const v = ls && ls.getItem(MM_LS_LOCALE_KEY)
    if (v === 'zh' || v === 'en') return v
  } catch {}
  return mmDetectLocale()
}
function mmText(zh, en) {
  return mmGetLocale() === 'en' ? en : zh
}

const PLUGIN_ID = 'doc-mindmap'
const PANEL_WIDTH = 420
const PANEL_MIN_WIDTH = 260
const PANEL_MAX_WIDTH = 980

const STORAGE_KEY = `${PLUGIN_ID}:settings`
const DEFAULT_SETTINGS = {
  autoRefresh: true,
  maxDepth: 6,
  // 长文本节点换行：用 markmap 的 maxWidth 限制节点最大宽度，再配合 CSS 让文本真正换行。
  // wrapWidth: 0 表示自动（随面板宽度计算）。
  wrapText: true,
  wrapWidth: 0,
  pngScale: 2,
  pngBackground: 'auto', // 'auto' | 'transparent' | '#ffffff' | '#111111'
  panelWidth: PANEL_WIDTH,
}

let _ctx = null
let _dockHandle = null
let _panelRoot = null
let _toolbarEl = null
let _optsEl = null
let _graphWrap = null
let _resizerEl = null
let _statusEl = null
let _timer = null
let _panelVisible = false
let _lastHash = ''
let _lastMd = ''
let _lastSvg = ''
let _markmapLoading = null
let _markmapCssInjected = false
let _transformer = null
let _mmPanel = null
let _panelSvg = null
let _themeListenerBound = false
let _onThemeChanged = null
let _settings = { ...DEFAULT_SETTINGS }
let _disposeCtxMenu = null

// AI 提纲（可选）：只影响脑图渲染，不改文档内容。
let _aiMode = false
let _aiBusy = false
let _aiOutlineMd = ''
let _aiOutlineDocHash = ''
let _aiBtnEl = null
let _aiOriginBtnEl = null
let _lastRenderUsedAi = false

// 全屏遮罩（覆盖文档的 JS 弹窗）：只允许通过按钮关闭，不因失焦/点击遮罩关闭。
let _fsVisible = false
let _fsRoot = null
let _fsScaleLabel = null
let _prevBodyOverflow = ''
let _fsSvg = null
let _mmFs = null

function getDoc() {
  return window.document
}

function isDarkMode() {
  try {
    const doc = getDoc()
    if (doc && doc.body && doc.body.classList.contains('dark-mode')) return true
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return true
    }
  } catch {}
  return false
}

function getWorkspaceContainer() {
  try {
    return getDoc().querySelector('.container')
  } catch {}
  return null
}

function safeNotice(ctx, msgZh, msgEn, type = 'ok', ms = 2200) {
  try {
    ctx && ctx.ui && ctx.ui.notice && ctx.ui.notice(mmText(msgZh, msgEn), type, ms)
  } catch {}
}

function clampInt(n, min, max, fallback) {
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, v))
}

async function loadSettings(ctx) {
  try {
    const raw = await ctx.storage.get(STORAGE_KEY)
    if (raw && typeof raw === 'object') {
      _settings = { ...DEFAULT_SETTINGS, ...raw }
      _settings.maxDepth = clampInt(_settings.maxDepth, 1, 20, DEFAULT_SETTINGS.maxDepth)
      _settings.wrapText = !!_settings.wrapText
      _settings.wrapWidth = clampWrapWidth(_settings.wrapWidth)
      _settings.pngScale = clampInt(_settings.pngScale, 1, 6, DEFAULT_SETTINGS.pngScale)
      _settings.panelWidth = clampInt(_settings.panelWidth, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH, DEFAULT_SETTINGS.panelWidth)
      return
    }
  } catch {}
  _settings = { ...DEFAULT_SETTINGS }
}

async function saveSettings(ctx) {
  try {
    await ctx.storage.set(STORAGE_KEY, _settings)
  } catch {}
}

function ensurePanelMounted(ctx) {
  if (_panelRoot) return

  const container = getWorkspaceContainer()
  if (!container) {
    safeNotice(ctx, '未找到工作区容器，无法挂载面板', 'Workspace container not found, cannot mount panel', 'err', 2600)
    return
  }

  const root = getDoc().createElement('div')
  root.id = `${PLUGIN_ID}-panel-root`
  root.style.position = 'absolute'
  root.style.top = '0'
  root.style.right = '0'
  root.style.bottom = 'var(--workspace-bottom-gap, 0px)'
  root.style.width = String(clampInt(_settings.panelWidth, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH, PANEL_WIDTH)) + 'px'
  root.style.height = 'auto'
  root.style.overflow = 'hidden'
  root.style.borderLeft = '1px solid rgba(0,0,0,0.08)'
  root.style.background = 'var(--bg-color, #fafafa)'
  root.style.display = _panelVisible ? 'flex' : 'none'
  root.style.flexDirection = 'column'
  root.style.zIndex = '8'
  root.style.boxSizing = 'border-box'

  // 拖拽改变面板宽度：做成“左侧把手”，简单直接。
  const resizer = getDoc().createElement('div')
  resizer.title = mmText('拖拽调整面板宽度', 'Drag to resize panel')
  resizer.style.position = 'absolute'
  resizer.style.left = '0'
  resizer.style.top = '0'
  resizer.style.bottom = '0'
  resizer.style.width = '6px'
  resizer.style.cursor = 'col-resize'
  resizer.style.zIndex = '9'
  resizer.style.background = 'transparent'
  resizer.style.touchAction = 'none'
  resizer.addEventListener('mouseenter', () => { try { resizer.style.background = 'rgba(0,0,0,0.06)' } catch {} })
  resizer.addEventListener('mouseleave', () => { try { resizer.style.background = 'transparent' } catch {} })

  let dragging = false
  let startX = 0
  let startW = 0
  const onMove = (ev) => {
    if (!dragging) return
    try { ev.preventDefault() } catch {}
    const dx = (Number(ev.clientX) || 0) - startX
    const nextW = clampInt(startW - dx, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH, startW)
    _settings.panelWidth = nextW
    try { root.style.width = String(nextW) + 'px' } catch {}
    try { if (_dockHandle) _dockHandle.setSize(nextW) } catch {}
  }
  const onUp = async () => {
    if (!dragging) return
    dragging = false
    try { getDoc().body.style.cursor = '' } catch {}
    try { getDoc().body.style.userSelect = '' } catch {}
    try { window.removeEventListener('pointermove', onMove) } catch {}
    try { window.removeEventListener('pointerup', onUp) } catch {}
    try { await saveSettings(ctx) } catch {}
    // 尺寸变化后做一次 fit，避免图挤在角落。
    try { if (_mmPanel) await _mmPanel.fit() } catch {}
    // 自动换行宽度依赖面板尺寸，拖拽结束后强制重渲染一次，别靠运气。
    try {
      if (_settings.wrapText && !clampWrapWidth(_settings.wrapWidth)) {
        renderMindmap(ctx, { force: true })
      }
    } catch {}
  }
  resizer.addEventListener('pointerdown', (ev) => {
    try { ev.preventDefault() } catch {}
    try { ev.stopPropagation() } catch {}
    dragging = true
    startX = Number(ev.clientX) || 0
    startW = clampInt(_settings.panelWidth, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH, PANEL_WIDTH)
    try { resizer.setPointerCapture(ev.pointerId) } catch {}
    try { getDoc().body.style.cursor = 'col-resize' } catch {}
    try { getDoc().body.style.userSelect = 'none' } catch {}
    try { window.addEventListener('pointermove', onMove, { passive: false }) } catch {}
    try { window.addEventListener('pointerup', onUp, { passive: true }) } catch {}
  })

  const toolbar = getDoc().createElement('div')
  toolbar.style.display = 'flex'
  toolbar.style.alignItems = 'center'
  toolbar.style.gap = '8px'
  toolbar.style.padding = '8px 10px'
  toolbar.style.borderBottom = '1px solid rgba(0,0,0,0.08)'

  const title = getDoc().createElement('div')
  title.textContent = mmText('文档脑图', 'Doc Mindmap')
  title.style.fontWeight = '600'
  title.style.flex = '1'

  const mkBtn = (label, onClick) => {
    const b = getDoc().createElement('button')
    b.type = 'button'
    b.textContent = label
    b.style.border = '1px solid rgba(0,0,0,0.15)'
    b.style.background = 'var(--bg-color, #fafafa)'
    b.style.color = 'var(--text-color, #222)'
    b.style.borderRadius = '6px'
    b.style.padding = '4px 8px'
    b.style.cursor = 'pointer'
    b.addEventListener('click', (ev) => {
      try { ev.preventDefault() } catch {}
      try { onClick && onClick() } catch {}
    })
    return b
  }

  const refreshBtn = mkBtn(mmText('刷新', 'Refresh'), () => renderMindmap(ctx, { force: true }))
  const zoomBtn = mkBtn(mmText('全屏', 'Fullscreen'), () => setFullscreenVisible(ctx, true))
  zoomBtn.title = mmText('全屏放大查看（遮挡文档）', 'Fullscreen overlay (cover document)')
  const aiBtn = mkBtn(mmText('AI提纲', 'AI Outline'), () => onAiOutlineClicked(ctx))
  aiBtn.title = mmText('用 AI 把文档整理成可读的提纲（只用于脑图，不改文档）', 'Ask AI to generate an outline for mindmap (view-only)')
  const originBtn = mkBtn(mmText('原文', 'Original'), () => setAiMode(ctx, false))
  originBtn.title = mmText('切回用原文渲染', 'Render with original document')
  originBtn.style.display = 'none'
  const exportSvgBtn = mkBtn(mmText('导出SVG', 'Export SVG'), () => exportSvg(ctx))
  const exportPngBtn = mkBtn(mmText('导出PNG', 'Export PNG'), () => exportPng(ctx))
  const closeBtn = mkBtn('X', () => setPanelVisible(ctx, false))
  closeBtn.title = mmText('关闭面板', 'Close panel')

  toolbar.appendChild(title)
  toolbar.appendChild(refreshBtn)
  toolbar.appendChild(zoomBtn)
  toolbar.appendChild(aiBtn)
  toolbar.appendChild(originBtn)
  toolbar.appendChild(exportSvgBtn)
  toolbar.appendChild(exportPngBtn)
  toolbar.appendChild(closeBtn)

  _aiBtnEl = aiBtn
  _aiOriginBtnEl = originBtn
  syncAiButtons()

  const opts = getDoc().createElement('div')
  opts.style.display = 'flex'
  opts.style.alignItems = 'center'
  opts.style.gap = '10px'
  opts.style.padding = '6px 10px'
  opts.style.borderBottom = '1px solid rgba(0,0,0,0.06)'
  opts.style.fontSize = '12px'

  const mkCheck = (labelZh, labelEn, key) => {
    const wrap = getDoc().createElement('label')
    wrap.style.display = 'inline-flex'
    wrap.style.alignItems = 'center'
    wrap.style.gap = '6px'
    wrap.style.userSelect = 'none'
    const cb = getDoc().createElement('input')
    cb.type = 'checkbox'
    cb.checked = !!_settings[key]
    cb.addEventListener('change', async () => {
      _settings[key] = !!cb.checked
      await saveSettings(ctx)
      renderMindmap(ctx, { force: true })
    })
    const span = getDoc().createElement('span')
    span.textContent = mmText(labelZh, labelEn)
    wrap.appendChild(cb)
    wrap.appendChild(span)
    return wrap
  }

  const autoCb = mkCheck('自动刷新', 'Auto', 'autoRefresh')

  const depthWrap = getDoc().createElement('label')
  depthWrap.style.display = 'inline-flex'
  depthWrap.style.alignItems = 'center'
  depthWrap.style.gap = '6px'
  depthWrap.style.userSelect = 'none'
  const depthTxt = getDoc().createElement('span')
  depthTxt.textContent = mmText('深度', 'Depth')
  const depthInput = getDoc().createElement('input')
  depthInput.type = 'number'
  depthInput.min = '1'
  depthInput.max = '20'
  depthInput.value = String(_settings.maxDepth)
  depthInput.style.width = '56px'
  depthInput.addEventListener('change', async () => {
    _settings.maxDepth = clampInt(depthInput.value, 1, 20, DEFAULT_SETTINGS.maxDepth)
    depthInput.value = String(_settings.maxDepth)
    await saveSettings(ctx)
    renderMindmap(ctx, { force: true })
  })
  depthWrap.appendChild(depthTxt)
  depthWrap.appendChild(depthInput)

  // 长文本换行（maxWidth + CSS）
  const wrapOpt = getDoc().createElement('label')
  wrapOpt.style.display = 'inline-flex'
  wrapOpt.style.alignItems = 'center'
  wrapOpt.style.gap = '6px'
  wrapOpt.style.userSelect = 'none'
  const wrapCb = getDoc().createElement('input')
  wrapCb.type = 'checkbox'
  wrapCb.checked = !!_settings.wrapText
  const wrapTxt = getDoc().createElement('span')
  wrapTxt.textContent = mmText('换行', 'Wrap')
  wrapOpt.appendChild(wrapCb)
  wrapOpt.appendChild(wrapTxt)

  const wrapWidthWrap = getDoc().createElement('label')
  wrapWidthWrap.style.display = _settings.wrapText ? 'inline-flex' : 'none'
  wrapWidthWrap.style.alignItems = 'center'
  wrapWidthWrap.style.gap = '6px'
  wrapWidthWrap.style.userSelect = 'none'
  const wrapWidthTxt = getDoc().createElement('span')
  wrapWidthTxt.textContent = mmText('宽度', 'Width')
  const wrapWidthInput = getDoc().createElement('input')
  wrapWidthInput.type = 'number'
  wrapWidthInput.min = '0'
  wrapWidthInput.max = '1200'
  wrapWidthInput.value = String(clampWrapWidth(_settings.wrapWidth))
  wrapWidthInput.placeholder = '0'
  wrapWidthInput.style.width = '64px'
  wrapWidthInput.title = mmText('0=自动，单位像素', '0=auto, px')
  wrapWidthInput.addEventListener('change', async () => {
    _settings.wrapWidth = clampWrapWidth(wrapWidthInput.value)
    wrapWidthInput.value = String(_settings.wrapWidth)
    await saveSettings(ctx)
    renderMindmap(ctx, { force: true })
  })
  wrapWidthWrap.appendChild(wrapWidthTxt)
  wrapWidthWrap.appendChild(wrapWidthInput)

  wrapCb.addEventListener('change', async () => {
    _settings.wrapText = !!wrapCb.checked
    wrapWidthWrap.style.display = _settings.wrapText ? 'inline-flex' : 'none'
    await saveSettings(ctx)
    renderMindmap(ctx, { force: true })
  })

  opts.appendChild(autoCb)
  opts.appendChild(depthWrap)
  opts.appendChild(wrapOpt)
  opts.appendChild(wrapWidthWrap)

  const graphWrap = getDoc().createElement('div')
  graphWrap.style.flex = '1'
  graphWrap.style.overflow = 'hidden'
  graphWrap.style.padding = '0'
  graphWrap.style.background = 'transparent'

  const status = getDoc().createElement('div')
  status.style.fontSize = '12px'
  status.style.opacity = '0.8'
  status.style.padding = '6px 10px'
  status.style.borderTop = '1px solid rgba(0,0,0,0.06)'
  status.textContent = mmText('就绪', 'Ready')

  root.appendChild(toolbar)
  root.appendChild(opts)
  root.appendChild(graphWrap)
  root.appendChild(status)
  root.appendChild(resizer)

  container.appendChild(root)
  _panelRoot = root
  _toolbarEl = toolbar
  _optsEl = opts
  _graphWrap = graphWrap
  _resizerEl = resizer
  _statusEl = status
}

function setPanelVisible(ctx, visible) {
  _panelVisible = !!visible
  if (_dockHandle) _dockHandle.setVisible(_panelVisible)
  if (_panelRoot) _panelRoot.style.display = _panelVisible ? 'flex' : 'none'
  if (_panelVisible) {
    ensureTimer(ctx)
    renderMindmap(ctx, { force: true })
  } else {
    stopTimer()
  }
}

function getCurrentSvgElement() {
  try {
    // 全屏优先，其次是右侧面板
    if (_fsVisible && _fsSvg) return _fsSvg
    if (_panelSvg) return _panelSvg
  } catch {}
  return null
}

function updateFullscreenTheme() {
  try {
    if (!_fsRoot) return
    const dark = isDarkMode()
    _fsRoot.style.background = dark ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.35)'
    const box = _fsRoot.querySelector(`.${PLUGIN_ID}-fs-box`)
    if (box) {
      box.style.background = dark ? '#0f0f0f' : '#ffffff'
      box.style.color = dark ? '#f0f0f0' : '#111111'
    }
    const toolbar = _fsRoot.querySelector(`.${PLUGIN_ID}-fs-toolbar`)
    if (toolbar) {
      toolbar.style.background = dark
        ? 'rgba(0,0,0,0.45)'
        : 'rgba(255,255,255,0.75)'
      toolbar.style.border = '1px solid rgba(0,0,0,0.12)'
    }
  } catch {}
}

function ensureFullscreenMounted(ctx) {
  if (_fsRoot) return
  const doc = getDoc()
  const root = doc.createElement('div')
  root.id = `${PLUGIN_ID}-fullscreen`
  root.style.position = 'fixed'
  root.style.left = '0'
  root.style.top = '0'
  root.style.width = '100vw'
  root.style.height = '100vh'
  root.style.zIndex = '9999'
  root.style.display = 'none'
  root.style.alignItems = 'stretch'
  root.style.justifyContent = 'stretch'
  // 不允许点遮罩关闭：什么都不做即可；遮罩本身会阻止事件穿透到文档。

  const box = doc.createElement('div')
  box.className = `${PLUGIN_ID}-fs-box`
  box.style.position = 'absolute'
  box.style.left = '0'
  box.style.top = '0'
  box.style.right = '0'
  box.style.bottom = '0'
  box.style.overflow = 'hidden'

  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.classList.add(`${PLUGIN_ID}-fs-svg`)
  try { svg.classList.add('markmap') } catch {}
  svg.style.width = '100%'
  svg.style.height = '100%'
  svg.style.display = 'block'
  svg.setAttribute('role', 'img')
  box.appendChild(svg)

  const toolbar = doc.createElement('div')
  toolbar.className = `${PLUGIN_ID}-fs-toolbar`
  toolbar.style.position = 'absolute'
  toolbar.style.right = '12px'
  toolbar.style.top = '10px'
  toolbar.style.display = 'flex'
  toolbar.style.alignItems = 'center'
  toolbar.style.gap = '8px'
  toolbar.style.padding = '8px 10px'
  toolbar.style.borderRadius = '12px'
  toolbar.style.backdropFilter = 'blur(6px)'
  toolbar.style.userSelect = 'none'
  toolbar.addEventListener('click', (ev) => {
    try { ev.stopPropagation() } catch {}
  })

  const mkBtn = (label, titleText, onClick) => {
    const b = doc.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.title = titleText || ''
    b.style.border = '1px solid rgba(0,0,0,0.15)'
    b.style.background = 'transparent'
    b.style.color = 'inherit'
    b.style.borderRadius = '8px'
    b.style.padding = '4px 10px'
    b.style.cursor = 'pointer'
    b.addEventListener('click', (ev) => {
      try { ev.preventDefault() } catch {}
      try { ev.stopPropagation() } catch {}
      try { onClick && onClick(ev) } catch {}
    })
    return b
  }

  const scaleLabel = doc.createElement('span')
  scaleLabel.style.fontSize = '12px'
  scaleLabel.style.opacity = '0.9'
  scaleLabel.textContent = '100%'
  _fsScaleLabel = scaleLabel

  const getScale = () => {
    try {
      const d3 = window.d3
      if (!d3 || !_fsSvg) return 1
      const t = d3.zoomTransform(_fsSvg)
      return Number(t && t.k) || 1
    } catch {}
    return 1
  }
  const refreshScaleLabel = () => {
    try {
      const k = getScale()
      if (_fsScaleLabel) _fsScaleLabel.textContent = `${Math.round(k * 100)}%`
    } catch {}
  }

  const minusBtn = mkBtn('-', mmText('缩小', 'Zoom out'), async () => {
    try { if (_mmFs) await _mmFs.rescale(1 / 1.15) } catch {}
    setTimeout(refreshScaleLabel, 0)
  })
  const plusBtn = mkBtn('+', mmText('放大', 'Zoom in'), async () => {
    try { if (_mmFs) await _mmFs.rescale(1.15) } catch {}
    setTimeout(refreshScaleLabel, 0)
  })
  const resetBtn = mkBtn('100%', mmText('重置到 100%', 'Reset to 100%'), async () => {
    try {
      const cur = getScale()
      if (_mmFs && cur > 0) await _mmFs.rescale(1 / cur)
    } catch {}
    setTimeout(refreshScaleLabel, 0)
  })
  const fitBtn = mkBtn(mmText('适配', 'Fit'), mmText('适配屏幕', 'Fit to screen'), async () => {
    try { if (_mmFs) await _mmFs.fit() } catch {}
    setTimeout(refreshScaleLabel, 0)
  })
  const exitBtn = mkBtn(mmText('退出', 'Exit'), mmText('退出全屏查看', 'Exit fullscreen'), () => setFullscreenVisible(ctx, false))
  const closeAllBtn = mkBtn('X', mmText('关闭', 'Close'), () => {
    setFullscreenVisible(ctx, false)
    setPanelVisible(ctx, false)
  })

  toolbar.appendChild(minusBtn)
  toolbar.appendChild(plusBtn)
  toolbar.appendChild(scaleLabel)
  toolbar.appendChild(resetBtn)
  toolbar.appendChild(fitBtn)
  toolbar.appendChild(exitBtn)
  toolbar.appendChild(closeAllBtn)

  box.appendChild(toolbar)
  root.appendChild(box)
  doc.body.appendChild(root)

  _fsRoot = root
  _fsSvg = svg

  updateFullscreenTheme()
}

function setFullscreenVisible(ctx, visible) {
  _fsVisible = !!visible
  ensureFullscreenMounted(ctx)
  if (!_fsRoot) return

  if (_fsVisible) {
    try {
      _prevBodyOverflow = getDoc().body.style.overflow || ''
      getDoc().body.style.overflow = 'hidden'
    } catch {}
    _fsRoot.style.display = 'flex'
    updateFullscreenTheme()
    // 全屏打开时强制渲染一次，并默认 fit。
    renderMindmapFullscreen(ctx, { force: true }).then(() => {
      try {
        if (_mmFs) _mmFs.fit()
      } catch {}
      try {
        const d3 = window.d3
        if (_fsScaleLabel && d3 && _fsSvg) {
          const k = Number(d3.zoomTransform(_fsSvg).k) || 1
          _fsScaleLabel.textContent = `${Math.round(k * 100)}%`
        }
      } catch {}
    })
    return
  }

  _fsRoot.style.display = 'none'
  try { getDoc().body.style.overflow = _prevBodyOverflow } catch {}
  _prevBodyOverflow = ''
}

function stopTimer() {
  if (_timer) {
    try { clearInterval(_timer) } catch {}
    _timer = null
  }
}

function ensureTimer(ctx) {
  stopTimer()
  if (!_settings.autoRefresh) return
  // 宿主暂未提供「内容变更事件」，用轮询做最小实现；靠哈希避免无意义重绘。
  _timer = setInterval(() => {
    try {
      if (!_panelVisible) return
      renderMindmap(ctx, { force: false })
    } catch {}
  }, 450)
}

function bindThemeListener(ctx) {
  if (_themeListenerBound) return
  _themeListenerBound = true
  try {
    _onThemeChanged = () => {
      try {
        if (_panelVisible) {
          // 主题变化后重绘（Markmap 继承页面配色，但仍建议刷新一次）。
          renderMindmap(ctx, { force: true })
        }
      } catch {}
      try {
        // 全屏遮罩也需要跟随主题刷新配色与背景。
        if (_fsVisible) {
          updateFullscreenTheme()
          renderMindmapFullscreen(ctx, { force: true })
        }
      } catch {}
    }
    window.addEventListener('flymd:theme:changed', _onThemeChanged)
  } catch {}
}

function hashText(s) {
  // 轻量 hash：避免引入依赖；只用于轮询去重，不做安全用途。
  const str = String(s || '')
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16)
}

function getRootLabel(ctx, md) {
  try {
    const p = ctx.getCurrentFilePath && ctx.getCurrentFilePath()
    if (p) {
      const name = String(p).split(/[/\\\\]/).pop() || ''
      if (name) return name.replace(/\.(md|markdown|txt)$/i, '')
    }
  } catch {}
  // 兜底：用第一行标题，否则用固定文本
  try {
    const m = String(md || '').match(/^#\s+(.+)$/m)
    if (m && m[1]) return m[1].trim()
  } catch {}
  return mmText('未命名文档', 'Untitled')
}

const WRAP_CSS_ATTR = `data-${PLUGIN_ID}-wrap-css`
function ensureWrapCssInjected() {
  try {
    const existed = getDoc().querySelector(`style[${WRAP_CSS_ATTR}="1"]`)
    if (existed) return
    const st = getDoc().createElement('style')
    st.setAttribute(WRAP_CSS_ATTR, '1')
    // 只在 SVG 加了 `${PLUGIN_ID}-wrap` 类时才生效，避免影响别的 markmap 实例。
    st.textContent = `
      svg.${PLUGIN_ID}-wrap foreignObject,
      svg.${PLUGIN_ID}-wrap foreignObject * { overflow: visible; }

      svg.${PLUGIN_ID}-wrap foreignObject > div {
        white-space: pre-wrap;
        word-break: break-word;
        overflow-wrap: anywhere;
      }
    `.trim()
    getDoc().head.appendChild(st)
  } catch {}
}

function clampWrapWidth(n) {
  // 0 = 自动
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v) || v <= 0) return 0
  return Math.max(120, Math.min(1200, v))
}

function computeAutoWrapWidthPx(fallbackPanelWidthPx) {
  // 经验值：节点宽度取面板宽度的 ~55%，避免一行太长/太短。
  const w = Math.floor(Number(fallbackPanelWidthPx) || 0)
  const base = w > 0 ? w : PANEL_WIDTH
  return Math.max(180, Math.min(560, Math.floor(base * 0.55)))
}

function computeMarkmapMaxWidthPx(containerWidthPx) {
  if (!_settings.wrapText) return 0
  const manual = clampWrapWidth(_settings.wrapWidth)
  if (manual > 0) return manual
  return computeAutoWrapWidthPx(containerWidthPx)
}

function hasUsefulStructure(md) {
  const s = String(md || '')
  // 有二级标题或列表，基本就能撑起脑图层次。
  if (/^#{2,6}\s+\S/m.test(s)) return true
  if (/^\s*(?:[-*+]|\d+\.)\s+\S/m.test(s)) return true
  return false
}

async function ensureMarkmapLoaded(ctx) {
  // 注意：markmap 可能已被加载（例如插件热重载/二次激活），但我们自己的 _transformer 可能还是 null。
  // 所以这里不能“看到 window.markmap 就直接 return”，必须确保 Transformer 与 CSS 都准备好。
  if (window.markmap && window.markmap.Markmap && window.markmap.Transformer) {
    const mm = window.markmap

    if (!_markmapCssInjected) {
      _markmapCssInjected = true
      try {
        const st = getDoc().createElement('style')
        st.setAttribute(`data-${PLUGIN_ID}-markmap-css`, '1')
        st.textContent = String(mm.globalCSS || '')
        getDoc().head.appendChild(st)
      } catch {}
    }
    ensureWrapCssInjected()

    if (!_transformer) {
      try { _transformer = new mm.Transformer() } catch {}
    }
    if (!_transformer) throw new Error('Markmap Transformer 初始化失败')
    return mm
  }
  if (_markmapLoading) return _markmapLoading

  const loadScript = (url, tag) =>
    new Promise((resolve, reject) => {
      try {
        const existed = getDoc().querySelector(`script[data-${PLUGIN_ID}-${tag}="1"]`)
        if (existed) { resolve(true); return }
        const s = getDoc().createElement('script')
        s.src = url
        s.async = true
        s.defer = true
        s.setAttribute(`data-${PLUGIN_ID}-${tag}`, '1')
        s.onload = () => resolve(true)
        s.onerror = () => reject(new Error(`加载 ${tag} 失败`))
        getDoc().head.appendChild(s)
      } catch (e) {
        reject(e)
      }
    })

  _markmapLoading = (async () => {
    const d3Url = ctx.getAssetUrl && ctx.getAssetUrl('assets/d3.min.js')
    const viewUrl = ctx.getAssetUrl && ctx.getAssetUrl('assets/markmap-view.min.js')
    const libUrl = ctx.getAssetUrl && ctx.getAssetUrl('assets/markmap-lib.min.js')
    if (!d3Url || !viewUrl || !libUrl) throw new Error('Markmap 资源 URL 不可用')

    // 顺序不能乱：d3 -> markmap-view -> markmap-lib（lib 会把 Transformer 挂到 window.markmap）
    await loadScript(d3Url, 'd3')
    await loadScript(viewUrl, 'markmap-view')
    await loadScript(libUrl, 'markmap-lib')

    const mm = window.markmap
    if (!mm || !mm.Markmap || !mm.Transformer) throw new Error('Markmap 全局对象不可用')

    // 只注入一次全局 CSS
    if (!_markmapCssInjected) {
      _markmapCssInjected = true
      try {
        const st = getDoc().createElement('style')
        st.setAttribute(`data-${PLUGIN_ID}-markmap-css`, '1')
        st.textContent = String(mm.globalCSS || '')
        getDoc().head.appendChild(st)
      } catch {}
    }
    ensureWrapCssInjected()

    if (!_transformer) {
      try { _transformer = new mm.Transformer() } catch {}
    }
    if (!_transformer) throw new Error('Markmap Transformer 初始化失败')

    return mm
  })()
    .finally(() => {
      // 保持失败可重试
      _markmapLoading = null
    })

  return _markmapLoading
}

function setStatus(textZh, textEn) {
  if (!_statusEl) return
  _statusEl.textContent = mmText(textZh, textEn)
}

function pruneTreeByDepth(root, maxDepth) {
  const md = clampInt(maxDepth, 1, 20, DEFAULT_SETTINGS.maxDepth)
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object') return
    if (depth >= md) {
      node.children = []
      return
    }
    const kids = Array.isArray(node.children) ? node.children : []
    for (let i = 0; i < kids.length; i++) walk(kids[i], depth + 1)
  }
  walk(root, 0)
  return root
}

function mmNormText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

function parseDataLines(attr) {
  // markmap-lib 的 sourceLines 插件：data-lines="start,end"（0-based，end 为下一行）。
  const raw = String(attr || '').trim()
  if (!raw) return null
  const parts = raw.split(',').map((x) => Number(String(x).trim()))
  const a = parts[0]
  if (!Number.isFinite(a)) return null
  const start0 = Math.max(0, Math.floor(a))
  return { startLine1: start0 + 1 }
}

function findDataLinesFromEvent(ev) {
  try {
    const path = (ev && typeof ev.composedPath === 'function') ? ev.composedPath() : null
    if (Array.isArray(path)) {
      for (let i = 0; i < path.length; i++) {
        const n = path[i]
        if (n && n.getAttribute) {
          const v = n.getAttribute('data-lines')
          if (v) return { el: n, attr: v }
        }
        if (n && n.tagName === 'foreignObject' && n.querySelector) {
          const hit = n.querySelector('[data-lines]')
          if (hit && hit.getAttribute) {
            const v = hit.getAttribute('data-lines')
            if (v) return { el: hit, attr: v }
          }
        }
      }
    }
  } catch {}

  // 兜底：从 event.target 往上爬
  try {
    let n = ev && ev.target
    while (n) {
      if (n.getAttribute) {
        const v = n.getAttribute('data-lines')
        if (v) return { el: n, attr: v }
      }
      if (n.tagName === 'foreignObject' && n.querySelector) {
        const hit = n.querySelector('[data-lines]')
        if (hit && hit.getAttribute) {
          const v = hit.getAttribute('data-lines')
          if (v) return { el: hit, attr: v }
        }
      }
      n = n.parentNode
    }
  } catch {}
  return null
}

function gotoEditorLine(line1) {
  const doc = getDoc()
  const ta = doc.getElementById('editor')
  if (!ta) return false

  const text = String(ta.value || '')
  const len = text.length >>> 0
  const ln = Math.max(1, Math.floor(Number(line1) || 1))

  let caret = 0
  if (ln > 1) {
    let idx = 0
    let cur = 1
    while (cur < ln && idx < len) {
      const nl = text.indexOf('\n', idx)
      if (nl < 0) { idx = len; break }
      idx = nl + 1
      cur++
    }
    caret = idx
  }

  caret = Math.max(0, Math.min(caret, len))
  try {
    ta.selectionStart = caret
    ta.selectionEnd = caret
  } catch {}
  try { ta.focus() } catch {}

  try {
    if (len > 0 && ta.scrollHeight > ta.clientHeight + 4) {
      const linesBefore = text.slice(0, caret).split('\n').length
      const totalLines = text.split('\n').length
      const lineRatio = (linesBefore - 1) / Math.max(1, totalLines - 1)
      const targetY = lineRatio * ta.scrollHeight
      ta.scrollTop = Math.max(0, targetY - ta.clientHeight * 0.3)
    }
  } catch {}
  return true
}

function tryScrollReadable(label) {
  const needle = mmNormText(label)
  if (!needle) return false

  // 阅读模式：.preview-body（context.getPreviewElement）
  let root = null
  try {
    root = _ctx && _ctx.getPreviewElement ? _ctx.getPreviewElement() : null
  } catch {}

  // 所见模式：WYSIWYG 根节点
  if (!root) {
    try { root = getDoc().getElementById('md-wysiwyg-root') } catch {}
  }

  // 兜底：预览容器
  if (!root) {
    try { root = getDoc().getElementById('preview') } catch {}
  }
  if (!root || !root.querySelectorAll) return false

  const matchFirst = (sel) => {
    const list = root.querySelectorAll(sel)
    for (let i = 0; i < list.length; i++) {
      const el = list[i]
      const txt = mmNormText(el && el.textContent)
      if (txt === needle) return el
    }
    return null
  }

  const hit =
    matchFirst('h1,h2,h3,h4,h5,h6') ||
    matchFirst('li') ||
    matchFirst('p')

  if (!hit) return false
  try { hit.scrollIntoView({ behavior: 'smooth', block: 'start' }) } catch {}
  return true
}

function bindMarkmapJump(ctx, svgEl) {
  if (!svgEl) return
  try {
    if (svgEl.getAttribute && svgEl.getAttribute(`data-${PLUGIN_ID}-jump`) === '1') return
    svgEl.setAttribute(`data-${PLUGIN_ID}-jump`, '1')
  } catch {}

  let downX = 0
  let downY = 0
  let hasDown = false

  svgEl.addEventListener('pointerdown', (ev) => {
    try {
      hasDown = true
      downX = Number(ev.clientX) || 0
      downY = Number(ev.clientY) || 0
    } catch {}
  }, { passive: true })

  svgEl.addEventListener('click', (ev) => {
    try {
      // 拖拽平移时别乱跳
      if (hasDown) {
        const dx = (Number(ev.clientX) || 0) - downX
        const dy = (Number(ev.clientY) || 0) - downY
        if (dx * dx + dy * dy > 36) return
      }

      const hit = findDataLinesFromEvent(ev)
      if (!hit) return
      const info = parseDataLines(hit.attr)
      if (!info) return

      const label = mmNormText((hit.el && hit.el.textContent) || '')
      // 先滚动可见视图（阅读/所见），然后再定位源码（永远不改内容）。
      try { tryScrollReadable(label) } catch {}
      // AI 提纲的行号来自“AI 输出”，不可能精确映射回原文；别瞎跳。
      if (!_lastRenderUsedAi) {
        try { gotoEditorLine(info.startLine1) } catch {}
      }
    } catch (e) {
      console.error('[doc-mindmap] jump error:', e)
      safeNotice(ctx, '跳转失败', 'Jump failed', 'err', 2000)
    }
  })
}

function buildMarkmapSource(ctx) {
  const md0 = ctx.getSourceText ? ctx.getSourceText() : (ctx.getEditorValue ? ctx.getEditorValue() : '')
  const docHash = hashText(md0)
  // 文档变了就别继续挂着“AI 模式”装死：提纲已过期。
  if (_aiMode && _aiOutlineDocHash && _aiOutlineDocHash !== docHash) {
    _aiMode = false
    syncAiButtons()
  }
  const canUseAi = _aiMode && _aiOutlineMd && _aiOutlineDocHash && _aiOutlineDocHash === docHash
  const md = canUseAi ? _aiOutlineMd : md0
  const aiHash = canUseAi ? hashText(_aiOutlineMd) : ''
  const wrapKey = (_settings.wrapText ? '1' : '0') + '|' + String(clampWrapWidth(_settings.wrapWidth))
  const hash = hashText(docHash + '|' + (canUseAi ? 'ai' : 'doc') + '|' + aiHash + '|' + String(_settings.maxDepth || '') + '|' + wrapKey)
  return { md, hash, docHash, usedAi: canUseAi }
}

function syncAiButtons() {
  try {
    if (_aiOriginBtnEl) _aiOriginBtnEl.style.display = _aiMode ? '' : 'none'
  } catch {}
  try {
    if (_aiBtnEl) _aiBtnEl.disabled = !!_aiBusy
  } catch {}
  try {
    if (_aiBtnEl) _aiBtnEl.textContent = _aiBusy ? mmText('AI生成中...', 'AI...') : mmText('AI提纲', 'AI Outline')
  } catch {}
}

function setAiMode(ctx, on) {
  _aiMode = !!on
  syncAiButtons()
  // 只影响渲染，不改文档内容；切换模式直接强刷一次。
  try { renderMindmap(ctx, { force: true }) } catch {}
}

function normalizeAiOutlineMd(raw, title) {
  let t = String(raw || '').trim()
  if (!t) return ''

  // 优先取 ```markdown ... ``` 里的内容，避免模型夹带解释。
  try {
    const m = t.match(/```(?:markdown|md)?\s*([\s\S]*?)\s*```/i)
    if (m && m[1]) t = String(m[1]).trim()
  } catch {}

  // 再做一次兜底剥离开头/结尾的 fence。
  try { t = t.replace(/^```[a-zA-Z0-9_-]*\s*/i, '').trim() } catch {}
  try { t = t.replace(/```\s*$/i, '').trim() } catch {}

  // 没有根节点就补一个（markmap 需要层次结构）
  const hasHeading = /^#\s+\S/m.test(t)
  const hasList = /^\s*(?:[-*+]|\d+\.)\s+\S/m.test(t)
  if (!hasHeading) {
    const root = String(title || '').trim() || mmText('未命名文档', 'Untitled')
    t = `# ${root}\n\n` + t
  }
  if (!hasList && !/^#{2,6}\s+\S/m.test(t)) {
    // 仍然没有二级标题/列表：把它变成最简单的列表，别让脑图只剩一根棍子。
    const one = t.replace(/\s+/g, ' ').trim().slice(0, 200)
    t = `# ${String(title || '').trim() || mmText('未命名文档', 'Untitled')}\n\n- ${one || mmText('（AI 输出为空）', '(empty)')}`
  }
  return t.trim()
}

async function onAiOutlineClicked(ctx) {
  if (_aiBusy) return
  try {
    const md0 = ctx.getSourceText ? ctx.getSourceText() : (ctx.getEditorValue ? ctx.getEditorValue() : '')
    const docHash = hashText(md0)
    const docTrim = String(md0 || '').trim()
    if (!docTrim) {
      safeNotice(ctx, '文档内容为空', 'Document is empty', 'err', 2200)
      return
    }

    // 有缓存且当前没开 AI 模式：直接切过去，别重复花钱。
    if (!_aiMode && _aiOutlineDocHash === docHash && _aiOutlineMd) {
      setAiMode(ctx, true)
      return
    }

    const ai = ctx.getPluginAPI && ctx.getPluginAPI('ai-assistant')
    if (!ai || typeof ai.callAI !== 'function') {
      safeNotice(ctx, '未找到 AI 助手插件（ai-assistant），无法生成提纲', 'AI assistant (ai-assistant) not found', 'err', 2600)
      return
    }
    if (typeof ai.isConfigured === 'function') {
      const ok = await ai.isConfigured()
      if (!ok) {
        safeNotice(ctx, '请先在 AI 助手里配置 Key 或切换免费模式', 'Please configure AI Assistant first', 'err', 2600)
        return
      }
    }

    _aiBusy = true
    syncAiButtons()
    setStatus('AI 生成提纲中...', 'Generating outline...')

    // 不搞玄学：只截断到一个合理范围，避免把整个超长文档全塞给模型。
    let maxChars = 48000
    try {
      const cfg = (typeof ai.getConfig === 'function') ? await ai.getConfig() : null
      const v = cfg && cfg.limits && cfg.limits.maxCtxChars
      const n = clampInt(v, 2000, 256000, 48000)
      maxChars = Math.min(80000, n)
    } catch {}

    const sliced = docTrim.length > maxChars ? docTrim.slice(docTrim.length - maxChars) : docTrim
    const title = getRootLabel(ctx, md0)

    const system =
      '你是资深技术写作者。你只输出 Markdown，不要解释，不要加代码块，不要加多余前后缀。'
    const prompt = [
      '把下面这段 Markdown 整理成「脑图提纲」：',
      '',
      '硬性要求：',
      `- 第一行用 "# ${title}" 作为根标题（必须有）`,
      '- 用标题(##/###/####)和/或列表(-)表达层级，最多 4 层',
      '- 每行尽量短，避免超过 30 个汉字；长句拆成多个要点',
      '- 保留原文关键信息，不要编造不存在的内容',
      '',
      '文档内容：',
      '',
      sliced
    ].join('\n')

    const raw = await ai.callAI(prompt, { system })
    const out = normalizeAiOutlineMd(raw, title)
    if (!out) throw new Error('AI 输出为空')

    _aiOutlineDocHash = docHash
    _aiOutlineMd = out
    _aiMode = true
    setStatus('AI 提纲已生成', 'AI outline ready')
    syncAiButtons()
    renderMindmap(ctx, { force: true })
  } catch (e) {
    console.error('[doc-mindmap] AI outline error:', e)
    safeNotice(ctx, 'AI 生成提纲失败', 'AI outline failed', 'err', 2600)
    setStatus('AI 生成失败', 'AI failed')
  } finally {
    _aiBusy = false
    syncAiButtons()
  }
}

async function renderMindmap(ctx, { force }) {
  try {
    if (!_panelVisible) return
    ensurePanelMounted(ctx)
    if (!_graphWrap) return

    const { md, hash, usedAi } = buildMarkmapSource(ctx)
    if (!force && hash === _lastHash) return
    _lastHash = hash
    _lastMd = md
    _lastRenderUsedAi = !!usedAi

    setStatus(usedAi ? '渲染中（AI）...' : '渲染中...', usedAi ? 'Rendering (AI)...' : 'Rendering...')
    const mm = await ensureMarkmapLoaded(ctx)

    if (!_transformer) {
      // 理论上 ensureMarkmapLoaded 会初始化，但这里再兜底一次，避免被状态机坑死。
      try { _transformer = new mm.Transformer() } catch {}
    }
    if (!_transformer) throw new Error('Markmap Transformer 未初始化')
    const result = _transformer.transform(md)
    const root = pruneTreeByDepth(result.root, _settings.maxDepth)
    const opts = mm.deriveOptions((result.frontmatter && result.frontmatter.markmap) || {})
    // 主题：markmap 没有“内置暗色主题”，但它会继承页面字体颜色；这里让线条对比更稳一点。
    opts.color = opts.color || mm.defaultOptions.color
    // 长文本换行：maxWidth + CSS（只对本插件的 SVG 生效）
    try {
      const panelW = (() => {
        try {
          const r = _panelRoot && _panelRoot.getBoundingClientRect ? _panelRoot.getBoundingClientRect() : null
          const w = r && r.width ? Number(r.width) : 0
          return w > 0 ? w : Number(_settings.panelWidth) || PANEL_WIDTH
        } catch {
          return Number(_settings.panelWidth) || PANEL_WIDTH
        }
      })()
      const maxWidth = computeMarkmapMaxWidthPx(panelW)
      if (maxWidth > 0) opts.maxWidth = maxWidth
    } catch {}

    // 初始化 / 更新面板 SVG：直接占满面板，不要搞滚动条/缩放容器那套垃圾。
    if (_panelSvg && !_panelSvg.isConnected) {
      _panelSvg = null
      try { if (_mmPanel && typeof _mmPanel.destroy === 'function') _mmPanel.destroy() } catch {}
      _mmPanel = null
    }
    if (!_panelSvg) {
      _graphWrap.innerHTML = ''
      const svg = getDoc().createElementNS('http://www.w3.org/2000/svg', 'svg')
      try { svg.classList.add('markmap') } catch {}
      try {
        if (_settings.wrapText) svg.classList.add(`${PLUGIN_ID}-wrap`)
        else svg.classList.remove(`${PLUGIN_ID}-wrap`)
      } catch {}
      svg.style.width = '100%'
      svg.style.height = '100%'
      svg.style.display = 'block'
      svg.setAttribute('role', 'img')
      _graphWrap.appendChild(svg)
      _panelSvg = svg
    } else {
      try {
        if (_settings.wrapText) _panelSvg.classList.add(`${PLUGIN_ID}-wrap`)
        else _panelSvg.classList.remove(`${PLUGIN_ID}-wrap`)
      } catch {}
    }
    if (!_mmPanel) {
      _mmPanel = mm.Markmap.create(_panelSvg, opts)
      bindMarkmapJump(ctx, _panelSvg)
    } else {
      try { _mmPanel.setOptions(opts) } catch {}
    }

    await _mmPanel.setData(root)
    await _mmPanel.fit()
    _lastSvg = _panelSvg.outerHTML
    if (!usedAi && !hasUsefulStructure(md)) {
      setStatus('完成（提示：可点“AI提纲”生成结构）', 'Done (Tip: AI Outline can generate structure)')
    } else {
      setStatus(usedAi ? '完成（AI）' : '完成', usedAi ? 'Done (AI)' : 'Done')
    }
  } catch (e) {
    console.error('[doc-mindmap] render error:', e)
    if (_graphWrap) {
      const msg = String(e && e.message ? e.message : e)
      const esc = (s) =>
        String(s || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
      _graphWrap.innerHTML =
        `<div style="color:#b00020;border:1px solid rgba(176,0,32,0.35);padding:8px;border-radius:8px;white-space:pre-wrap;">` +
        `${mmText('渲染失败：', 'Render failed: ')}${esc(msg)}` +
        `</div>`
    }
    setStatus('失败', 'Failed')
  }
}

async function renderMindmapFullscreen(ctx, { force }) {
  try {
    if (!_fsVisible) return
    ensureFullscreenMounted(ctx)
    if (!_fsSvg) return

    const { md, hash, usedAi } = buildMarkmapSource(ctx)
    if (!force && hash === _lastHash) return
    _lastHash = hash
    _lastMd = md
    _lastRenderUsedAi = !!usedAi

    const mm = await ensureMarkmapLoaded(ctx)
    if (!_transformer) {
      try { _transformer = new mm.Transformer() } catch {}
    }
    if (!_transformer) throw new Error('Markmap Transformer 未初始化')
    const result = _transformer.transform(md)
    const root = pruneTreeByDepth(result.root, _settings.maxDepth)
    const opts = mm.deriveOptions((result.frontmatter && result.frontmatter.markmap) || {})
    opts.color = opts.color || mm.defaultOptions.color
    try {
      const w = (() => {
        try {
          const r = _fsRoot && _fsRoot.getBoundingClientRect ? _fsRoot.getBoundingClientRect() : null
          const ww = r && r.width ? Number(r.width) : 0
          return ww > 0 ? ww : Number(window.innerWidth) || 1200
        } catch {
          return Number(window.innerWidth) || 1200
        }
      })()
      const maxWidth = computeMarkmapMaxWidthPx(w)
      if (maxWidth > 0) opts.maxWidth = maxWidth
    } catch {}

    if (!_mmFs) {
      _mmFs = mm.Markmap.create(_fsSvg, opts)
      bindMarkmapJump(ctx, _fsSvg)
    } else {
      try { _mmFs.setOptions(opts) } catch {}
    }
    try {
      if (_settings.wrapText) _fsSvg.classList.add(`${PLUGIN_ID}-wrap`)
      else _fsSvg.classList.remove(`${PLUGIN_ID}-wrap`)
    } catch {}
    await _mmFs.setData(root)
    await _mmFs.fit()
    _lastSvg = _fsSvg.outerHTML
  } catch (e) {
    console.error('[doc-mindmap] fullscreen render error:', e)
    if (_fsRoot) {
      const msg = String(e && e.message ? e.message : e)
      const esc = (s) =>
        String(s || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
      try {
        const box = _fsRoot.querySelector(`.${PLUGIN_ID}-fs-box`)
        if (box) {
          box.innerHTML =
            `<div style="color:#b00020;border:1px solid rgba(176,0,32,0.35);padding:10px;border-radius:10px;white-space:pre-wrap;margin:12px;">` +
            `${mmText('渲染失败：', 'Render failed: ')}${esc(msg)}` +
            `</div>`
        }
      } catch {}
    }
  }
}

function svgToBytes(svgText) {
  const enc = new TextEncoder()
  return enc.encode(String(svgText || ''))
}

function getSvgSize(svgEl) {
  let w = 1200
  let h = 800
  try {
    const vb = svgEl.viewBox && svgEl.viewBox.baseVal
    if (vb && vb.width > 0 && vb.height > 0) {
      w = Math.ceil(vb.width)
      h = Math.ceil(vb.height)
    } else {
      const r = svgEl.getBoundingClientRect()
      if (r && r.width > 1 && r.height > 1) {
        w = Math.ceil(r.width)
        h = Math.ceil(r.height)
      }
    }
  } catch {}
  w = Math.max(200, Math.min(8000, w))
  h = Math.max(200, Math.min(8000, h))
  return { w, h }
}

function getMarkmapGlobalCss() {
  try {
    const mm = window.markmap
    const css = mm && mm.globalCSS
    return String(css || '')
  } catch {}
  return ''
}

function getDocMindmapExtraCssForExport() {
  // 和 ensureWrapCssInjected() 保持一致：导出 SVG/PNG 也要能换行。
  return `
    svg.${PLUGIN_ID}-wrap foreignObject,
    svg.${PLUGIN_ID}-wrap foreignObject * { overflow: visible; }

    svg.${PLUGIN_ID}-wrap foreignObject > div {
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
  `.trim()
}

function buildSvgForExport(svgEl, bgColor, width, height) {
  // 导出必须自包含：把 markmap.globalCSS 塞进 <style>，否则离开宿主就样式全丢。
  const clone = svgEl.cloneNode(true)
  try { clone.classList && clone.classList.add('markmap') } catch {}

  try {
    clone.setAttribute('width', String(width))
    clone.setAttribute('height', String(height))
  } catch {}

  const ns = 'http://www.w3.org/2000/svg'
  let styleEl = null
  const css = [getMarkmapGlobalCss(), getDocMindmapExtraCssForExport()].filter(Boolean).join('\n\n')
  if (css) {
    try {
      styleEl = getDoc().createElementNS(ns, 'style')
      styleEl.textContent = css
      const first = clone.firstChild
      if (first) clone.insertBefore(styleEl, first)
      else clone.appendChild(styleEl)
    } catch {}
  }

  if (bgColor) {
    try {
      const rect = getDoc().createElementNS(ns, 'rect')
      rect.setAttribute('x', '0')
      rect.setAttribute('y', '0')
      rect.setAttribute('width', '100%')
      rect.setAttribute('height', '100%')
      rect.setAttribute('fill', bgColor)
      // 放在最底层：在 style 后面、在图形前面。
      const anchor = styleEl ? styleEl.nextSibling : clone.firstChild
      if (anchor) clone.insertBefore(rect, anchor)
      else clone.appendChild(rect)
    } catch {}
  }

  return new XMLSerializer().serializeToString(clone)
}

async function exportSvg(ctx) {
  try {
    // 确保 markmap 已加载（用于拿到 globalCSS，导出才不会丢样式）
    try { await ensureMarkmapLoaded(ctx) } catch {}

    let svgEl = getCurrentSvgElement()
    if (!svgEl) {
      // 用户可能直接点了菜单导出：那就先把面板拉起来渲染一次。
      try { setPanelVisible(ctx, true) } catch {}
      try { await renderMindmap(ctx, { force: true }) } catch {}
      svgEl = getCurrentSvgElement()
    }
    if (!svgEl) {
      safeNotice(ctx, '当前没有可导出的图', 'Nothing to export', 'err', 2200)
      return
    }

    const { w, h } = getSvgSize(svgEl)
    const svgText = buildSvgForExport(svgEl, null, w, h)
    const bytes = svgToBytes(svgText)
    const savedPath = await ctx.saveFileWithDialog({
      filters: [{ name: 'SVG', extensions: ['svg'] }],
      defaultName: `${getRootLabel(ctx, ctx.getEditorValue && ctx.getEditorValue()) || 'mindmap'}.svg`,
      data: bytes,
    })
    if (savedPath) safeNotice(ctx, '已导出 SVG', 'SVG exported', 'ok', 1800)
  } catch (e) {
    console.error('[doc-mindmap] exportSvg error:', e)
    safeNotice(ctx, '导出失败', 'Export failed', 'err', 2400)
  }
}

function resolvePngBackground() {
  if (_settings.pngBackground === 'transparent') return null
  if (_settings.pngBackground === 'auto') {
    return isDarkMode() ? '#111111' : '#ffffff'
  }
  const s = String(_settings.pngBackground || '').trim()
  if (!s) return null
  return s
}

function buildSvgForRaster(svgEl, bgColor, width, height) {
  return buildSvgForExport(svgEl, bgColor, width, height)
}

async function exportPng(ctx) {
  try {
    // 确保 markmap 已加载（用于拿到 globalCSS，导出才不会丢样式）
    try { await ensureMarkmapLoaded(ctx) } catch {}

    let svgEl = getCurrentSvgElement()
    if (!svgEl) {
      try { setPanelVisible(ctx, true) } catch {}
      try { await renderMindmap(ctx, { force: true }) } catch {}
      svgEl = getCurrentSvgElement()
    }
    if (!svgEl) {
      safeNotice(ctx, '当前没有可导出的图', 'Nothing to export', 'err', 2200)
      return
    }

    const scale = clampInt(_settings.pngScale, 1, 6, DEFAULT_SETTINGS.pngScale)
    const { w, h } = getSvgSize(svgEl)

    const bg = resolvePngBackground()
    const svgText = buildSvgForRaster(svgEl, bg, w, h)
    const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)

    const img = new Image()
    img.decoding = 'async'
    const loadOk = await new Promise((resolve) => {
      img.onload = () => resolve(true)
      img.onerror = () => resolve(false)
      img.src = url
    })
    URL.revokeObjectURL(url)
    if (!loadOk) throw new Error('SVG 转 PNG 失败（图片加载失败）')

    const canvas = getDoc().createElement('canvas')
    canvas.width = Math.floor(w * scale)
    canvas.height = Math.floor(h * scale)
    const g = canvas.getContext('2d')
    if (!g) throw new Error('Canvas 不可用')
    g.setTransform(scale, 0, 0, scale, 0, 0)
    if (bg) {
      g.fillStyle = bg
      g.fillRect(0, 0, w, h)
    }
    g.drawImage(img, 0, 0)

    const pngBlob = await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/png')
    })
    if (!pngBlob) throw new Error('Canvas 导出失败')
    const buf = await pngBlob.arrayBuffer()
    const bytes = new Uint8Array(buf)

    const savedPath = await ctx.saveFileWithDialog({
      filters: [{ name: 'PNG', extensions: ['png'] }],
      defaultName: `${getRootLabel(ctx, ctx.getEditorValue && ctx.getEditorValue()) || 'mindmap'}.png`,
      data: bytes,
    })
    if (savedPath) safeNotice(ctx, '已导出 PNG', 'PNG exported', 'ok', 1800)
  } catch (e) {
    console.error('[doc-mindmap] exportPng error:', e)
    safeNotice(ctx, '导出失败', 'Export failed', 'err', 2400)
  }
}

export async function activate(context) {
  _ctx = context
  await loadSettings(context)

  // 右侧停靠位：只负责让宿主“挤出空间”，具体 UI 由插件自己挂在容器里（参考 backlinks）。
  try {
    if (context.layout && typeof context.layout.registerPanel === 'function') {
      _dockHandle = context.layout.registerPanel(PLUGIN_ID, {
        side: 'right',
        size: clampInt(_settings.panelWidth, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH, PANEL_WIDTH),
        visible: false,
      })
    }
  } catch {}

  bindThemeListener(context)
  ensurePanelMounted(context)
  setPanelVisible(context, false)

  // 右键菜单：必须覆盖 源码/阅读/所见 三种模式。
  // label 固定为「文档脑图」，满足你要求的文案。
  try {
    if (_disposeCtxMenu) { try { _disposeCtxMenu() } catch {} ; _disposeCtxMenu = null }
    _disposeCtxMenu = context.addContextMenuItem({
      label: '文档脑图',
      icon: '🧠',
      condition: (ctx2) => ctx2 && (ctx2.mode === 'edit' || ctx2.mode === 'preview' || ctx2.mode === 'wysiwyg'),
      onClick: async () => {
        // 不做二级入口：右键菜单点击即打开面板
        setPanelVisible(context, true)
      },
    })
  } catch (e) {
    console.error('[doc-mindmap] addContextMenuItem failed:', e)
  }

  // 入口：菜单项（一个入口够了，别搞花里胡哨的按钮地狱）
  context.addMenuItem({
    label: mmText('文档脑图', 'Doc Mindmap'),
    title: mmText('将当前文档渲染为 Markmap 风格脑图', 'Render current document as a Markmap mindmap'),
    children: [
      {
        label: mmText('打开/关闭面板', 'Toggle Panel'),
        onClick: async () => {
          setPanelVisible(context, !_panelVisible)
        },
      },
      {
        label: mmText('全屏放大查看', 'Fullscreen'),
        onClick: async () => {
          // 全屏查看不要求面板必须打开，但通常用户会从面板触发。
          setFullscreenVisible(context, true)
        },
      },
      {
        label: mmText('刷新', 'Refresh'),
        onClick: async () => renderMindmap(context, { force: true }),
      },
      { type: 'divider' },
      {
        label: mmText('导出 SVG', 'Export SVG'),
        onClick: async () => exportSvg(context),
      },
      {
        label: mmText('导出 PNG', 'Export PNG'),
        onClick: async () => exportPng(context),
      },
    ],
  })

  safeNotice(context, '文档脑图插件已启用', 'Doc Mindmap enabled', 'ok', 1600)
}

export function deactivate() {
  stopTimer()
  try {
    if (_disposeCtxMenu) _disposeCtxMenu()
  } catch {}
  _disposeCtxMenu = null
  try {
    if (_dockHandle) _dockHandle.dispose()
  } catch {}
  _dockHandle = null
  _panelVisible = false
  try {
    if (_onThemeChanged) window.removeEventListener('flymd:theme:changed', _onThemeChanged)
  } catch {}
  _onThemeChanged = null
  try {
    if (_panelRoot && _panelRoot.parentNode) _panelRoot.parentNode.removeChild(_panelRoot)
  } catch {}
  _panelRoot = null
  _toolbarEl = null
  _optsEl = null
  _graphWrap = null
  _resizerEl = null
  _statusEl = null
  _aiBtnEl = null
  _aiOriginBtnEl = null
  _aiMode = false
  _aiBusy = false
  _aiOutlineMd = ''
  _aiOutlineDocHash = ''
  _lastRenderUsedAi = false
  try {
    if (_fsRoot && _fsRoot.parentNode) _fsRoot.parentNode.removeChild(_fsRoot)
  } catch {}
  _fsRoot = null
  _fsSvg = null
  try { if (_mmFs && typeof _mmFs.destroy === 'function') _mmFs.destroy() } catch {}
  _mmFs = null
  _fsVisible = false
  try { getDoc().body.style.overflow = _prevBodyOverflow } catch {}
  _prevBodyOverflow = ''
  try { if (_mmPanel && typeof _mmPanel.destroy === 'function') _mmPanel.destroy() } catch {}
  _mmPanel = null
  _panelSvg = null
  _transformer = null
  _ctx = null
}
