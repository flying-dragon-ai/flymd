// 协同编辑插件（开源服务器版）
// 说明：
// - 功能与本地闭源协同插件保持一致：整篇同步 + 行/段落级锁 + 协同状态面板
// - 唯一差异：不内置服务器地址，由用户在连接时填写 serverUrl

const CFG_KEY = 'local-collab-os.config'

// 官方协同服务器预设
const OFFICIAL_SERVER_URL = 'wss://t.hast.one/server/ws'
const OFFICIAL_ROOM_CODE = 'flymd'
const OFFICIAL_PASSWORD = '(l^2Bm:8@0'

const DEFAULT_CFG = {
  serverUrl: '',
  roomCode: '',
  password: '',
  displayName: '',
  syncIntervalMs: 1000,
  boundDocId: '',
  boundDocTitle: '',
  serverMode: 'custom',
  customServerUrl: '',
  customRoomCode: '',
  customPassword: ''
}

let __COLLAB_CTX__ = null
let __COLLAB_WS__ = null
let __COLLAB_TIMER__ = null
let __COLLAB_LAST__ = ''
let __COLLAB_APPLYING_REMOTE__ = false
let __COLLAB_STATUS_ID__ = null
let __COLLAB_BOUND_DOC_ID__ = ''
let __COLLAB_BOUND_DOC_TITLE__ = ''
let __COLLAB_DOC_ACTIVE__ = false
let __COLLAB_CFG__ = null
let __COLLAB_PANEL_EL__ = null
let __COLLAB_PANEL_VISIBLE__ = false
let __COLLAB_LOCKS__ = Object.create(null)
let __COLLAB_MY_LOCKS__ = new Set()
let __COLLAB_CURRENT_BLOCK_ID__ = ''
let __COLLAB_MY_NAME__ = ''
let __COLLAB_MY_COLOR__ = ''
let __COLLAB_LOCK_PANEL_EL__ = null
let __COLLAB_PEERS__ = []
let __COLLAB_LOCK_IDLE_TIMER__ = null
const LOCK_IDLE_TIMEOUT_MS = 2000
const REMOTE_APPLY_QUIET_MS = 800
let __COLLAB_LAST_TYPED_AT__ = 0
let __COLLAB_EDITOR_PREV_CARET_COLOR__ = ''
let __COLLAB_LOCAL_CARET_EL__ = null
let __COLLAB_LOCAL_CARET_CHAR_WIDTH__ = 0
let __COLLAB_LOCAL_CARET_LINE_HEIGHT__ = 0
let __COLLAB_OFFICIAL_PROBE_WS__ = null
let __COLLAB_OFFICIAL_PROBE_TIMER__ = null

function getEditorElement() {
  try {
    return document.getElementById('editor')
  } catch {
    return null
  }
}

function applyEditorCaretColor(enabled) {
  const el = getEditorElement()
  if (!el) return
  if (enabled) {
    try {
      if (!__COLLAB_EDITOR_PREV_CARET_COLOR__) {
        __COLLAB_EDITOR_PREV_CARET_COLOR__ = el.style.caretColor || ''
      }
    } catch {}
    try {
      // 协同模式下隐藏原生插入符，由本插件用 JS 绘制粗色条光标
      el.style.caretColor = 'transparent'
    } catch {}
  } else {
    try {
      el.style.caretColor = __COLLAB_EDITOR_PREV_CARET_COLOR__ || ''
    } catch {}
  }
}

function updateLocalCaretVisual() {
  const editorEl = getEditorElement()
  if (!editorEl || typeof editorEl.selectionStart !== 'number') {
    hideLocalCaret()
    return
  }
  if (!isConnected() || !__COLLAB_CFG__ || !__COLLAB_DOC_ACTIVE__) {
    hideLocalCaret()
    return
  }
  try {
    const cs = window.getComputedStyle(editorEl)
    if (cs.display === 'none' || cs.visibility === 'hidden') {
      hideLocalCaret()
      return
    }
  } catch {
    // 忽略样式计算失败
  }

  ensureLocalCaretMetrics(editorEl)
  if (!__COLLAB_LOCAL_CARET_CHAR_WIDTH__ || !__COLLAB_LOCAL_CARET_LINE_HEIGHT__) {
    hideLocalCaret()
    return
  }

  let text = ''
  try {
    text = String(editorEl.value || '')
  } catch {
    hideLocalCaret()
    return
  }
  let pos = editorEl.selectionStart >>> 0
  if (pos < 0) pos = 0
  if (pos > text.length) pos = text.length

  let line = 0
  let col = 0
  for (let i = 0; i < pos; i++) {
    const ch = text.charCodeAt(i)
    if (ch === 10) {
      line++
      col = 0
    } else {
      col++
    }
  }

  let rect
  let padLeft = 0
  let padTop = 0
  try {
    rect = editorEl.getBoundingClientRect()
    const cs = window.getComputedStyle(editorEl)
    padLeft = parseFloat(cs.paddingLeft) || 0
    padTop = parseFloat(cs.paddingTop) || 0
  } catch {
    hideLocalCaret()
    return
  }

  const scrollY = window.scrollY || window.pageYOffset || 0
  const scrollX = window.scrollX || window.pageXOffset || 0
  const top =
    rect.top +
    scrollY +
    padTop +
    line * __COLLAB_LOCAL_CARET_LINE_HEIGHT__ -
    editorEl.scrollTop
  const left =
    rect.left +
    scrollX +
    padLeft +
    col * __COLLAB_LOCAL_CARET_CHAR_WIDTH__ -
    editorEl.scrollLeft

  const caretEl = ensureLocalCaretEl()
  if (!caretEl) return
  try {
    caretEl.style.height = __COLLAB_LOCAL_CARET_LINE_HEIGHT__ + 'px'
    caretEl.style.left = left + 'px'
    caretEl.style.top = top + 'px'
    caretEl.style.background = __COLLAB_MY_COLOR__ || '#ff1744'
    caretEl.style.display = 'block'
  } catch {}
}

function ensureLocalCaretEl() {
  const doc = (typeof document !== 'undefined' && document) || null
  if (!doc) return null
  if (__COLLAB_LOCAL_CARET_EL__) return __COLLAB_LOCAL_CARET_EL__
  const el = doc.createElement('div')
  el.id = 'local-collab-caret'
  el.style.position = 'absolute'
  el.style.pointerEvents = 'none'
  el.style.zIndex = '1200'
  el.style.width = '2px'
  el.style.borderRadius = '1px'
  el.style.background = __COLLAB_MY_COLOR__ || '#ff1744'
  el.style.display = 'none'
  el.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.18)'
  doc.body.appendChild(el)
  __COLLAB_LOCAL_CARET_EL__ = el
  return el
}

function hideLocalCaret() {
  const el = __COLLAB_LOCAL_CARET_EL__
  if (!el) return
  try {
    el.style.display = 'none'
  } catch {}
}

function ensureLocalCaretMetrics(editorEl) {
  if (!editorEl) return
  try {
    const cs = window.getComputedStyle(editorEl)
    if (!__COLLAB_LOCAL_CARET_CHAR_WIDTH__ || !__COLLAB_LOCAL_CARET_LINE_HEIGHT__) {
      const doc = editorEl.ownerDocument || document
      const span = doc.createElement('span')
      span.textContent = 'Ｍ'
      span.style.position = 'absolute'
      span.style.visibility = 'hidden'
      span.style.whiteSpace = 'pre'
      span.style.fontFamily = cs.fontFamily
      span.style.fontSize = cs.fontSize
      doc.body.appendChild(span)
      const rect = span.getBoundingClientRect()
      __COLLAB_LOCAL_CARET_CHAR_WIDTH__ = rect.width || 8
      const lh = parseFloat(cs.lineHeight)
      __COLLAB_LOCAL_CARET_LINE_HEIGHT__ = lh || rect.height || 18
      doc.body.removeChild(span)
    }
  } catch {}
}

function updateLocalCaretVisual() {
  const editorEl = getEditorElement()
  if (!editorEl || typeof editorEl.selectionStart !== 'number') {
    hideLocalCaret()
    return
  }
  if (!isConnected() || !__COLLAB_CFG__ || !__COLLAB_DOC_ACTIVE__) {
    hideLocalCaret()
    return
  }
  try {
    const cs = window.getComputedStyle(editorEl)
    if (cs.display === 'none' || cs.visibility === 'hidden') {
      hideLocalCaret()
      return
    }
  } catch {
    // 忽略样式计算失败
  }

  ensureLocalCaretMetrics(editorEl)
  if (!__COLLAB_LOCAL_CARET_CHAR_WIDTH__ || !__COLLAB_LOCAL_CARET_LINE_HEIGHT__) {
    hideLocalCaret()
    return
  }

  let text = ''
  try {
    text = String(editorEl.value || '')
  } catch {
    hideLocalCaret()
    return
  }
  let pos = editorEl.selectionStart >>> 0
  if (pos < 0) pos = 0
  if (pos > text.length) pos = text.length

  let line = 0
  let col = 0
  for (let i = 0; i < pos; i++) {
    const ch = text.charCodeAt(i)
    if (ch === 10) {
      line++
      col = 0
    } else {
      col++
    }
  }

  let rect
  let padLeft = 0
  let padTop = 0
  try {
    rect = editorEl.getBoundingClientRect()
    const cs = window.getComputedStyle(editorEl)
    padLeft = parseFloat(cs.paddingLeft) || 0
    padTop = parseFloat(cs.paddingTop) || 0
  } catch {
    hideLocalCaret()
    return
  }

  const scrollY = window.scrollY || window.pageYOffset || 0
  const scrollX = window.scrollX || window.pageXOffset || 0
  const top =
    rect.top +
    scrollY +
    padTop +
    line * __COLLAB_LOCAL_CARET_LINE_HEIGHT__ -
    editorEl.scrollTop
  const left =
    rect.left +
    scrollX +
    padLeft +
    col * __COLLAB_LOCAL_CARET_CHAR_WIDTH__ -
    editorEl.scrollLeft

  const caretEl = ensureLocalCaretEl()
  if (!caretEl) return
  try {
    caretEl.style.height = __COLLAB_LOCAL_CARET_LINE_HEIGHT__ + 'px'
    caretEl.style.left = left + 'px'
    caretEl.style.top = top + 'px'
    caretEl.style.background = __COLLAB_MY_COLOR__ || '#ff1744'
    caretEl.style.display = 'block'
  } catch {}
}

function colorFromName(name) {
  // 使用更高对比度的调色板，提升可见度（尤其是浅色背景下）
  const palette = ['#ff1744', '#d500f9', '#651fff', '#2962ff', '#00c853', '#ffd600', '#ff9100', '#00bfa5']
  const s = String(name || 'user')
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0
  }
  return palette[h % palette.length]
}

function getBlockInfo(content, pos) {
  const text = String(content || '')
  const len = text.length
  const p = Math.max(0, Math.min(len, pos >>> 0))
  let start = 0
  let blockIndex = 0
  const hasDouble = text.indexOf('\n\n') !== -1
  if (hasDouble) {
    for (let i = 0; i < len && i < p; i++) {
      const ch = text[i]
      const next = text[i + 1]
      if (ch === '\n' && next === '\n') {
        blockIndex++
        start = i + 2
        i++
      }
    }
  } else {
    for (let i = 0; i < len && i < p; i++) {
      const ch = text[i]
      if (ch === '\n') {
        blockIndex++
        start = i + 1
      }
    }
  }
  let end
  if (hasDouble) {
    end = text.indexOf('\n\n', start)
  } else {
    end = text.indexOf('\n', start)
  }
  if (end === -1) end = len
  const blockText = text.slice(start, end)
  const firstLine = blockText.split(/\r?\n/)[0] || ''
  const labelBase = firstLine.trim() || blockText.trim().slice(0, 30) || `第${blockIndex + 1}段`
  const id = 'b_' + String(blockIndex >>> 0)
  return { id, label: labelBase.slice(0, 32), start, end }
}

function getBlockRangeByIndex(content, blockIndex) {
  const text = String(content || '')
  const len = text.length
  if (!len) return { start: 0, end: 0 }
  const idx = blockIndex >>> 0
  const hasDouble = text.indexOf('\n\n') !== -1
  let start = 0
  let current = 0
  while (current < idx && start <= len) {
    let endInner
    if (hasDouble) {
      const i2 = text.indexOf('\n\n', start)
      endInner = i2 === -1 ? len : i2
    } else {
      const i2 = text.indexOf('\n', start)
      endInner = i2 === -1 ? len : i2
    }
    start = endInner >= len ? len : endInner + (hasDouble ? 2 : 1)
    current++
  }
  if (start > len) return { start: len, end: len }
  let end
  if (hasDouble) {
    const idx2 = text.indexOf('\n\n', start)
    end = idx2 === -1 ? len : idx2
  } else {
    const idx2 = text.indexOf('\n', start)
    end = idx2 === -1 ? len : idx2
  }
  if (end < start) end = start
  return { start, end }
}

function ensureLockPanel() {
  if (__COLLAB_LOCK_PANEL_EL__) return __COLLAB_LOCK_PANEL_EL__
  const doc = (typeof document !== 'undefined' && document) || null
  if (!doc) return null
  const el = doc.createElement('div')
  el.id = 'local-collab-lock-panel'
  el.style.position = 'fixed'
  el.style.right = '12px'
  el.style.bottom = '64px'
  el.style.zIndex = '1000'
  el.style.minWidth = '150px'
  el.style.maxWidth = '220px'
  el.style.maxHeight = '140px'
  el.style.overflow = 'hidden'
  el.style.borderRadius = '6px'
  el.style.background = 'rgba(20,20,20,0.92)'
  el.style.border = '1px solid rgba(120,120,120,0.6)'
  el.style.fontSize = '12px'
  el.style.color = '#eee'
  el.style.padding = '6px 8px 4px 8px'
  el.style.boxShadow = '0 8px 24px rgba(0,0,0,0.45)'
  el.style.display = 'none'
  doc.body.appendChild(el)
  __COLLAB_LOCK_PANEL_EL__ = el
  return el
}

function renderLockPanel() {
  const panel = ensureLockPanel()
  if (!panel) return
  const byName = new Map()
  for (const id in __COLLAB_LOCKS__) {
    if (!Object.prototype.hasOwnProperty.call(__COLLAB_LOCKS__, id)) continue
    const info = __COLLAB_LOCKS__[id]
    if (!info || !info.name) continue
    const item = { id, name: info.name, color: info.color || '#999', label: info.label || '' }
    const existing = byName.get(info.name)
    if (!existing || id === __COLLAB_CURRENT_BLOCK_ID__) {
      byName.set(info.name, item)
    }
  }
  const entries = Array.from(byName.values())
  panel.style.display = 'block'
  const peerNames = Array.from(new Set(__COLLAB_PEERS__.map((n) => String(n || '').trim()).filter(Boolean)))
  const peersCount = peerNames.length || 1
  const peersTitle = peerNames.length ? peerNames.join('、') : (__COLLAB_MY_NAME__ || '')
  panel.title = peersTitle || '协同状态'

  if (!entries.length) {
    const base = '<div style="font-size:12px;opacity:0.9;white-space:nowrap;">协同状态：空闲</div>'
    const namesLine =
      peerNames.length > 0
        ? `<div style="margin-top:2px;font-size:11px;opacity:0.85;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;">在线：${peerNames.join('、')}</div>`
        : ''
    const countLine =
      `<div style="margin-top:3px;border-top:1px solid rgba(255,255,255,0.12);padding-top:2px;font-size:11px;opacity:0.8;">协同人数：${peersCount}</div>`
    panel.innerHTML = base + namesLine + countLine
    return
  }

  let html = '<div style="margin-bottom:2px;opacity:0.9;">协同状态：</div>'
  for (const it of entries) {
    const active = it.id === __COLLAB_CURRENT_BLOCK_ID__
    const dot = `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${it.color};margin-right:6px;"></span>`
    const meMark = it.name === __COLLAB_MY_NAME__ ? '（我）' : ''
    const text = `${it.name}${meMark} 正在编辑，请稍后`
    html += `<div style="display:flex;align-items:center;margin:1px 0;padding:1px 0;${active ? 'font-weight:600;' : ''}">${dot}<div style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${text}</div></div>`
  }
  html += `<div style="margin-top:3px;border-top:1px solid rgba(255,255,255,0.12);padding-top:2px;font-size:11px;opacity:0.8;">协同人数：${peersCount}</div>`
  panel.innerHTML = html
}

function clearLockPanel() {
  __COLLAB_LOCKS__ = Object.create(null)
  __COLLAB_MY_LOCKS__.clear()
  __COLLAB_CURRENT_BLOCK_ID__ = ''
  __COLLAB_PEERS__ = []
  if (__COLLAB_LOCK_IDLE_TIMER__) {
    clearTimeout(__COLLAB_LOCK_IDLE_TIMER__)
    __COLLAB_LOCK_IDLE_TIMER__ = null
  }
  const panel = __COLLAB_LOCK_PANEL_EL__
  if (panel) {
    panel.style.display = 'none'
    panel.innerHTML = ''
    panel.title = ''
  }
}

function scheduleLockAutoRelease(blockId, context) {
  if (__COLLAB_LOCK_IDLE_TIMER__) {
    clearTimeout(__COLLAB_LOCK_IDLE_TIMER__)
    __COLLAB_LOCK_IDLE_TIMER__ = null
  }
  __COLLAB_LOCK_IDLE_TIMER__ = setTimeout(() => {
    try {
      if (!isConnected() || !__COLLAB_CFG__ || !__COLLAB_DOC_ACTIVE__) return
      if (!__COLLAB_MY_LOCKS__ || __COLLAB_MY_LOCKS__.size === 0) return
      if (__COLLAB_WS__ && __COLLAB_WS__.readyState === WebSocket.OPEN) {
        for (const id of Array.from(__COLLAB_MY_LOCKS__)) {
          try {
            __COLLAB_WS__.send(JSON.stringify({ type: 'unlock', blockId: id }))
          } catch {}
        }
      }
      __COLLAB_MY_LOCKS__.clear()
      __COLLAB_CURRENT_BLOCK_ID__ = ''
    } catch {}
  }, LOCK_IDLE_TIMEOUT_MS)
}

function applyRemoteContent(context, content) {
  const editorEl = getEditorElement()
  let oldSelStart = null
  let oldSelEnd = null
  let oldContent = ''
  let oldBlockStart = -1
  let oldOffsetInBlock = 0
  const currentBlockId = __COLLAB_CURRENT_BLOCK_ID__ || ''

  if (editorEl) {
    try {
      oldSelStart = editorEl.selectionStart >>> 0
      oldSelEnd = editorEl.selectionEnd >>> 0
    } catch {}
  }

  try {
    oldContent = String(context.getEditorValue() || '')
  } catch {
    oldContent = ''
  }

  if (oldContent && typeof oldSelStart === 'number' && currentBlockId && currentBlockId.startsWith('b_')) {
    const idx = parseInt(currentBlockId.slice(2), 10)
    if (!Number.isNaN(idx) && idx >= 0) {
      const range = getBlockRangeByIndex(oldContent, idx)
      if (range && oldSelStart >= range.start && oldSelStart <= range.end) {
        oldBlockStart = range.start >>> 0
        oldOffsetInBlock = (oldSelStart >>> 0) - oldBlockStart
      }
    }
  }

  __COLLAB_APPLYING_REMOTE__ = true
  try {
    context.setEditorValue(content)
  } catch {
  } finally {
    __COLLAB_APPLYING_REMOTE__ = false
  }

  const ed = getEditorElement()
  if (!ed || typeof oldSelStart !== 'number' || typeof oldSelEnd !== 'number') return

  const textNow = String(ed.value || '')
  let s = oldSelStart >>> 0
  let e = oldSelEnd >>> 0

  if (currentBlockId && currentBlockId.startsWith('b_') && oldBlockStart >= 0) {
    const idxNow = parseInt(currentBlockId.slice(2), 10)
    if (!Number.isNaN(idxNow) && idxNow >= 0) {
      const rangeNow = getBlockRangeByIndex(textNow, idxNow)
      if (rangeNow) {
        const blockLen = Math.max(0, (rangeNow.end >>> 0) - (rangeNow.start >>> 0))
        const off = Math.max(0, Math.min(blockLen, oldOffsetInBlock >>> 0))
        s = (rangeNow.start >>> 0) + off
        e = s
      }
    }
  }

  const max = textNow.length
  if (s > max) s = max
  if (e > max) e = max
  if (s < 0) s = 0
  if (e < 0) e = 0
  try {
    ed.selectionStart = s
    ed.selectionEnd = e
  } catch {}
}

async function loadCfg(context) {
  try {
    const stored = await context.storage.get(CFG_KEY)
    return { ...DEFAULT_CFG, ...(stored || {}) }
  } catch {
    return { ...DEFAULT_CFG }
  }
}

async function saveCfg(context, cfg) {
  try {
    await context.storage.set(CFG_KEY, cfg)
  } catch {}
}

function getDocMeta() {
  const doc = (typeof document !== 'undefined' && document) || null
  let fullPath = ''
  let display = ''
  if (doc) {
    try {
      const el = doc.getElementById('filename')
      if (el) {
        fullPath = String(el.getAttribute('title') || '').trim()
        const label = String(el.textContent || '').replace(/\s*\*\s*$/, '').trim()
        if (label && label !== '未命名') display = label
      }
    } catch {}
  }
  if (!display) display = fullPath ? fullPath.split(/[/\\]/).pop() || '未命名' : '未命名'
  const key = fullPath || display || 'untitled'
  return { id: key, title: display, path: fullPath }
}

  function showStatus(context, type, roomCode, message, docTitle) {
  const ui = context && context.ui
  const hasBubble = ui && typeof ui.showNotification === 'function' && typeof ui.hideNotification === 'function'
  let text = ''
  let level = 'ok'

  if (type === 'connecting') {
    text = '正在连接协同...'
    level = 'info'
  } else if (type === 'connected') {
    const docLabel = docTitle ? `（文档：${docTitle}）` : ''
    text = roomCode ? `已连接协同：${roomCode}${docLabel}` : `已连接协同${docLabel}`
    level = 'success'
  } else if (type === 'paused') {
    const docLabel = docTitle ? `（绑定文档：${docTitle}）` : ''
    text = roomCode ? `协同已暂停：当前非绑定文档${docLabel}` : '协同已暂停：当前非绑定文档'
    level = 'success'
  } else if (type === 'error') {
    text = message || '协同连接错误'
    level = 'error'
  } else {
    text = '协同未连接'
    level = 'info'
  }

  if (hasBubble) {
    try {
      if (__COLLAB_STATUS_ID__) {
        ui.hideNotification(__COLLAB_STATUS_ID__)
        __COLLAB_STATUS_ID__ = null
      }
    } catch {}
    try {
      __COLLAB_STATUS_ID__ = ui.showNotification(text, {
        type: level === 'error' ? 'error' : level === 'success' ? 'success' : 'info',
        duration: type === 'connecting' || type === 'connected' ? 0 : 2000
      })
    } catch {
      // 忽略气泡错误，退回到底部状态栏
    }
  }

    if (ui && typeof ui.notice === 'function') {
      try {
        ui.notice(text, level === 'error' ? 'err' : 'ok', type === 'connecting' || type === 'connected' ? 1600 : 2000)
      } catch {}
    }
  }

  function probeOfficialOnline(labelEl, displayName) {
    if (!labelEl) return
    try {
      labelEl.textContent = '官方服务器在线人数：查询中…'
    } catch {}
    try {
      if (__COLLAB_OFFICIAL_PROBE_WS__) {
        try { __COLLAB_OFFICIAL_PROBE_WS__.close() } catch {}
        __COLLAB_OFFICIAL_PROBE_WS__ = null
      }
      if (__COLLAB_OFFICIAL_PROBE_TIMER__ != null) {
        clearTimeout(__COLLAB_OFFICIAL_PROBE_TIMER__)
        __COLLAB_OFFICIAL_PROBE_TIMER__ = null
      }
    } catch {}

    let ws
    try {
      const name = String(displayName || '探测').trim() || '探测'
      const url =
        OFFICIAL_SERVER_URL +
        '?room=' + encodeURIComponent(OFFICIAL_ROOM_CODE) +
        '&password=' + encodeURIComponent(OFFICIAL_PASSWORD) +
        '&name=' + encodeURIComponent(name)
      ws = new WebSocket(url)
    } catch (e) {
      try { labelEl.textContent = '官方服务器在线人数：查询失败' } catch {}
      return
    }

    __COLLAB_OFFICIAL_PROBE_WS__ = ws
    let settled = false
    const finish = (text) => {
      if (settled) return
      settled = true
      try { labelEl.textContent = text } catch {}
      try { ws && ws.close() } catch {}
      if (__COLLAB_OFFICIAL_PROBE_WS__ === ws) __COLLAB_OFFICIAL_PROBE_WS__ = null
      if (__COLLAB_OFFICIAL_PROBE_TIMER__ != null) {
        clearTimeout(__COLLAB_OFFICIAL_PROBE_TIMER__)
        __COLLAB_OFFICIAL_PROBE_TIMER__ = null
      }
    }

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ type: 'join', content: '' }))
      } catch {}
    }

    ws.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(String(ev.data || ''))
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'peers') {
        let n = 0
        try {
          const peers = Array.isArray(msg.peers) ? msg.peers : []
          n = peers.length >>> 0
        } catch {}
        finish(`官方服务器在线人数：${n}`)
      }
    }

    ws.onerror = () => {
      finish('官方服务器在线人数：查询失败')
    }

    ws.onclose = () => {
      if (!settled) finish('官方服务器在线人数：查询失败')
    }

    __COLLAB_OFFICIAL_PROBE_TIMER__ = setTimeout(() => {
      finish('官方服务器在线人数：查询超时')
    }, 5000)
  }

function isConnected() {
  return __COLLAB_WS__ && __COLLAB_WS__.readyState === WebSocket.OPEN
}

function stopCollab() {
  if (__COLLAB_TIMER__) {
    clearInterval(__COLLAB_TIMER__)
    __COLLAB_TIMER__ = null
  }
  if (__COLLAB_WS__) {
    try {
      __COLLAB_WS__.close()
    } catch {}
    __COLLAB_WS__ = null
  }
  if (__COLLAB_CTX__) {
    showStatus(__COLLAB_CTX__, 'idle')
  }
  clearLockPanel()
  hideLocalCaret()
  applyEditorCaretColor(false)
}

function startSyncLoop(context, cfg) {
  if (__COLLAB_TIMER__) clearInterval(__COLLAB_TIMER__)
  __COLLAB_TIMER__ = setInterval(() => {
    if (!isConnected()) return
    if (!__COLLAB_CTX__) return
    const meta = getDocMeta()
    const active = cfg.boundDocId && meta.id === cfg.boundDocId

    if (active && !__COLLAB_DOC_ACTIVE__) {
      __COLLAB_DOC_ACTIVE__ = true
      if (typeof __COLLAB_LAST__ === 'string' && __COLLAB_LAST__) {
        __COLLAB_APPLYING_REMOTE__ = true
        try {
          context.setEditorValue(__COLLAB_LAST__)
        } catch {}
        __COLLAB_APPLYING_REMOTE__ = false
      }
      showStatus(context, 'connected', cfg.roomCode, null, cfg.boundDocTitle)
      applyEditorCaretColor(true)
      try { updateLocalCaretVisual() } catch {}
    } else if (!active && __COLLAB_DOC_ACTIVE__) {
      __COLLAB_DOC_ACTIVE__ = false
      showStatus(context, 'paused', cfg.roomCode, null, cfg.boundDocTitle)
      applyEditorCaretColor(false)
      hideLocalCaret()
    }

    if (!active) return
    let current = ''
    try {
      current = String(__COLLAB_CTX__.getEditorValue() || '')
    } catch {
      return
    }
    if (__COLLAB_APPLYING_REMOTE__) return
    if (current === __COLLAB_LAST__) return
    __COLLAB_LAST__ = current
    try {
      __COLLAB_WS__.send(JSON.stringify({ type: 'update', content: current }))
    } catch {
      // 忽略发送失败，等待重连
    }
  }, cfg.syncIntervalMs || DEFAULT_CFG.syncIntervalMs)
}

async function startCollab(context, cfg) {
  stopCollab()

  const mode = cfg && cfg.serverMode === 'official' ? 'official' : 'custom'
  const wsUrl =
    mode === 'official'
      ? OFFICIAL_SERVER_URL
      : String(cfg.serverUrl || '').trim()
  const room =
    mode === 'official'
      ? OFFICIAL_ROOM_CODE
      : String(cfg.roomCode || '').trim()
  const pwd =
    mode === 'official'
      ? OFFICIAL_PASSWORD
      : String(cfg.password || '').trim()
  const name = String(cfg.displayName || '').trim()

  if (!wsUrl || !room || !pwd) {
    context.ui.notice('服务器地址、房间号和密码不能为空', 'err', 2200)
    return
  }

  const url =
    wsUrl +
    '?room=' +
    encodeURIComponent(room) +
    '&password=' +
    encodeURIComponent(pwd) +
    '&name=' +
    encodeURIComponent(name || '')

  let ws
  try {
    ws = new WebSocket(url)
  } catch (e) {
    context.ui.notice('无法创建 WebSocket 连接', 'err', 2500)
    showStatus(context, 'error', null, '无法创建 WebSocket 连接')
    return
  }

    __COLLAB_WS__ = ws
    __COLLAB_CFG__ = cfg
    __COLLAB_MY_NAME__ = name || '匿名'
    __COLLAB_MY_COLOR__ = colorFromName(__COLLAB_MY_NAME__)
    applyEditorCaretColor(true)

  showStatus(context, 'connecting', room, null, cfg.boundDocTitle)

  ws.onopen = () => {
    try {
      __COLLAB_LAST__ = String(context.getEditorValue() || '')
      ws.send(JSON.stringify({ type: 'join', content: __COLLAB_LAST__ }))
      startSyncLoop(context, cfg)
      context.ui.notice('协同连接成功', 'ok', 2000)
      __COLLAB_DOC_ACTIVE__ = true
      showStatus(context, 'connected', room, null, cfg.boundDocTitle)
      try { updateLocalCaretVisual() } catch {}
    } catch (e) {
      context.ui.notice('协同初始化失败', 'err', 2500)
      showStatus(context, 'error', room, '协同初始化失败', cfg.boundDocTitle)
    }
  }

  ws.onmessage = (ev) => {
    let msg
    try {
      msg = JSON.parse(String(ev.data || ''))
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return

    if (msg.type === 'error') {
      const m = msg.message || msg.code || '协同服务器错误'
      context.ui.notice(String(m), 'err', 3000)
      showStatus(context, 'error', null, String(m), __COLLAB_BOUND_DOC_TITLE__)
      return
    }

    if (msg.type === 'locks_state') {
      const next = Object.create(null)
      if (Array.isArray(msg.locks)) {
        for (const it of msg.locks) {
          if (!it || typeof it.blockId !== 'string') continue
          const id = String(it.blockId)
          next[id] = {
            name: typeof it.name === 'string' ? it.name : '',
            color: typeof it.color === 'string' ? it.color : '',
            label: typeof it.label === 'string' ? it.label : ''
          }
        }
      }
      __COLLAB_LOCKS__ = next
      renderLockPanel()
      return
    }

    if (msg.type === 'peers') {
      if (Array.isArray(msg.peers)) {
        __COLLAB_PEERS__ = msg.peers.map((x) => String(x || '')).filter(Boolean)
      } else {
        __COLLAB_PEERS__ = []
      }
      renderLockPanel()
      return
    }

    if (msg.type === 'lock_error') {
      const owner = msg.name || '其他协作者'
      const blockId = msg.blockId || ''
      if (blockId && __COLLAB_CURRENT_BLOCK_ID__ === blockId) {
        context.ui.notice(`该段已被 ${owner} 锁定协同编辑`, 'err', 2600)
      }
      return
    }

    if (msg.type === 'snapshot' || msg.type === 'update') {
      if (typeof msg.content !== 'string') return
      const cfgNow = __COLLAB_CFG__
      const meta = getDocMeta()
      const active = cfgNow && cfgNow.boundDocId && meta.id === cfgNow.boundDocId
      if (!active) return
      let current = ''
      try {
        current = String(context.getEditorValue() || '')
      } catch {}
      if (msg.type === 'snapshot') {
        if (current === msg.content) {
          __COLLAB_LAST__ = msg.content
          return
        }
        applyRemoteContent(context, msg.content)
        __COLLAB_LAST__ = msg.content
        return
      }
      // update：避免覆盖本地未同步编辑
      if (current === msg.content) {
        __COLLAB_LAST__ = msg.content
        return
      }
      if (current !== __COLLAB_LAST__) {
        // 本地已有新内容尚未同步，跳过这次远程更新
        return
      }
      const now = Date.now()
      if (__COLLAB_LAST_TYPED_AT__ && now - __COLLAB_LAST_TYPED_AT__ < REMOTE_APPLY_QUIET_MS) {
        // 本地刚刚有输入，暂缓应用远程更新以避免抢走光标
        return
      }
      applyRemoteContent(context, msg.content)
      __COLLAB_LAST__ = msg.content
      return
    }
  }

  ws.onerror = () => {
    context.ui.notice('协同连接异常', 'err', 2500)
    showStatus(context, 'error', null, '协同连接异常', __COLLAB_BOUND_DOC_TITLE__)
  }

  ws.onclose = () => {
    stopCollab()
    context.ui.notice('协同连接已关闭', 'ok', 2000)
    showStatus(context, 'idle')
  }
}

function ensurePanel(context) {
  if (__COLLAB_PANEL_EL__) return __COLLAB_PANEL_EL__
  const doc = (typeof document !== 'undefined' && document) || null
  if (!doc) return null
  const overlay = doc.createElement('div')
  overlay.id = 'local-collab-overlay-os'
  overlay.style.position = 'fixed'
  overlay.style.left = '0'
  overlay.style.top = '0'
  overlay.style.right = '0'
  overlay.style.bottom = '0'
  overlay.style.background = 'rgba(0,0,0,0.35)'
  overlay.style.display = 'flex'
  overlay.style.alignItems = 'center'
  overlay.style.justifyContent = 'center'
  overlay.style.zIndex = '999999'

  const panel = doc.createElement('div')
  panel.style.minWidth = '360px'
  panel.style.maxWidth = '420px'
  panel.style.background = '#1f1f1f'
  panel.style.borderRadius = '8px'
  panel.style.boxShadow = '0 12px 40px rgba(0,0,0,0.45)'
  panel.style.padding = '16px 18px 14px'
  panel.style.color = '#f5f5f5'
  panel.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  panel.style.fontSize = '13px'

  const title = doc.createElement('div')
  title.textContent = '协同编辑连接（开源服务器）'
  title.style.fontSize = '15px'
  title.style.fontWeight = '600'
  title.style.marginBottom = '10px'

  const hint = doc.createElement('div')
  hint.textContent = '填写协同服务器地址、房间号和密码。'
  hint.style.opacity = '0.75'
  hint.style.marginBottom = '12px'

  const mkField = (labelText, id, type, placeholder) => {
    const wrap = doc.createElement('div')
    wrap.style.marginBottom = '8px'
    const label = doc.createElement('div')
    label.textContent = labelText
    label.style.marginBottom = '4px'
    label.style.opacity = '0.8'
    const input = doc.createElement('input')
    input.id = id
    input.type = type || 'text'
    if (placeholder) input.placeholder = placeholder
    input.style.width = '100%'
    input.style.boxSizing = 'border-box'
    input.style.borderRadius = '4px'
    input.style.border = '1px solid #3a3a3a'
    input.style.padding = '5px 8px'
    input.style.background = '#121212'
    input.style.color = '#f5f5f5'
    input.style.outline = 'none'
    input.addEventListener('focus', () => {
      input.style.borderColor = '#409eff'
    })
    input.addEventListener('blur', () => {
      input.style.borderColor = '#3a3a3a'
    })
    wrap.appendChild(label)
    wrap.appendChild(input)
    return { wrap, input }
  }

  const serverField = mkField(
    '协同服务器地址（必填）',
    'local-collab-server',
    'text',
    '例如：ws://127.0.0.1:3456/ws'
  )
  const roomField = mkField('协同房间号（协同号）', 'local-collab-room', 'text')
  const passField = mkField('协同密码', 'local-collab-pass', 'password')
  const nameField = mkField('显示名称（可选，用于协同中标识你）', 'local-collab-name', 'text')

  const modeWrap = doc.createElement('div')
  modeWrap.style.marginBottom = '8px'
  modeWrap.style.display = 'flex'
  modeWrap.style.alignItems = 'center'
  modeWrap.style.gap = '12px'

  const modeLabel = doc.createElement('div')
  modeLabel.textContent = '服务器类型：'
  modeLabel.style.opacity = '0.8'
  modeWrap.appendChild(modeLabel)

  const officialLabel = doc.createElement('label')
  officialLabel.style.display = 'inline-flex'
  officialLabel.style.alignItems = 'center'
  officialLabel.style.gap = '4px'
  const officialInput = doc.createElement('input')
  officialInput.type = 'radio'
  officialInput.name = 'local-collab-mode'
  officialInput.id = 'local-collab-mode-official'
  officialInput.value = 'official'
  officialLabel.appendChild(officialInput)
  const officialText = doc.createElement('span')
  officialText.textContent = '官方服务器'
  officialLabel.appendChild(officialText)
  modeWrap.appendChild(officialLabel)

  const customLabel = doc.createElement('label')
  customLabel.style.display = 'inline-flex'
  customLabel.style.alignItems = 'center'
  customLabel.style.gap = '4px'
  const customInput = doc.createElement('input')
  customInput.type = 'radio'
  customInput.name = 'local-collab-mode'
  customInput.id = 'local-collab-mode-custom'
  customInput.value = 'custom'
  customInput.checked = true
  customLabel.appendChild(customInput)
  const customText = doc.createElement('span')
  customText.textContent = '自定义服务器'
  customLabel.appendChild(customText)
  modeWrap.appendChild(customLabel)

  const officialOnline = doc.createElement('div')
  officialOnline.id = 'local-collab-official-online'
  officialOnline.style.fontSize = '11px'
  officialOnline.style.opacity = '0.8'
  officialOnline.style.marginTop = '4px'
  officialOnline.textContent = ''

  const status = doc.createElement('div')
  status.id = 'local-collab-panel-status'
  status.style.marginTop = '2px'
  status.style.marginBottom = '6px'
  status.style.fontSize = '12px'
  status.style.opacity = '0.8'

  const btnRow = doc.createElement('div')
  btnRow.style.display = 'flex'
  btnRow.style.justifyContent = 'flex-end'
  btnRow.style.marginTop = '8px'
  btnRow.style.gap = '8px'

  const btnCancel = doc.createElement('button')
  btnCancel.textContent = '取消'
  btnCancel.style.padding = '4px 10px'
  btnCancel.style.borderRadius = '4px'
  btnCancel.style.border = '1px solid #555'
  btnCancel.style.background = 'transparent'
  btnCancel.style.color = '#eee'
  btnCancel.style.cursor = 'pointer'

  const btnConnect = doc.createElement('button')
  btnConnect.textContent = '连接'
  btnConnect.style.padding = '4px 12px'
  btnConnect.style.borderRadius = '4px'
  btnConnect.style.border = '1px solid #409eff'
  btnConnect.style.background = '#409eff'
  btnConnect.style.color = '#fff'
  btnConnect.style.cursor = 'pointer'

  btnRow.appendChild(btnCancel)
  btnRow.appendChild(btnConnect)

  const applyMode = (mode) => {
    const isOfficial = mode === 'official'
    if (isOfficial) {
      hint.textContent = '使用官方协同服务器，无需配置地址。'
    } else {
      hint.textContent = '填写协同服务器地址、房间号和密码。'
    }
    serverField.wrap.style.display = isOfficial ? 'none' : 'block'
    roomField.wrap.style.display = isOfficial ? 'none' : 'block'
    passField.wrap.style.display = isOfficial ? 'none' : 'block'
    officialOnline.style.display = isOfficial ? 'block' : 'none'
  }

  customInput.addEventListener('change', () => {
    if (customInput.checked) applyMode('custom')
  })
  officialInput.addEventListener('change', () => {
    if (officialInput.checked) {
      applyMode('official')
      try {
        probeOfficialOnline(officialOnline, nameField.input.value || '')
      } catch {}
    }
  })

  // 默认使用自定义服务器模式
  applyMode('custom')

  panel.appendChild(title)
  panel.appendChild(hint)
  panel.appendChild(modeWrap)
  panel.appendChild(officialOnline)
  panel.appendChild(serverField.wrap)
  panel.appendChild(roomField.wrap)
  panel.appendChild(passField.wrap)
  panel.appendChild(nameField.wrap)
  panel.appendChild(status)
  panel.appendChild(btnRow)
  overlay.appendChild(panel)
  doc.body.appendChild(overlay)

  const hide = () => {
    overlay.style.display = 'none'
    __COLLAB_PANEL_VISIBLE__ = false
  }

  btnCancel.addEventListener('click', () => {
    hide()
  })

  btnConnect.addEventListener('click', async () => {
    const ctx = __COLLAB_CTX__ || context
    if (!ctx) return
    const useOfficial = officialInput.checked
    let serverUrl = ''
    let roomCode = ''
    let password = ''
    const displayName = String(nameField.input.value || '').trim()

    if (useOfficial) {
      serverUrl = OFFICIAL_SERVER_URL
      roomCode = OFFICIAL_ROOM_CODE
      password = OFFICIAL_PASSWORD
    } else {
      serverUrl = String(serverField.input.value || '').trim()
      roomCode = String(roomField.input.value || '').trim()
      password = String(passField.input.value || '').trim()
      if (!serverUrl) {
        ctx.ui.notice('服务器地址不能为空', 'err', 2000)
        return
      }
      if (!roomCode) {
        ctx.ui.notice('房间号不能为空', 'err', 2000)
        return
      }
      if (!password) {
        ctx.ui.notice('密码不能为空', 'err', 2000)
        return
      }
    }

    const cfg = await loadCfg(ctx)
    const meta = getDocMeta()
    const nextCfg = {
      ...cfg,
      serverMode: useOfficial ? 'official' : 'custom',
      customServerUrl: useOfficial ? (cfg.customServerUrl || serverField.input.value || '') : serverUrl,
      customRoomCode: useOfficial ? (cfg.customRoomCode || roomField.input.value || '') : roomCode,
      customPassword: useOfficial ? (cfg.customPassword || passField.input.value || '') : password,
      serverUrl,
      roomCode,
      password,
      displayName,
      boundDocId: meta.id,
      boundDocTitle: meta.title
    }
    __COLLAB_BOUND_DOC_ID__ = meta.id
    __COLLAB_BOUND_DOC_TITLE__ = meta.title
    await saveCfg(ctx, nextCfg)
    hide()
    await startCollab(ctx, nextCfg)
  })

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) hide()
  })

  __COLLAB_PANEL_EL__ = overlay
  return overlay
}

async function openCollab(context) {
  const cfg = await loadCfg(context)
  const overlay = ensurePanel(context)
  if (!overlay) {
    context.ui.notice('协同配置窗口创建失败', 'err', 2200)
    return
  }
  const doc = overlay.ownerDocument
  const serverInput = doc.getElementById('local-collab-server')
  const roomInput = doc.getElementById('local-collab-room')
  const passInput = doc.getElementById('local-collab-pass')
  const nameInput = doc.getElementById('local-collab-name')
  const modeOfficialInput = doc.getElementById('local-collab-mode-official')
  const modeCustomInput = doc.getElementById('local-collab-mode-custom')
  const officialOnlineEl = doc.getElementById('local-collab-official-online')

  const customServerUrl = cfg.customServerUrl || cfg.serverUrl || ''
  const customRoomCode = cfg.customRoomCode || cfg.roomCode || ''
  const customPassword = cfg.customPassword || cfg.password || ''

  if (serverInput) serverInput.value = customServerUrl
  if (roomInput) roomInput.value = customRoomCode
  if (passInput) passInput.value = customPassword
  if (nameInput) nameInput.value = cfg.displayName || ''

  const useOfficial = cfg.serverMode === 'official'
  if (modeOfficialInput && modeCustomInput) {
    if (useOfficial) {
      modeOfficialInput.checked = true
      modeCustomInput.checked = false
      try {
        modeOfficialInput.dispatchEvent(new Event('change'))
      } catch {}
      if (officialOnlineEl) {
        try {
          probeOfficialOnline(officialOnlineEl, nameInput ? nameInput.value : '')
        } catch {}
      }
    } else {
      modeOfficialInput.checked = false
      modeCustomInput.checked = true
      try {
        modeCustomInput.dispatchEvent(new Event('change'))
      } catch {}
    }
  }
  const meta = getDocMeta()
  const statusEl = doc.getElementById('local-collab-panel-status')
  if (statusEl) {
    const bound = cfg.boundDocId && cfg.boundDocId === meta.id
    if (isConnected() && bound) {
      statusEl.textContent = `当前已连接房间：${cfg.roomCode || ''}（文档：${cfg.boundDocTitle || meta.title}）`
    } else if (isConnected()) {
      statusEl.textContent = `当前有协同连接，但绑定的是其他文档：${cfg.boundDocTitle || ''}`
    } else {
      statusEl.textContent = `绑定文档：${meta.title}`
    }
  }
  overlay.style.display = 'flex'
  __COLLAB_PANEL_VISIBLE__ = true
  if (serverInput) {
    serverInput.focus()
    serverInput.select()
  }
}

function bindLockGuards(context) {
  const editorEl = getEditorElement()
  if (!editorEl || typeof editorEl.addEventListener !== 'function') return
  const handler = (e) => {
    try {
      if (!isConnected() || !__COLLAB_CFG__ || !__COLLAB_DOC_ACTIVE__) return
      const ta = e.target
        if (!ta || ta !== editorEl) return
        __COLLAB_LAST_TYPED_AT__ = Date.now()
      const content = String(context.getEditorValue() || '')
      const pos = ta.selectionStart >>> 0
      const info = getBlockInfo(content, pos)
      __COLLAB_CURRENT_BLOCK_ID__ = info.id
      const lock = __COLLAB_LOCKS__[info.id]
      if (lock && lock.name && lock.name !== __COLLAB_MY_NAME__) {
        e.preventDefault()
        context.ui.notice(`该段已被 ${lock.name} 锁定协同编辑`, 'err', 2200)
        return
      }
      if (!lock || !lock.name || lock.name === __COLLAB_MY_NAME__) {
        if (!__COLLAB_MY_LOCKS__.has(info.id) && __COLLAB_WS__ && __COLLAB_WS__.readyState === WebSocket.OPEN) {
          try {
            __COLLAB_WS__.send(
              JSON.stringify({
                type: 'lock',
                blockId: info.id,
                label: info.label,
                color: __COLLAB_MY_COLOR__ || undefined
              })
            )
            __COLLAB_MY_LOCKS__.add(info.id)
          } catch {}
        }
          if (__COLLAB_MY_LOCKS__.has(info.id)) {
            scheduleLockAutoRelease(info.id, context)
          }
        }
        try {
          updateLocalCaretVisual()
        } catch {}
      } catch {}
  }
  editorEl.addEventListener('beforeinput', handler, true)
  try {
    editorEl.addEventListener('keyup', () => {
      try {
        updateLocalCaretVisual()
      } catch {}
    })
    editorEl.addEventListener('click', () => {
      try {
        updateLocalCaretVisual()
      } catch {}
    })
    editorEl.addEventListener('scroll', () => {
      try {
        updateLocalCaretVisual()
      } catch {}
    })
  } catch {}
}

export async function activate(context) {
  __COLLAB_CTX__ = context

    if (typeof context.onSelectionChange === 'function') {
      try {
        context.onSelectionChange((sel) => {
          try {
            if (!isConnected() || !__COLLAB_CFG__ || !__COLLAB_DOC_ACTIVE__) return
          const content = String(context.getEditorValue() || '')
          const info = getBlockInfo(content, sel.start >>> 0)
          const prevId = __COLLAB_CURRENT_BLOCK_ID__
            __COLLAB_CURRENT_BLOCK_ID__ = info.id
            if (prevId && prevId !== info.id && __COLLAB_MY_LOCKS__.has(prevId) && __COLLAB_WS__ && __COLLAB_WS__.readyState === WebSocket.OPEN) {
              try {
                __COLLAB_WS__.send(JSON.stringify({ type: 'unlock', blockId: prevId }))
              } catch {}
              __COLLAB_MY_LOCKS__.delete(prevId)
            }
            if (__COLLAB_MY_LOCKS__.has(info.id)) {
              scheduleLockAutoRelease(info.id, context)
            }
            try {
              updateLocalCaretVisual()
            } catch {}
          } catch {}
        })
      } catch {}
  }

  bindLockGuards(context)

  context.addMenuItem({
    label: '协同编辑（开源服务器）',
    title: '连接开源协同服务器（服务器地址 + 房间号 + 密码）',
    children: [
      {
        label: '连接 / 切换房间',
        onClick: async () => {
          await openCollab(context)
        }
      },
      {
        label: '断开协同',
        onClick: async () => {
          if (!isConnected()) {
            context.ui.notice('当前未连接协同', 'err', 2000)
            return
          }
          stopCollab()
          context.ui.notice('已断开协同连接', 'ok', 2000)
        }
      },
      {
        label: '重新连接',
        onClick: async () => {
          const cfg = await loadCfg(context)
          if (!cfg.serverUrl || !cfg.roomCode || !cfg.password) {
            context.ui.notice('尚未配置服务器地址、房间号和密码', 'err', 2200)
            return
          }
          await startCollab(context, cfg)
        }
      }
    ]
  })

  context.ui.notice('开源协同编辑插件已激活', 'ok', 2000)
}

export function deactivate() {
  stopCollab()
  __COLLAB_CTX__ = null
}

export async function openSettings(context) {
  const cfg = await loadCfg(context)
  const syncIntervalStr =
    prompt('同步间隔（毫秒，建议 >= 500）:', String(cfg.syncIntervalMs || DEFAULT_CFG.syncIntervalMs)) ||
    String(cfg.syncIntervalMs || DEFAULT_CFG.syncIntervalMs)

  const syncIntervalMs = Math.max(300, parseInt(syncIntervalStr || '1000', 10) || 1000)

  const nextCfg = {
    ...cfg,
    syncIntervalMs
  }
  await saveCfg(context, nextCfg)
  context.ui.notice('协同插件配置已保存', 'ok', 2000)
}
