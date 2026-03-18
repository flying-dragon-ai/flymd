const LS_KEY = 'flymd:blinko-snap:settings'
const STYLE_ID = 'blinko-snap-style'
const SETTINGS_OVERLAY_ID = 'blinko-snap-settings-overlay'
const SYNC_OVERLAY_ID = 'blinko-snap-sync-overlay'
const NOTE_WORKBENCH_OVERLAY_ID = 'blinko-snap-note-workbench-overlay'
const TASKS_OVERLAY_ID = 'blinko-snap-tasks-overlay'
const DEFAULT_API_BASE = 'https://api.blinko.space/api'
const LOCAL_FILE_SUFFIX_RE = /__blinko_(\d+)\.(md|markdown|txt)$/i
const MAX_PAGE_SIZE = 100
const SYNC_PANEL_PAGE_SIZE = MAX_PAGE_SIZE
const TASK_SECTION_START = '<!-- blinko-tasks:start -->'
const TASK_SECTION_END = '<!-- blinko-tasks:end -->'

let globalContextRef = null
let menuDisposer = null
let ribbonDisposer = null
let ctxMenuDisposers = []
let settingsOverlayEl = null
let syncOverlayEl = null
let noteWorkbenchOverlayEl = null
let tasksOverlayEl = null
let tagCache = {
  key: '',
  at: 0,
  tags: null
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function sanitizePathSegment(raw) {
  return String(raw ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/g, '')
}

function sanitizeFileName(raw) {
  const safe = sanitizePathSegment(raw).replace(/[. ]+$/g, '')
  return (safe || 'untitled').slice(0, 80)
}

function normalizeLocalFolderPath(raw) {
  const parts = String(raw ?? '')
    .split(/[\\/]+/)
    .map((part) => sanitizePathSegment(part))
    .filter((part) => part && part !== '.' && part !== '..')
  return parts.length ? parts.join('/') : 'blinko'
}

function deriveSiteUrlFromApiBase(raw) {
  const apiBase = String(raw ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(apiBase)) return ''
  return apiBase.replace(/\/api$/i, '')
}

function normalizeLineBreaks(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n')
}

function joinFsPath(base, ...parts) {
  let out = String(base ?? '')
  for (const partRaw of parts) {
    const part = String(partRaw ?? '')
    if (!part) continue
    if (!out) {
      out = part
      continue
    }
    const sep = out.includes('\\') ? '\\' : '/'
    out =
      out.replace(/[\\/]+$/, '') +
      sep +
      part.replace(/^[\\/]+/, '').replace(/[\\/]+/g, sep)
  }
  return out
}

function dirnameFs(path) {
  const raw = String(path ?? '')
  if (!raw) return ''
  const idx = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
  return idx >= 0 ? raw.slice(0, idx) : ''
}

function basenameFs(path) {
  const raw = String(path ?? '')
  if (!raw) return ''
  const idx = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
  return idx >= 0 ? raw.slice(idx + 1) : raw
}

function createDefaultSettings() {
  return {
    apiBase: DEFAULT_API_BASE,
    apiToken: '',
    siteUrl: deriveSiteUrlFromApiBase(DEFAULT_API_BASE),
    localFolder: 'blinko',
    pullPageSize: 20,
    openAfterPull: false,
    defaultTag: '',
    uploadRemoteImages: false
  }
}

function normalizeSettings(input) {
  const defaults = createDefaultSettings()
  const next = Object.assign({}, defaults, input || {})
  next.apiBase = String(next.apiBase || defaults.apiBase).trim() || defaults.apiBase
  next.apiToken = String(next.apiToken || '').trim()
  next.siteUrl = String(next.siteUrl || '').trim().replace(/\/+$/, '') || deriveSiteUrlFromApiBase(next.apiBase)
  next.localFolder = normalizeLocalFolderPath(next.localFolder)
  next.pullPageSize = clampInt(next.pullPageSize, 1, MAX_PAGE_SIZE, defaults.pullPageSize)
  next.openAfterPull = !!next.openAfterPull
  next.defaultTag = String(next.defaultTag || '').trim()
  next.uploadRemoteImages = !!next.uploadRemoteImages
  return next
}

async function loadSettings(context) {
  const defaults = createDefaultSettings()
  try {
    if (context && context.storage && typeof context.storage.get === 'function') {
      const stored = await context.storage.get('settings')
      if (stored && typeof stored === 'object') {
        return normalizeSettings(stored)
      }
    }
  } catch {}
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return defaults
    return normalizeSettings(JSON.parse(raw))
  } catch {
    return defaults
  }
}

function resetTagCache() {
  tagCache = { key: '', at: 0, tags: null }
}

async function saveSettings(context, settings) {
  const payload = normalizeSettings(settings)
  try {
    if (context && context.storage && typeof context.storage.set === 'function') {
      await context.storage.set('settings', payload)
    }
  } catch {}
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(payload))
  } catch {}
  resetTagCache()
  return payload
}

function safeNotice(context, msg, type = 'ok', ms = 2200) {
  try {
    if (context && context.ui && typeof context.ui.notice === 'function') {
      context.ui.notice(String(msg || ''), type, ms)
    }
  } catch {}
}

async function safeConfirm(context, message) {
  try {
    if (context && context.ui && typeof context.ui.confirm === 'function') {
      return await context.ui.confirm(String(message || ''))
    }
  } catch {}
  try {
    if (typeof confirm === 'function') {
      return !!confirm(String(message || ''))
    }
  } catch {}
  return false
}

function getErrorMessage(error) {
  return error && error.message ? String(error.message) : String(error || '未知错误')
}

function shouldAutoOpenSettings(msg) {
  return /(未配置|UNAUTHORIZED|Authorization|Token|401|地址|网址|site)/i.test(String(msg || ''))
}

function handleActionError(context, prefix, error, allowOpenSettings = true) {
  const msg = getErrorMessage(error)
  safeNotice(context, prefix + msg, 'err', 4200)
  if (allowOpenSettings && shouldAutoOpenSettings(msg)) {
    try {
      void openSettingsDialog(context)
    } catch {}
  }
}

async function runGuardedAction(context, prefix, task) {
  try {
    return await task()
  } catch (error) {
    handleActionError(context, prefix, error, true)
    return null
  }
}

function getDocMetaSafe(context) {
  try {
    if (context && typeof context.getDocMeta === 'function') {
      return context.getDocMeta() || {}
    }
  } catch {}
  return {}
}

function getDocBodyText(context) {
  try {
    if (context && typeof context.getDocBody === 'function') {
      return String(context.getDocBody() || '')
    }
  } catch {}
  try {
    if (context && typeof context.getEditorValue === 'function') {
      return String(context.getEditorValue() || '')
    }
  } catch {}
  return ''
}

function stripDisplayTitle(text) {
  let s = String(text || '').trim()
  s = s.replace(/^#+\s*/, '')
  s = s.replace(/^>\s*/, '')
  s = s.replace(/^\s*[-*+]\s*\[[ xX]\]\s*/, '')
  s = s.replace(/^\s*[-*+]\s*/, '')
  return s.trim()
}

function guessTitleFromBody(body) {
  const lines = normalizeLineBreaks(body)
    .split('\n')
    .map((line) => stripDisplayTitle(line))
    .filter((line) => line.length > 0)
  if (!lines.length) return '未命名文章'
  return lines[0].slice(0, 80)
}

function normalizeTagToken(value) {
  if (value == null) return ''
  if (typeof value === 'object') {
    if (typeof value.name === 'string') return value.name.trim()
    if (typeof value.value === 'string') return value.value.trim()
    return ''
  }
  return String(value).trim()
}

function dedupeStrings(list) {
  const out = []
  const seen = new Set()
  for (const item of list || []) {
    const s = String(item || '').trim()
    if (!s) continue
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

function normalizeTags(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) {
    return dedupeStrings(raw.map((item) => normalizeTagToken(item)).filter(Boolean))
  }
  if (typeof raw === 'string') {
    return dedupeStrings(
      raw
        .split(/[,，]/)
        .map((item) => normalizeTagToken(item))
        .filter(Boolean)
    )
  }
  return dedupeStrings([normalizeTagToken(raw)].filter(Boolean))
}

function extractDocTags(meta) {
  return dedupeStrings([
    ...normalizeTags(meta && meta.tags),
    ...normalizeTags(meta && meta.keywords),
    ...normalizeTags(meta && meta.tag),
    ...normalizeTags(meta && meta.blinkoTags)
  ])
}

function maybeFiniteNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function extractBlinkoCollection(payload) {
  const candidates = [
    payload,
    payload && payload.data,
    payload && payload.list,
    payload && payload.items,
    payload && payload.records,
    payload && payload.notes,
    payload && payload.result,
    payload && payload.result && payload.result.list,
    payload && payload.result && payload.result.items,
    payload && payload.result && payload.result.records,
    payload && payload.result && payload.result.notes,
    payload && payload.data && payload.data.list,
    payload && payload.data && payload.data.items,
    payload && payload.data && payload.data.records,
    payload && payload.data && payload.data.notes,
    payload && payload.data && payload.data.result,
    payload && payload.data && payload.data.result && payload.data.result.list,
    payload && payload.data && payload.data.result && payload.data.result.items,
    payload && payload.data && payload.data.result && payload.data.result.records
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate
  }
  return []
}

function looksLikeBlinkoNote(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return (
    maybeFiniteNumber(value.id) != null ||
    typeof value.content === 'string' ||
    maybeFiniteNumber(value.type) != null ||
    !!(value.metadata && typeof value.metadata === 'object')
  )
}

function extractBlinkoNoteEntity(payload) {
  const candidates = [
    payload,
    payload && payload.data,
    payload && payload.note,
    payload && payload.result,
    payload && payload.data && payload.data.note,
    payload && payload.data && payload.data.result,
    payload && payload.result && payload.result.note
  ]
  for (const candidate of candidates) {
    if (looksLikeBlinkoNote(candidate)) return candidate
  }
  return null
}

function extractBlinkoIdFromMeta(meta) {
  if (!meta || typeof meta !== 'object') return null
  const candidates = [
    meta.blinkoId,
    meta.blinkoID,
    meta.blinko_id,
    meta.blinko && meta.blinko.id
  ]
  for (const candidate of candidates) {
    const id = maybeFiniteNumber(candidate)
    if (id != null && id > 0) return id
  }
  return null
}

function extractBlinkoTypeFromMeta(meta) {
  if (!meta || typeof meta !== 'object') return 0
  const candidates = [
    meta.blinkoType,
    meta.blinko_type,
    meta.type,
    meta.blinko && meta.blinko.type
  ]
  for (const candidate of candidates) {
    const n = maybeFiniteNumber(candidate)
    if (n === -1 || n === 0 || n === 1 || n === 2) return n
  }
  return 0
}

function buildNoteTitle(meta, body) {
  const candidates = [meta && meta.title, meta && meta.name, meta && meta.subject]
  for (const candidate of candidates) {
    const text = String(candidate || '').trim()
    if (text) return text.slice(0, 120)
  }
  return guessTitleFromBody(body)
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function plainTextSnippet(text, limit = 220) {
  let out = normalizeLineBreaks(text)
  out = out.replace(/!\[[^\]]*]\(([^)]+)\)/g, '[图片]')
  out = out.replace(/\[([^\]]+)]\(([^)]+)\)/g, '$1')
  out = out.replace(/[`>#*_~|-]/g, ' ')
  out = out.replace(/\s+/g, ' ').trim()
  if (out.length > limit) return out.slice(0, limit) + '...'
  return out
}

function formatDateTime(raw) {
  if (!raw) return ''
  try {
    const d = new Date(raw)
    if (!Number.isNaN(d.getTime())) return d.toLocaleString()
  } catch {}
  return String(raw)
}

function yamlScalar(value) {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return JSON.stringify(String(value == null ? '' : value).replace(/\r?\n/g, ' ').trim())
}

function buildFrontMatter(fields) {
  const lines = ['---']
  for (const key of Object.keys(fields || {})) {
    const value = fields[key]
    if (value == null) continue
    if (Array.isArray(value)) {
      if (!value.length) continue
      lines.push(key + ':')
      for (const item of value) {
        lines.push('  - ' + yamlScalar(item))
      }
      continue
    }
    lines.push(key + ': ' + yamlScalar(value))
  }
  lines.push('---', '')
  return lines.join('\n')
}

function escapeRegExp(text) {
  return String(text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function splitFrontMatterText(src) {
  const original = normalizeLineBreaks(String(src ?? ''))
  if (!original) {
    return { frontMatter: null, body: '', hasBom: false }
  }

  let text = original
  let hasBom = false
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1)
    hasBom = true
  }

  const lines = text.split('\n')
  if (!lines.length || lines[0].trim() !== '---') {
    return { frontMatter: null, body: text, hasBom }
  }

  let endIndex = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      endIndex = i
      break
    }
  }

  if (endIndex === -1) {
    return { frontMatter: null, body: text, hasBom }
  }

  return {
    frontMatter: lines.slice(0, endIndex + 1).join('\n'),
    body: lines.slice(endIndex + 1).join('\n'),
    hasBom
  }
}

function buildYamlFieldLines(key, value) {
  if (value == null) return []
  if (Array.isArray(value)) {
    if (!value.length) return []
    return [key + ':', ...value.map((item) => '  - ' + yamlScalar(item))]
  }
  return [key + ': ' + yamlScalar(value)]
}

function upsertYamlTopLevelField(inner, key, value) {
  const raw = normalizeLineBreaks(String(inner ?? ''))
  const lines = raw ? raw.split('\n') : []
  const fieldRe = new RegExp('^' + escapeRegExp(String(key)) + '\\s*:')
  const nextFieldRe = /^[A-Za-z0-9_-]+\s*:/
  const replacement = buildYamlFieldLines(key, value)
  let start = -1
  let end = -1

  for (let i = 0; i < lines.length; i += 1) {
    if (!fieldRe.test(lines[i])) continue
    start = i
    end = i + 1
    while (end < lines.length && !nextFieldRe.test(lines[end])) {
      end += 1
    }
    break
  }

  if (start >= 0) {
    lines.splice(start, Math.max(1, end - start), ...replacement)
  } else {
    while (lines.length && !lines[lines.length - 1].trim()) {
      lines.pop()
    }
    if (lines.length && replacement.length) lines.push('')
    lines.push(...replacement)
  }

  while (lines.length && !lines[lines.length - 1].trim()) {
    lines.pop()
  }
  return lines.join('\n')
}

function mergeFrontMatterFieldsIntoSource(src, fields) {
  const split = splitFrontMatterText(src)
  let inner = ''
  if (split.frontMatter) {
    inner = String(split.frontMatter)
      .replace(/^\uFEFF?---\s*\n?/, '')
      .replace(/\n---\s*$/, '')
  }

  for (const key of Object.keys(fields || {})) {
    inner = upsertYamlTopLevelField(inner, key, fields[key])
  }

  const frontMatter = buildFrontMatter(
    Object.keys(fields || {}).reduce((acc, key) => {
      acc[key] = fields[key]
      return acc
    }, {})
  )

  const finalFrontMatter = inner.trim()
    ? '---\n' + inner.trimEnd() + '\n---\n\n'
    : frontMatter
  const body = normalizeLineBreaks(split.body || '')
  const merged = finalFrontMatter + body
  return (split.hasBom ? '\uFEFF' : '') + merged
}

function getBlinkoBase(settings) {
  return String(settings && settings.apiBase ? settings.apiBase : DEFAULT_API_BASE)
    .trim()
    .replace(/\/+$/, '')
}

function buildBlinkoUrl(settings, path) {
  const suffix = String(path || '').trim()
  return getBlinkoBase(settings) + (suffix.startsWith('/') ? suffix : '/' + suffix)
}

function buildQueryString(query) {
  const parts = []
  for (const key of Object.keys(query || {})) {
    const value = query[key]
    if (value == null || value === '') continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item == null || item === '') continue
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(item)))
      }
      continue
    }
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
  }
  return parts.join('&')
}

function appendQueryToPath(path, query) {
  const qs = buildQueryString(query)
  if (!qs) return path
  return String(path || '') + (String(path || '').includes('?') ? '&' : '?') + qs
}

function getFetchLike(context) {
  try {
    if (context && context.http && typeof context.http.fetch === 'function') {
      return context.http.fetch.bind(context.http)
    }
  } catch {}
  try {
    if (typeof globalThis.fetch === 'function') {
      return globalThis.fetch.bind(globalThis)
    }
  } catch {}
  return null
}

function isResponseOk(res) {
  try {
    if (res && res.ok === true) return true
    const status = typeof res.status === 'number' ? res.status : 0
    return status >= 200 && status < 300
  } catch {
    return false
  }
}

function getResponseStatus(res) {
  try {
    return typeof res.status === 'number' ? res.status : 0
  } catch {
    return 0
  }
}

function stringifyShort(value) {
  try {
    const text = JSON.stringify(value)
    return text.length > 240 ? text.slice(0, 240) + '...' : text
  } catch {
    return String(value)
  }
}

async function readResponsePayload(res) {
  try {
    if (res && res.data !== undefined && !(res.data instanceof Uint8Array)) {
      const data = res.data
      if (typeof data === 'string') {
        const trimmed = data.trim()
        if (!trimmed) return ''
        try {
          return JSON.parse(trimmed)
        } catch {
          return data
        }
      }
      return data
    }
  } catch {}

  try {
    if (res && typeof res.text === 'function') {
      const text = await res.text()
      const trimmed = String(text || '').trim()
      if (!trimmed) return ''
      try {
        return JSON.parse(trimmed)
      } catch {
        return text
      }
    }
  } catch {}

  try {
    if (res && typeof res.json === 'function') {
      return await res.json()
    }
  } catch {}

  return null
}

function formatBlinkoError(status, payload) {
  if (payload && typeof payload === 'object') {
    const issues = Array.isArray(payload.issues)
      ? payload.issues.map((item) => String(item && item.message ? item.message : '')).filter(Boolean)
      : []
    const msg =
      payload.message ||
      payload.error ||
      (issues.length ? issues[0] : '') ||
      stringifyShort(payload)
    return `Blinko 请求失败（HTTP ${status || '未知'}）：${msg}`
  }
  if (typeof payload === 'string' && payload.trim()) {
    return `Blinko 请求失败（HTTP ${status || '未知'}）：${payload.trim()}`
  }
  return `Blinko 请求失败（HTTP ${status || '未知'}）`
}

async function blinkoRequest(context, settings, path, opt) {
  const requiresAuth = !opt || opt.requiresAuth !== false
  const token = String(settings && settings.apiToken ? settings.apiToken : '').trim()
  const base = getBlinkoBase(settings)
  if (!base) throw new Error('Blinko API 地址未配置')
  if (requiresAuth && !token) throw new Error('Blinko API Token 未配置')

  const headers = Object.assign({}, (opt && opt.headers) || {})
  if (requiresAuth && token) headers.Authorization = 'Bearer ' + token

  const init = {
    method: (opt && opt.method) || 'GET',
    headers
  }

  if (opt && Object.prototype.hasOwnProperty.call(opt, 'json')) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(opt.json ?? {})
  } else if (opt && Object.prototype.hasOwnProperty.call(opt, 'body')) {
    init.body = opt.body
  }

  const fetchLike = getFetchLike(context)
  if (!fetchLike) throw new Error('HTTP 功能不可用')

  const finalPath = appendQueryToPath(path, opt && opt.query)
  const res = await fetchLike(buildBlinkoUrl(settings, finalPath), init)
  const payload = await readResponsePayload(res)
  if (!isResponseOk(res)) {
    throw new Error(formatBlinkoError(getResponseStatus(res), payload))
  }
  return payload
}

function getTagCacheKey(settings) {
  return getBlinkoBase(settings) + '::' + String(settings && settings.apiToken ? settings.apiToken : '').trim()
}

async function fetchBlinkoTags(context, settings, opt) {
  const force = !!(opt && opt.force)
  const cacheKey = getTagCacheKey(settings)
  if (
    !force &&
    tagCache.key === cacheKey &&
    Array.isArray(tagCache.tags) &&
    Date.now() - tagCache.at < 60 * 1000
  ) {
    return tagCache.tags.slice()
  }

  const data = await blinkoRequest(context, settings, '/v1/tags/list', {
    method: 'GET'
  })
  const tags = extractBlinkoCollection(data)
  tagCache = {
    key: cacheKey,
    at: Date.now(),
    tags
  }
  return tags.slice()
}

async function resolveDefaultTagFilter(context, settings) {
  const tagName = String(settings && settings.defaultTag ? settings.defaultTag : '').trim()
  if (!tagName) {
    return { tagId: null, warning: '' }
  }
  const tags = await fetchBlinkoTags(context, settings)
  const found = tags.find((tag) => {
    const name = String(tag && tag.name ? tag.name : '').trim()
    return name && name.toLowerCase() === tagName.toLowerCase()
  })
  if (found) {
    const id = maybeFiniteNumber(found.id)
    if (id != null) return { tagId: id, warning: '' }
  }
  return {
    tagId: null,
    warning: `未找到默认远端标签「${tagName}」，已回退为全部文章列表`
  }
}

async function listBlinkoNotes(context, settings, opt) {
  const page = clampInt(opt && opt.page, 1, 999999, 1)
  const size = clampInt(
    opt && opt.size,
    1,
    MAX_PAGE_SIZE,
    clampInt(settings && settings.pullPageSize, 1, MAX_PAGE_SIZE, 20)
  )
  const searchText = String((opt && opt.searchText) || '').trim()
  const view = normalizeSyncView(opt && Object.prototype.hasOwnProperty.call(opt, 'view') ? opt.view : 'active')
  const hasTodo = !!(opt && opt.hasTodo)
  const payload = {
    page,
    size,
    orderBy: 'desc',
    type: -1,
    searchText
  }
  if (hasTodo) payload.hasTodo = true
  if (view === 'archived') {
    payload.isArchived = true
    payload.isRecycle = false
  } else if (view === 'recycle') {
    payload.isRecycle = true
  } else if (view === 'all') {
    payload.isArchived = null
    payload.isRecycle = false
  } else {
    payload.isArchived = false
    payload.isRecycle = false
  }
  const data = await blinkoRequest(context, settings, '/v1/note/list', {
    method: 'POST',
    json: payload
  })
  return {
    notes: extractBlinkoCollection(data),
    warning: ''
  }
}

async function getBlinkoNoteDetail(context, settings, id) {
  const data = await blinkoRequest(context, settings, '/v1/note/detail', {
    method: 'POST',
    json: { id: Number(id) }
  })
  return extractBlinkoNoteEntity(data)
}

async function sendBlinkoPayload(context, settings, payload) {
  return await blinkoRequest(context, settings, '/v1/note/upsert', {
    method: 'POST',
    json: payload
  })
}

async function batchUpdateBlinkoNotes(context, settings, payload) {
  return await blinkoRequest(context, settings, '/v1/note/batch-update', {
    method: 'POST',
    json: payload
  })
}

async function batchTrashBlinkoNotes(context, settings, ids) {
  return await blinkoRequest(context, settings, '/v1/note/batch-trash', {
    method: 'POST',
    json: { ids }
  })
}

async function batchDeleteBlinkoNotes(context, settings, ids) {
  return await blinkoRequest(context, settings, '/v1/note/batch-delete', {
    method: 'POST',
    json: { ids }
  })
}

async function updateBlinkoAttachmentsOrder(context, settings, attachments) {
  return await blinkoRequest(context, settings, '/v1/note/update-attachments-order', {
    method: 'POST',
    json: { attachments }
  })
}

async function listBlinkoRelatedNotes(context, settings, id) {
  const data = await blinkoRequest(context, settings, '/v1/note/related-notes', {
    method: 'GET',
    query: { id: Number(id) }
  })
  return extractBlinkoCollection(data)
}

async function listBlinkoReferenceNotes(context, settings, noteId, type) {
  const data = await blinkoRequest(context, settings, '/v1/note/reference-list', {
    method: 'POST',
    json: {
      noteId: Number(noteId),
      type: type === 'referencedBy' ? 'referencedBy' : 'references'
    }
  })
  return extractBlinkoCollection(data)
}

async function addBlinkoReference(context, settings, fromNoteId, toNoteId) {
  return await blinkoRequest(context, settings, '/v1/note/add-reference', {
    method: 'POST',
    json: {
      fromNoteId: Number(fromNoteId),
      toNoteId: Number(toNoteId)
    }
  })
}

async function listBlinkoTasks(context, settings) {
  const data = await blinkoRequest(context, settings, '/v1/tasks/list', {
    method: 'GET'
  })
  return extractBlinkoCollection(data)
}

async function upsertBlinkoTask(context, settings, payload) {
  return await blinkoRequest(context, settings, '/v1/tasks/upsert', {
    method: 'GET',
    query: payload
  })
}

function extractRemoteImageUrls(markdown) {
  const urls = []
  const text = normalizeLineBreaks(markdown)
  const re = /!\[[^\]]*]\(([^)\n]+)\)/g
  let match = null
  while ((match = re.exec(text))) {
    let url = String(match[1] || '').trim()
    if (!url) continue
    if (url.startsWith('<') && url.endsWith('>')) {
      url = url.slice(1, -1).trim()
    }
    const titleIndex = url.indexOf(' ')
    if (titleIndex > 0) {
      url = url.slice(0, titleIndex).trim()
    }
    if (/^https?:\/\//i.test(url)) {
      urls.push(url)
    }
  }
  return dedupeStrings(urls)
}

function inferAttachmentType(name) {
  const lower = String(name || '').toLowerCase()
  if (/\.(png|jpg|jpeg|gif|webp|bmp|svg|avif)$/.test(lower)) return 'image'
  if (/\.(mp4|mov|avi|mkv|webm)$/.test(lower)) return 'video'
  if (/\.(mp3|wav|ogg|m4a|flac)$/.test(lower)) return 'audio'
  return 'file'
}

function normalizeUploadedAttachment(data, originalUrl) {
  if (!data || typeof data !== 'object') return null
  const path = String(data.path || '').trim()
  if (!path) return null
  const name =
    String(data.name || '').trim() ||
    basenameFs(path) ||
    basenameFs(originalUrl.split(/[?#]/)[0]) ||
    'attachment'
  const sizeValue = data.size
  const size =
    typeof sizeValue === 'number'
      ? sizeValue
      : String(sizeValue || '').trim() || 0
  const type = String(data.type || '').trim() || inferAttachmentType(name)
  return { name, path, size, type }
}

async function uploadRemoteImagesToBlinko(context, settings, content) {
  const urls = extractRemoteImageUrls(content)
  if (!urls.length) {
    return { attachments: [], failures: [] }
  }
  const attachments = []
  const failures = []
  for (const url of urls) {
    try {
      const data = await blinkoRequest(context, settings, '/api/file/upload-by-url', {
        method: 'POST',
        json: { url }
      })
      const attachment = normalizeUploadedAttachment(data, url)
      if (attachment) {
        attachments.push(attachment)
      } else {
        failures.push(url)
      }
    } catch {
      failures.push(url)
    }
  }
  return { attachments, failures }
}

function resolveBlinkoNoteTitle(note) {
  const meta = note && note.metadata && typeof note.metadata === 'object' ? note.metadata : {}
  return buildNoteTitle(meta, note && typeof note.content === 'string' ? note.content : '')
}

function extractBlinkoNoteTagNames(note) {
  if (Array.isArray(note && note.tags)) {
    return dedupeStrings(
      note.tags
        .map((item) => {
          if (item && item.tag && typeof item.tag.name === 'string') return item.tag.name
          if (item && typeof item.name === 'string') return item.name
          return ''
        })
        .filter(Boolean)
    )
  }
  const meta = note && note.metadata && typeof note.metadata === 'object' ? note.metadata : {}
  return normalizeTags(meta.tags)
}

function noteToMarkdown(note) {
  const tags = extractBlinkoNoteTagNames(note)
  const attachmentCount =
    Array.isArray(note && note.attachments) && note.attachments.length
      ? note.attachments.length
      : null
  const fields = {
    title: resolveBlinkoNoteTitle(note),
    source: 'blinko',
    blinkoId: maybeFiniteNumber(note && note.id),
    blinkoType: maybeFiniteNumber(note && note.type),
    blinkoCreatedAt: note && note.createdAt ? String(note.createdAt) : null,
    blinkoUpdatedAt: note && note.updatedAt ? String(note.updatedAt) : null,
    tags: tags.length ? tags : null,
    blinkoAttachmentCount: attachmentCount
  }
  const body = normalizeLineBreaks(note && typeof note.content === 'string' ? note.content : '')
  return buildFrontMatter(fields) + body + (body.endsWith('\n') ? '' : '\n')
}

function normalizeBlinkoAttachmentForUpsert(item) {
  if (!item || typeof item !== 'object') return null
  const name = String(item.name || '').trim()
  const path = String(item.path || '').trim()
  if (!name || !path) return null
  return {
    name,
    path,
    size:
      typeof item.size === 'number'
        ? item.size
        : String(item.size || '').trim() || 0,
    type: String(item.type || '').trim() || inferAttachmentType(name)
  }
}

function normalizeBlinkoAttachmentsForUpsert(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => normalizeBlinkoAttachmentForUpsert(item))
    .filter(Boolean)
}

function extractBlinkoReferenceIds(note) {
  const refs = []
  if (Array.isArray(note && note.references)) {
    for (const item of note.references) {
      const id = maybeFiniteNumber(item && item.toNoteId)
      if (id != null && id > 0) refs.push(id)
    }
  }
  return refs
}

function buildBlinkoUpsertPayloadFromNote(note, patch) {
  const metaType = extractBlinkoTypeFromMeta(note && note.metadata)
  const noteType = maybeFiniteNumber(note && note.type)
  const payload = {
    id: maybeFiniteNumber(note && note.id),
    content: normalizeLineBreaks(note && typeof note.content === 'string' ? note.content : ''),
    type: metaType === -1 || metaType === 0 || metaType === 1 || metaType === 2
      ? metaType
      : noteType != null
        ? noteType
        : 0,
    attachments: normalizeBlinkoAttachmentsForUpsert(note && note.attachments),
    isArchived: !!(note && note.isArchived),
    isTop: !!(note && note.isTop),
    isShare: !!(note && note.isShare),
    isRecycle: !!(note && note.isRecycle),
    metadata:
      note && note.metadata && typeof note.metadata === 'object'
        ? Object.assign({}, note.metadata)
        : {
            title: resolveBlinkoNoteTitle(note),
            tags: extractBlinkoNoteTagNames(note)
          }
  }
  if (note && note.createdAt) payload.createdAt = String(note.createdAt)
  if (note && note.updatedAt) payload.updatedAt = String(note.updatedAt)
  const references = extractBlinkoReferenceIds(note)
  if (references.length) payload.references = references
  return Object.assign(payload, patch || {})
}

function normalizeComparableContent(text) {
  return normalizeLineBreaks(String(text ?? '')).trim()
}

function extractBlinkoIdFromSendResponse(data) {
  const direct = [
    maybeFiniteNumber(data),
    maybeFiniteNumber(data && data.id),
    maybeFiniteNumber(data && data.noteId),
    maybeFiniteNumber(data && data.note_id),
    maybeFiniteNumber(data && data.data && data.data.id),
    maybeFiniteNumber(data && data.data && data.data.noteId),
    maybeFiniteNumber(data && data.note && data.note.id),
    maybeFiniteNumber(data && data.result && data.result.id)
  ]
  for (const id of direct) {
    if (id != null && id > 0) return id
  }
  return null
}

async function findBlinkoNoteIdByPayload(context, settings, payload) {
  const title =
    payload &&
    payload.metadata &&
    typeof payload.metadata === 'object' &&
    payload.metadata.title
      ? String(payload.metadata.title).trim()
      : ''
  const searchText = title || plainTextSnippet(payload && payload.content ? payload.content : '', 48)
  if (!searchText) return null

  const result = await listBlinkoNotes(context, settings, {
    page: 1,
    size: Math.min(10, clampInt(settings && settings.pullPageSize, 1, MAX_PAGE_SIZE, 20)),
    searchText
  })
  const candidates = Array.isArray(result.notes) ? result.notes : []
  const expected = normalizeComparableContent(payload && payload.content)
  for (const note of candidates) {
    const briefContent = normalizeComparableContent(note && note.content)
    if (briefContent && briefContent === expected) {
      const id = maybeFiniteNumber(note && note.id)
      if (id != null && id > 0) return id
    }
  }

  for (const note of candidates.slice(0, 3)) {
    try {
      const full = await fetchFullBlinkoNote(context, settings, note)
      if (normalizeComparableContent(full && full.content) === expected) {
        const id = maybeFiniteNumber(full && full.id)
        if (id != null && id > 0) return id
      }
    } catch {}
  }

  return null
}

async function resolveBlinkoIdAfterSend(context, settings, payload, response) {
  const fromPayload = maybeFiniteNumber(payload && payload.id)
  if (fromPayload != null && fromPayload > 0) return fromPayload
  const fromResponse = extractBlinkoIdFromSendResponse(response)
  if (fromResponse != null && fromResponse > 0) return fromResponse
  return await findBlinkoNoteIdByPayload(context, settings, payload)
}

function getCurrentEditorSource(context) {
  try {
    if (context && typeof context.getEditorValue === 'function') {
      return String(context.getEditorValue() || '')
    }
  } catch {}
  return ''
}

async function writeBlinkoMetaBackToCurrentDocument(context, fields) {
  if (!context || typeof context.setEditorValue !== 'function') return false
  const current = getCurrentEditorSource(context)
  const next = mergeFrontMatterFieldsIntoSource(current, fields)
  if (next === current) return false
  context.setEditorValue(next)
  return true
}

async function getLibraryRootRequired(context) {
  if (!context || typeof context.getLibraryRoot !== 'function') {
    throw new Error('宿主版本过老：缺少 getLibraryRoot')
  }
  const root = await context.getLibraryRoot()
  if (!root) {
    throw new Error('当前未打开任何库，无法创建本地 blinko 文件夹')
  }
  return String(root).replace(/[\\/]+$/, '')
}

async function ensureLocalBlinkoFolder(context, settings) {
  const root = await getLibraryRootRequired(context)
  const rel = normalizeLocalFolderPath(settings && settings.localFolder)
  const full = joinFsPath(root, rel.replace(/\//g, root.includes('\\') ? '\\' : '/'))
  if (typeof context.ensureDir === 'function') {
    const ok = await context.ensureDir(full)
    if (ok === false) {
      throw new Error('创建本地 blinko 文件夹失败：' + full)
    }
  } else if (typeof context.exists === 'function') {
    const ok = await context.exists(full)
    if (!ok) {
      throw new Error('宿主版本过老：缺少 ensureDir，无法自动创建目录')
    }
  }
  return full
}

function buildLocalNoteFileName(note) {
  const title = sanitizeFileName(resolveBlinkoNoteTitle(note))
  const id = Number(note && note.id)
  return `${title}__blinko_${id}.md`
}

function getLocalNoteIdFromRelative(relative) {
  const match = String(relative || '').match(LOCAL_FILE_SUFFIX_RE)
  return match ? match[1] : ''
}

async function buildLocalNoteIndex(context, settings) {
  const map = {}
  if (!context || typeof context.listLibraryFiles !== 'function') return map
  const relDir = normalizeLocalFolderPath(settings && settings.localFolder).replace(/\\/g, '/')
  try {
    const files = await context.listLibraryFiles({
      extensions: ['md', 'markdown', 'txt'],
      includeDirs: [relDir + '/'],
      maxDepth: 12
    })
    for (const file of Array.isArray(files) ? files : []) {
      const id = getLocalNoteIdFromRelative(file && file.relative)
      if (id) map[id] = file.path
    }
  } catch {}
  return map
}

async function resolveLocalNotePath(context, settings, note, localIndex, folderPath) {
  const noteId = String(note && note.id ? note.id : '')
  if (localIndex && noteId && localIndex[noteId]) {
    return localIndex[noteId]
  }
  const dir = folderPath || (await ensureLocalBlinkoFolder(context, settings))
  return joinFsPath(dir, buildLocalNoteFileName(note))
}

async function saveBlinkoNoteToLibrary(context, settings, note, opt) {
  if (!context || typeof context.writeTextFile !== 'function') {
    throw new Error('宿主版本过老：缺少 writeTextFile')
  }

  const localIndex = opt && opt.localIndex ? opt.localIndex : null
  const folderPath = opt && opt.folderPath ? opt.folderPath : null
  const fullPath = await resolveLocalNotePath(context, settings, note, localIndex, folderPath)
  const parent = dirnameFs(fullPath)
  if (parent && typeof context.ensureDir === 'function') {
    const ok = await context.ensureDir(parent)
    if (ok === false) throw new Error('无法创建目录：' + parent)
  }
  await context.writeTextFile(fullPath, noteToMarkdown(note))
  if (localIndex) {
    localIndex[String(note.id)] = fullPath
  }
  if (opt && opt.openAfterSave && typeof context.openFileByPath === 'function') {
    await context.openFileByPath(fullPath)
  }
  return fullPath
}

async function fetchFullBlinkoNote(context, settings, noteOrId) {
  const id =
    typeof noteOrId === 'number'
      ? noteOrId
      : maybeFiniteNumber(noteOrId && noteOrId.id)
  if (id == null || id <= 0) {
    throw new Error('缺少有效的 Blinko 文章 ID')
  }
  const full = await getBlinkoNoteDetail(context, settings, id)
  if (!full || typeof full !== 'object') {
    throw new Error('Blinko 文章不存在或已被删除')
  }
  return full
}

async function buildBlinkoNotePayload(context, ctx, settings, opt) {
  const meta = getDocMetaSafe(context)
  const body = normalizeLineBreaks(getDocBodyText(context))
  const selected = ctx && typeof ctx.selectedText === 'string' ? normalizeLineBreaks(ctx.selectedText) : ''
  const forceSelection = !!(opt && opt.forceSelection)
  const preferSelection = !opt || opt.preferSelection !== false
  const useSelection = forceSelection ? true : !!(preferSelection && selected.trim())
  const content = useSelection ? selected : body

  if (!content.trim()) {
    throw new Error(useSelection ? '选中文本为空' : '编辑器内容为空')
  }

  const title = buildNoteTitle(meta, useSelection ? content : body || content)
  const tags = dedupeStrings([
    ...extractDocTags(meta),
    settings && settings.defaultTag ? settings.defaultTag : ''
  ])

  const payload = {
    content,
    type: extractBlinkoTypeFromMeta(meta),
    metadata: {
      title,
      tags
    }
  }

  if (!useSelection) {
    const blinkoId = extractBlinkoIdFromMeta(meta)
    if (blinkoId != null && blinkoId > 0) {
      payload.id = blinkoId
    }
  }

  let attachmentFailures = []
  if (settings && settings.uploadRemoteImages) {
    const uploaded = await uploadRemoteImagesToBlinko(context, settings, content)
    if (uploaded.attachments.length) {
      payload.attachments = uploaded.attachments
    }
    attachmentFailures = uploaded.failures
  }

  return { payload, attachmentFailures, useSelection, title }
}

async function sendCurrentDocumentToBlinko(context, ctx, opt) {
  const settings = await loadSettings(context)
  const built = await buildBlinkoNotePayload(context, ctx, settings, opt)
  const response = await sendBlinkoPayload(context, settings, built.payload)
  let wroteBlinkoMeta = false
  let resolvedId = null

  if (!built.useSelection) {
    resolvedId = await resolveBlinkoIdAfterSend(context, settings, built.payload, response)
    if (resolvedId != null && resolvedId > 0) {
      wroteBlinkoMeta = await writeBlinkoMetaBackToCurrentDocument(context, {
        source: 'blinko',
        blinkoId: resolvedId,
        blinkoType: built.payload.type
      })
    }
  }

  let msg = built.payload.id ? '已更新到 Blinko' : '已发送到 Blinko'
  if (wroteBlinkoMeta && resolvedId != null) {
    msg += `，已回写 blinkoId=${resolvedId}`
  } else if (!built.useSelection && !built.payload.id && resolvedId == null) {
    msg += '，但未能自动识别新建文章 ID'
  }
  if (built.payload.attachments && built.payload.attachments.length) {
    msg += `，附带 ${built.payload.attachments.length} 个远程图片附件`
  }
  if (built.attachmentFailures.length) {
    msg += `，${built.attachmentFailures.length} 个图片附件上传失败`
  }
  const level =
    built.attachmentFailures.length || (!built.useSelection && !built.payload.id && resolvedId == null)
      ? 'warn'
      : 'ok'
  safeNotice(context, msg, level, 3200)
  return Object.assign({}, built, { response, resolvedId, wroteBlinkoMeta })
}

async function applyBlinkoNoteToEditor(context, note) {
  if (!context || typeof context.setEditorValue !== 'function') {
    throw new Error('宿主版本过老：缺少 setEditorValue')
  }

  const current = context.getEditorValue ? String(context.getEditorValue() || '') : ''
  if (current.trim()) {
    const ok = await safeConfirm(
      context,
      '当前文档已有内容，写入 Blinko 文章会覆盖当前编辑器内容，是否继续？'
    )
    if (!ok) return false
  }

  context.setEditorValue(noteToMarkdown(note))
  safeNotice(context, '已写入当前文档', 'ok', 2200)
  return true
}

async function syncBlinkoNoteToLibrary(context, settings, noteOrId, opt) {
  const full = await fetchFullBlinkoNote(context, settings, noteOrId)
  return await saveBlinkoNoteToLibrary(context, settings, full, opt)
}

async function pullLatestNotesToLocalFolder(context) {
  const settings = await loadSettings(context)
  const result = await listBlinkoNotes(context, settings, {
    page: 1,
    size: settings.pullPageSize
  })
  const notes = result.notes
  if (!notes.length) {
    safeNotice(context, 'Blinko 没有可拉取的文章', 'warn', 2600)
    if (result.warning) safeNotice(context, result.warning, 'warn', 3200)
    return { count: 0, fail: 0, warning: result.warning }
  }

  const folderPath = await ensureLocalBlinkoFolder(context, settings)
  const localIndex = await buildLocalNoteIndex(context, settings)
  let success = 0
  let fail = 0
  let firstSaved = ''

  for (const note of notes) {
    try {
      const full = await fetchFullBlinkoNote(context, settings, note)
      const saved = await saveBlinkoNoteToLibrary(context, settings, full, {
        localIndex,
        folderPath,
        openAfterSave: false
      })
      if (!firstSaved) firstSaved = saved
      success += 1
    } catch {
      fail += 1
    }
  }

  if (settings.openAfterPull && firstSaved && typeof context.openFileByPath === 'function') {
    try {
      await context.openFileByPath(firstSaved)
    } catch {}
  }

  let msg = `已拉取 ${success} 篇文章到 ${normalizeLocalFolderPath(settings.localFolder)}`
  if (fail) msg += `，失败 ${fail} 篇`
  safeNotice(context, msg, fail ? 'warn' : 'ok', 3200)
  if (result.warning) safeNotice(context, result.warning, 'warn', 3200)
  return { count: success, fail, warning: result.warning, localIndex }
}

async function testBlinkoConnection(context, settings) {
  const normalized = normalizeSettings(settings)
  if (!normalized.apiToken) {
    throw new Error('测试连接前请先填写 Blinko Token')
  }
  const tags = await fetchBlinkoTags(context, normalized, { force: true })
  let warning = ''
  if (normalized.defaultTag) {
    const found = tags.find((tag) => {
      const name = String(tag && tag.name ? tag.name : '').trim()
      return name && name.toLowerCase() === normalized.defaultTag.toLowerCase()
    })
    if (!found) {
      warning = `默认远端标签「${normalized.defaultTag}」当前不存在`
    }
  }
  return { tags, warning }
}

function createSyncState() {
  return {
    page: 1,
    view: 'all',
    searchText: '',
    loading: false,
    notes: [],
    error: '',
    warning: '',
    status: '',
    lastLoadedAt: '',
    localIndex: {},
    settings: createDefaultSettings(),
    requestId: 0,
    selectedIds: {}
  }
}

function createNoteWorkbenchState() {
  return {
    loading: false,
    error: '',
    note: null,
    relatedNotes: [],
    references: [],
    referencedBy: [],
    attachmentDraft: [],
    localIndex: {},
    settings: createDefaultSettings(),
    requestId: 0
  }
}

function createTasksState() {
  return {
    loading: false,
    error: '',
    tasks: [],
    settings: createDefaultSettings(),
    lastLoadedAt: '',
    requestId: 0
  }
}

function normalizeSyncView(view) {
  const value = String(view || '').trim().toLowerCase()
  if (value === 'archived' || value === 'recycle' || value === 'all') return value
  return 'active'
}

function getSyncViewLabel(view) {
  const value = normalizeSyncView(view)
  if (value === 'archived') return '归档'
  if (value === 'recycle') return '回收站'
  if (value === 'all') return '活跃+归档'
  return '活跃'
}

function getSelectedSyncNoteIds(state) {
  const ids = []
  const map = state && state.selectedIds && typeof state.selectedIds === 'object' ? state.selectedIds : {}
  for (const key of Object.keys(map)) {
    if (!map[key]) continue
    const id = maybeFiniteNumber(key)
    if (id != null && id > 0) ids.push(id)
  }
  return ids
}

function isSyncNoteSelected(state, id) {
  const noteId = String(id || '')
  return !!(state && state.selectedIds && state.selectedIds[noteId])
}

function setSyncNoteSelected(state, id, selected) {
  if (!state || !id) return
  if (!state.selectedIds || typeof state.selectedIds !== 'object') {
    state.selectedIds = {}
  }
  const key = String(id)
  if (selected) state.selectedIds[key] = true
  else delete state.selectedIds[key]
}

function syncSelectionWithVisibleNotes(state) {
  if (!state || !state.selectedIds || typeof state.selectedIds !== 'object') return
}

function moveArrayItem(list, fromIndex, toIndex) {
  const arr = Array.isArray(list) ? list.slice() : []
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= arr.length ||
    toIndex >= arr.length ||
    fromIndex === toIndex
  ) {
    return arr
  }
  const [item] = arr.splice(fromIndex, 1)
  arr.splice(toIndex, 0, item)
  return arr
}

function buildStatusBadges(note, localPath) {
  const badges = []
  if (note && note.isTop) badges.push('<span class="blinko-snap-badge top">置顶</span>')
  if (note && note.isArchived) badges.push('<span class="blinko-snap-badge archived">已归档</span>')
  if (note && note.isRecycle) badges.push('<span class="blinko-snap-badge recycle">回收站</span>')
  if (localPath) badges.push('<span class="blinko-snap-badge local">已同步本地</span>')
  return badges.join('')
}

function buildRelatedNoteActions(noteId) {
  return `
    <div class="blinko-snap-mini-actions">
      <button type="button" class="blinko-snap-btn" data-action="open-workbench-note" data-target-note-id="${escapeHtml(noteId)}">管理</button>
      <button type="button" class="blinko-snap-btn" data-action="apply-related-note" data-target-note-id="${escapeHtml(noteId)}">写入</button>
      <button type="button" class="blinko-snap-btn" data-action="save-related-note" data-target-note-id="${escapeHtml(noteId)}">保存</button>
    </div>
  `
}

function buildRelationListHtml(title, notes, emptyText) {
  const items = Array.isArray(notes) ? notes : []
  const body = items.length
    ? items
        .map((note) => {
          const noteId = maybeFiniteNumber(note && note.id)
          const meta = [
            noteId != null ? '#' + noteId : '',
            note && note.updatedAt ? '更新于 ' + formatDateTime(note.updatedAt) : ''
          ].filter(Boolean)
          return `
            <div class="blinko-snap-relation-item">
              <div class="blinko-snap-relation-head">
                <div class="blinko-snap-relation-title">${escapeHtml(resolveBlinkoNoteTitle(note))}</div>
                <div class="blinko-snap-relation-meta">${meta.map((bit) => `<span>${escapeHtml(bit)}</span>`).join('')}</div>
              </div>
              <div class="blinko-snap-relation-snippet">${escapeHtml(plainTextSnippet(note && note.content ? note.content : '', 120) || '没有可预览正文')}</div>
              ${noteId != null ? buildRelatedNoteActions(noteId) : ''}
            </div>
          `
        })
        .join('')
    : `<div class="blinko-snap-empty">${escapeHtml(emptyText)}</div>`

  return `
    <section class="blinko-snap-section">
      <div class="blinko-snap-section-title">${escapeHtml(title)}</div>
      <div class="blinko-snap-relation-list">${body}</div>
    </section>
  `
}

function buildTaskChecklistMarkdown(tasks) {
  const lines = [
    TASK_SECTION_START,
    '# Blinko 任务清单',
    ''
  ]
  const items = Array.isArray(tasks) ? tasks : []
  if (!items.length) {
    lines.push('- [ ] 当前没有可用的 Blinko 任务')
  } else {
    for (const task of items) {
      const name = String(task && task.name ? task.name : '未命名任务')
      const done = !!(task && task.isSuccess) && !task.isRunning
      const status = task && task.isRunning
        ? '运行中'
        : task && task.isSuccess
          ? '最近执行成功'
          : '最近执行失败'
      const bits = [
        `状态：${status}`,
        task && task.schedule ? `计划：${String(task.schedule)}` : '',
        task && task.lastRun ? `上次：${formatDateTime(task.lastRun)}` : ''
      ].filter(Boolean)
      lines.push(`- [${done ? 'x' : ' '}] ${name} | ${bits.join(' | ')}`)
    }
  }
  lines.push('', TASK_SECTION_END, '')
  return lines.join('\n')
}

function mergeBlinkoTaskSection(src, section) {
  const source = normalizeLineBreaks(String(src ?? ''))
  const start = source.indexOf(TASK_SECTION_START)
  const end = source.indexOf(TASK_SECTION_END)
  if (start >= 0 && end > start) {
    const before = source.slice(0, start).replace(/\s*$/, '')
    const after = source.slice(end + TASK_SECTION_END.length).replace(/^\s*/, '')
    return [before, section.trim(), after].filter(Boolean).join('\n\n') + '\n'
  }
  const trimmed = source.trim()
  return (trimmed ? trimmed + '\n\n' : '') + section.trim() + '\n'
}

async function writeBlinkoTasksToCurrentDoc(context, tasks) {
  if (!context || typeof context.setEditorValue !== 'function') {
    throw new Error('宿主版本过老：缺少 setEditorValue')
  }
  const current = getCurrentEditorSource(context)
  context.setEditorValue(mergeBlinkoTaskSection(current, buildTaskChecklistMarkdown(tasks)))
}

async function saveBlinkoTasksToLibrary(context, settings, tasks, openAfterSave) {
  if (!context || typeof context.writeTextFile !== 'function') {
    throw new Error('宿主版本过老：缺少 writeTextFile')
  }
  const folderPath = await ensureLocalBlinkoFolder(context, settings)
  const filePath = joinFsPath(folderPath, 'blinko-tasks.md')
  await context.writeTextFile(filePath, buildTaskChecklistMarkdown(tasks))
  if (openAfterSave && typeof context.openFileByPath === 'function') {
    await context.openFileByPath(filePath)
  }
  return filePath
}

function extractTodoLinesFromBlinkoContent(content) {
  const lines = normalizeLineBreaks(String(content ?? '')).split('\n')
  const todos = []
  for (const line of lines) {
    const match = line.match(/^\s*[-*+]\s*\[([ xX])\]\s+(.+?)\s*$/)
    if (!match) continue
    todos.push({
      done: String(match[1]).toLowerCase() === 'x',
      text: match[2],
      raw: `- [${String(match[1]).toLowerCase() === 'x' ? 'x' : ' '}] ${match[2]}`
    })
  }
  return todos
}

function buildBlinkoTodoDigestMarkdown(notes) {
  const list = Array.isArray(notes) ? notes : []
  const todoCount = list.reduce((sum, note) => sum + extractTodoLinesFromBlinkoContent(note && note.content).length, 0)
  const doneCount = list.reduce((sum, note) => sum + extractTodoLinesFromBlinkoContent(note && note.content).filter((item) => item.done).length, 0)
  const lines = [
    '---',
    'title: "Blinko 待办汇总"',
    'source: "blinko"',
    'blinkoTodoSource: "notes"',
    `blinkoTodoCount: ${todoCount}`,
    `blinkoTodoDoneCount: ${doneCount}`,
    `blinkoTodoUpdatedAt: ${JSON.stringify(new Date().toISOString())}`,
    '---',
    '',
    '# Blinko 待办汇总',
    ''
  ]

  if (!list.length || !todoCount) {
    lines.push('- [ ] 当前没有可拉取的 Blinko 待办', '')
    return lines.join('\n')
  }

  for (const note of list) {
    const todos = extractTodoLinesFromBlinkoContent(note && note.content)
    if (!todos.length) continue
    const title = resolveBlinkoNoteTitle(note)
    lines.push(`## ${title} (#${note.id})`, '')
    for (const item of todos) {
      lines.push(item.raw)
    }
    lines.push('')
  }
  return lines.join('\n')
}

async function fetchAllBlinkoTodoNotes(context, settings) {
  const notes = []
  const pageSize = MAX_PAGE_SIZE
  for (let page = 1; page <= 50; page += 1) {
    const result = await listBlinkoNotes(context, settings, {
      page,
      size: pageSize,
      hasTodo: true
    })
    const batch = Array.isArray(result.notes) ? result.notes : []
    if (!batch.length) break
    for (const note of batch) {
      notes.push(note)
    }
    if (batch.length < pageSize) break
  }

  const fullNotes = []
  for (const note of notes) {
    try {
      const full = await fetchFullBlinkoNote(context, settings, note)
      if (extractTodoLinesFromBlinkoContent(full && full.content).length) {
        fullNotes.push(full)
      }
    } catch {}
  }
  return fullNotes
}

async function pullBlinkoTodosToLibrary(context, opt) {
  const settings = await loadSettings(context)
  if (!context || typeof context.writeTextFile !== 'function') {
    throw new Error('宿主版本过老：缺少 writeTextFile')
  }
  const notes = await fetchAllBlinkoTodoNotes(context, settings)
  const folderPath = await ensureLocalBlinkoFolder(context, settings)
  const filePath = joinFsPath(folderPath, 'blinko-todos.md')
  await context.writeTextFile(filePath, buildBlinkoTodoDigestMarkdown(notes))
  if (opt && opt.openAsSticky && typeof context.createStickyNote === 'function') {
    await context.createStickyNote(filePath)
  } else if (opt && opt.openAfterSave && typeof context.openFileByPath === 'function') {
    await context.openFileByPath(filePath)
  }
  const todoCount = notes.reduce((sum, note) => sum + extractTodoLinesFromBlinkoContent(note && note.content).length, 0)
  safeNotice(context, `已拉取 ${todoCount} 条待办到本地`, 'ok', 2800)
  return { filePath, noteCount: notes.length, todoCount }
}

function buildBlinkoLoginMarkdown(url) {
  const siteUrl = String(url || '').trim()
  if (!/^https?:\/\//i.test(siteUrl)) {
    throw new Error('请先在设置里填写完整的 Blinko 网址，例如 https://your-blinko.example.com')
  }
  return [
    '---',
    'title: "Blinko 登录门户"',
    'source: "blinko"',
    `blinkoSiteUrl: ${JSON.stringify(siteUrl)}`,
    '---',
    '',
    '**切换到阅读模式即可管理**',
    ''
  ].join('\n')
}

async function openBlinkoLoginDoc(context) {
  const settings = await loadSettings(context)
  if (!settings.siteUrl) {
    throw new Error('还没配置 Blinko 站点网址')
  }
  if (!context || typeof context.writeTextFile !== 'function') {
    throw new Error('宿主版本过老：缺少 writeTextFile')
  }
  const folderPath = await ensureLocalBlinkoFolder(context, settings)
  const filePath = joinFsPath(folderPath, 'blinko-login.md')
  await context.writeTextFile(filePath, buildBlinkoLoginMarkdown(settings.siteUrl))
  if (typeof context.openFileByPath === 'function') {
    await context.openFileByPath(filePath)
  }
  safeNotice(context, 'Blinko 登录文档已生成', 'ok', 2600)
  return filePath
}

function ensureBlinkoStyle() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.blinko-snap-overlay {
  position: fixed;
  inset: 0;
  z-index: 90010;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
  background: rgba(0, 0, 0, 0.48);
}
.blinko-snap-overlay.hidden {
  display: none;
}
.blinko-snap-dialog {
  width: min(760px, 100%);
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background:
    radial-gradient(circle at top right, rgba(255, 204, 0, 0.14), transparent 32%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0)),
    var(--flymd-bg, #171717);
  color: var(--flymd-fg, #f4f4f4);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.42);
}
.blinko-snap-sync-dialog {
  width: min(1100px, 100%);
}
.blinko-snap-dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 22px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.blinko-snap-title {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.blinko-snap-subtitle {
  margin-top: 6px;
  font-size: 13px;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.7);
}
.blinko-snap-body {
  padding: 18px 22px 20px;
  overflow: auto;
}
.blinko-snap-settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 16px;
}
.blinko-snap-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.blinko-snap-field.full {
  grid-column: 1 / -1;
}
.blinko-snap-label {
  font-size: 13px;
  font-weight: 600;
}
.blinko-snap-desc {
  font-size: 12px;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.66);
}
.blinko-snap-input,
.blinko-snap-number,
.blinko-snap-search {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 10px 12px;
  background: rgba(0, 0, 0, 0.2);
  color: inherit;
  font-size: 14px;
}
.blinko-snap-input:focus,
.blinko-snap-number:focus,
.blinko-snap-search:focus {
  outline: none;
  border-color: rgba(255, 204, 0, 0.65);
  box-shadow: 0 0 0 1px rgba(255, 204, 0, 0.18);
}
.blinko-snap-check {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
}
.blinko-snap-check input {
  margin-top: 3px;
}
.blinko-snap-tip {
  margin-top: 16px;
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(255, 204, 0, 0.09);
  color: rgba(255, 255, 255, 0.86);
  line-height: 1.6;
  font-size: 13px;
}
.blinko-snap-tip code {
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.24);
  color: #ffde59;
}
.blinko-snap-footer {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 10px;
  padding: 14px 22px 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.blinko-snap-btn {
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  padding: 9px 14px;
  background: rgba(255, 255, 255, 0.04);
  color: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: transform 0.12s ease, border-color 0.12s ease, background 0.12s ease;
}
.blinko-snap-btn:hover:not(:disabled) {
  transform: translateY(-1px);
  border-color: rgba(255, 204, 0, 0.38);
  background: rgba(255, 255, 255, 0.08);
}
.blinko-snap-btn:disabled {
  opacity: 0.56;
  cursor: default;
  transform: none;
}
.blinko-snap-btn.primary {
  border-color: rgba(255, 204, 0, 0.8);
  background: linear-gradient(180deg, #ffd54f, #ffbf00);
  color: #121212;
  font-weight: 700;
}
.blinko-snap-btn.close {
  min-width: 42px;
  padding-inline: 0;
}
.blinko-snap-sync-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) repeat(6, auto);
  gap: 10px;
  align-items: center;
  padding: 16px 22px 0;
}
.blinko-snap-toolbar-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  padding: 12px 22px 0;
}
.blinko-snap-toolbar-row.tight {
  padding-top: 10px;
}
.blinko-snap-pill {
  border-radius: 999px;
}
.blinko-snap-pill.active {
  border-color: rgba(255, 204, 0, 0.72);
  background: rgba(255, 204, 0, 0.14);
  color: #ffe07b;
}
.blinko-snap-sync-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 12px 22px 12px;
}
.blinko-snap-pagebox {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.blinko-snap-status {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
}
.blinko-snap-inline-warning {
  margin: 0 22px 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(255, 204, 0, 0.12);
  color: rgba(255, 255, 255, 0.9);
  font-size: 13px;
  line-height: 1.5;
}
.blinko-snap-sync-list {
  overflow: auto;
  padding: 0 22px 22px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.blinko-snap-empty,
.blinko-snap-error {
  padding: 16px 18px;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.04);
  line-height: 1.6;
}
.blinko-snap-error {
  border-color: rgba(255, 89, 89, 0.28);
  background: rgba(255, 89, 89, 0.09);
}
.blinko-snap-card {
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.04);
  padding: 16px 16px 14px;
}
.blinko-snap-card-topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.blinko-snap-card-check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.72);
}
.blinko-snap-card-check input {
  margin: 0;
}
.blinko-snap-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
}
.blinko-snap-card-title {
  font-size: 16px;
  font-weight: 700;
  line-height: 1.45;
}
.blinko-snap-card-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.blinko-snap-badge {
  flex: none;
  padding: 4px 9px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
}
.blinko-snap-badge.top {
  background: rgba(255, 204, 0, 0.14);
  color: #ffd75e;
}
.blinko-snap-badge.archived {
  background: rgba(65, 179, 255, 0.14);
  color: #8dcfff;
}
.blinko-snap-badge.recycle {
  background: rgba(255, 99, 71, 0.14);
  color: #ffb0a1;
}
.blinko-snap-badge.local {
  background: rgba(89, 214, 140, 0.14);
  color: #8ef0b6;
}
.blinko-snap-card-meta {
  margin-top: 8px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.65);
  display: flex;
  flex-wrap: wrap;
  gap: 8px 10px;
}
.blinko-snap-card-snippet {
  margin-top: 12px;
  font-size: 13px;
  line-height: 1.7;
  color: rgba(255, 255, 255, 0.82);
  white-space: pre-wrap;
}
.blinko-snap-card-actions {
  margin-top: 14px;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.blinko-snap-card-actions .blinko-snap-btn {
  padding: 8px 12px;
}
.blinko-snap-workbench-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(320px, 0.85fr);
  gap: 18px;
}
.blinko-snap-section {
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
  padding: 14px;
}
.blinko-snap-section-title {
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 10px;
}
.blinko-snap-workbench-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 10px;
  margin-top: 10px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
}
.blinko-snap-workbench-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
}
.blinko-snap-relation-list,
.blinko-snap-attachment-list,
.blinko-snap-task-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.blinko-snap-relation-item,
.blinko-snap-attachment-item,
.blinko-snap-task-item {
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(0, 0, 0, 0.16);
  padding: 12px;
}
.blinko-snap-relation-head,
.blinko-snap-task-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.blinko-snap-relation-title,
.blinko-snap-task-title {
  font-size: 13px;
  font-weight: 700;
  line-height: 1.5;
}
.blinko-snap-relation-meta,
.blinko-snap-task-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.64);
}
.blinko-snap-relation-snippet,
.blinko-snap-task-output {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.65;
  color: rgba(255, 255, 255, 0.8);
  white-space: pre-wrap;
}
.blinko-snap-mini-actions {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.blinko-snap-input-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 10px;
}
.blinko-snap-attachment-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.blinko-snap-attachment-title {
  font-size: 13px;
  font-weight: 700;
}
.blinko-snap-attachment-meta {
  margin-top: 6px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.65);
}
.blinko-snap-attachment-actions,
.blinko-snap-task-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.blinko-snap-panel-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
@media (max-width: 860px) {
  .blinko-snap-overlay {
    padding: 12px;
  }
  .blinko-snap-dialog-head,
  .blinko-snap-body,
  .blinko-snap-footer,
  .blinko-snap-sync-toolbar,
  .blinko-snap-sync-meta,
  .blinko-snap-sync-list {
    padding-left: 14px;
    padding-right: 14px;
  }
  .blinko-snap-settings-grid {
    grid-template-columns: 1fr;
  }
  .blinko-snap-sync-toolbar {
    grid-template-columns: 1fr;
  }
  .blinko-snap-toolbar-row {
    padding-left: 14px;
    padding-right: 14px;
  }
  .blinko-snap-sync-meta {
    flex-direction: column;
    align-items: flex-start;
  }
  .blinko-snap-card-head {
    flex-direction: column;
  }
  .blinko-snap-workbench-grid {
    grid-template-columns: 1fr;
  }
  .blinko-snap-input-row {
    grid-template-columns: 1fr;
  }
}
`
  document.head.appendChild(style)
}

function collectSettingsDraft() {
  if (!settingsOverlayEl || !settingsOverlayEl._refs) {
    return createDefaultSettings()
  }
  const refs = settingsOverlayEl._refs
  return normalizeSettings({
    apiBase: refs.apiBase.value,
    apiToken: refs.apiToken.value,
    siteUrl: refs.siteUrl.value,
    localFolder: refs.localFolder.value,
    pullPageSize: refs.pullPageSize.value,
    openAfterPull: refs.openAfterPull.checked,
    defaultTag: refs.defaultTag.value,
    uploadRemoteImages: refs.uploadRemoteImages.checked
  })
}

function syncSiteUrlDraftFromApiBase(overlay, force) {
  if (!overlay || !overlay._refs) return
  const refs = overlay._refs
  const previousApiBase = String(overlay._siteUrlSourceApiBase || '').trim()
  const previousDerived = deriveSiteUrlFromApiBase(previousApiBase)
  const nextApiBase = String(refs.apiBase.value || '').trim()
  const nextDerived = deriveSiteUrlFromApiBase(nextApiBase)
  const currentSiteUrl = String(refs.siteUrl.value || '').trim().replace(/\/+$/, '')
  if (force || !currentSiteUrl || currentSiteUrl === previousDerived) {
    refs.siteUrl.value = nextDerived
  }
  overlay._siteUrlSourceApiBase = nextApiBase
}

function ensureSettingsOverlay() {
  if (settingsOverlayEl) return settingsOverlayEl
  ensureBlinkoStyle()

  const overlay = document.createElement('div')
  overlay.id = SETTINGS_OVERLAY_ID
  overlay.className = 'blinko-snap-overlay hidden'
  overlay.innerHTML = `
    <div class="blinko-snap-dialog">
      <div class="blinko-snap-dialog-head">
        <div>
          <div class="blinko-snap-title">Blinko 设置</div>
          <div class="blinko-snap-subtitle">配置 API、默认远端标签和本地 blinko 同步目录。拉取下来的文章会把 <code>blinkoId</code> 写进 Front Matter，后续再发送就能更新同一篇远端文章。</div>
        </div>
        <button type="button" class="blinko-snap-btn close" data-action="close-settings">×</button>
      </div>
      <div class="blinko-snap-body">
        <div class="blinko-snap-settings-grid">
          <label class="blinko-snap-field full">
            <span class="blinko-snap-label">API 基础地址</span>
            <input class="blinko-snap-input" data-field="apiBase" type="text" placeholder="例如：https://api.blinko.space/api" />
            <span class="blinko-snap-desc">填 Blinko 的 <code>/api</code> 根地址。官方托管默认就是 <code>${DEFAULT_API_BASE}</code>。</span>
          </label>
          <label class="blinko-snap-field full">
            <span class="blinko-snap-label">访问 Token</span>
            <input class="blinko-snap-input" data-field="apiToken" type="password" placeholder="在 Blinko 后台生成的 Bearer Token" />
            <span class="blinko-snap-desc">发送文章、拉取文章、拉标签列表都走这个 Token。</span>
          </label>
          <label class="blinko-snap-field full">
            <span class="blinko-snap-label">Blinko 站点网址</span>
            <input class="blinko-snap-input" data-field="siteUrl" type="text" placeholder="例如：https://blinko.your-domain.com" />
            <span class="blinko-snap-desc">用于生成登录门户文档。留空时会根据上面的 API 地址自动推导，把结尾的 <code>/api</code> 去掉就行。</span>
          </label>
          <label class="blinko-snap-field">
            <span class="blinko-snap-label">本地同步目录</span>
            <input class="blinko-snap-input" data-field="localFolder" type="text" placeholder="blinko" />
            <span class="blinko-snap-desc">拉取文章时自动在当前库里创建并使用这个目录，默认就是 <code>blinko</code>。</span>
          </label>
          <label class="blinko-snap-field">
            <span class="blinko-snap-label">默认远端标签</span>
            <input class="blinko-snap-input" data-field="defaultTag" type="text" placeholder="可选，例如：flymd" />
            <span class="blinko-snap-desc">发送时会自动带上这个标签。文章列表和拉取逻辑不再偷偷用它过滤，免得把数据越看越少。</span>
          </label>
          <label class="blinko-snap-field">
            <span class="blinko-snap-label">拉取页大小</span>
            <input class="blinko-snap-number" data-field="pullPageSize" type="number" min="1" max="${MAX_PAGE_SIZE}" />
            <span class="blinko-snap-desc">“拉取最新一页到本地”默认抓多少篇。列表选择窗口会尽量多展示，别把两件事绑死。</span>
          </label>
          <div class="blinko-snap-field">
            <span class="blinko-snap-label">同步策略</span>
            <label class="blinko-snap-check">
              <input data-field="openAfterPull" type="checkbox" />
              <span class="blinko-snap-desc">批量拉取结束后自动打开第一篇本地文件。默认关闭，免得一口气弹一堆东西。</span>
            </label>
          </div>
          <div class="blinko-snap-field full">
            <span class="blinko-snap-label">附件策略</span>
            <label class="blinko-snap-check">
              <input data-field="uploadRemoteImages" type="checkbox" />
              <span class="blinko-snap-desc">发送文章时，尝试把 Markdown 里的远程图片 URL 调用 <code>/api/file/upload-by-url</code> 转成 Blinko 附件。默认关闭，避免把一堆失败图片拖慢发送。</span>
            </label>
          </div>
        </div>
        <div class="blinko-snap-tip">
          拉取文章时，本地文件名会带上 <code>__blinko_ID</code> 后缀，目的是消掉重复文件这类垃圾特殊情况。标题改了也不会把同一篇文章同步成两份。
        </div>
      </div>
      <div class="blinko-snap-footer">
        <button type="button" class="blinko-snap-btn" data-action="test-connection">测试连接</button>
        <button type="button" class="blinko-snap-btn" data-action="ensure-folder">创建本地目录</button>
        <button type="button" class="blinko-snap-btn" data-action="open-login-doc">打开登录文档</button>
        <button type="button" class="blinko-snap-btn" data-action="open-sync">打开同步台</button>
        <button type="button" class="blinko-snap-btn" data-action="close-settings">取消</button>
        <button type="button" class="blinko-snap-btn primary" data-action="save-settings">保存</button>
      </div>
    </div>
  `

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      overlay.classList.add('hidden')
    }
  })

  overlay.addEventListener('click', async (event) => {
    const btn = event.target && event.target.closest ? event.target.closest('[data-action]') : null
    if (!btn) return
    const action = btn.getAttribute('data-action')
    const context = overlay._context || globalContextRef
    if (!context) return

    if (action === 'close-settings') {
      overlay.classList.add('hidden')
      return
    }

    if (action === 'save-settings') {
      await runGuardedAction(context, '保存 Blinko 设置失败：', async () => {
        const next = await saveSettings(context, collectSettingsDraft())
        overlay.classList.add('hidden')
        try {
          await ensureLocalBlinkoFolder(context, next)
        } catch {}
        safeNotice(context, 'Blinko 设置已保存', 'ok', 2200)
      })
      return
    }

    if (action === 'test-connection') {
      await runGuardedAction(context, 'Blinko 连接失败：', async () => {
        const info = await testBlinkoConnection(context, collectSettingsDraft())
        let msg = `连接成功，已读取 ${info.tags.length} 个标签`
        if (info.warning) msg += `；${info.warning}`
        safeNotice(context, msg, info.warning ? 'warn' : 'ok', 3200)
      })
      return
    }

    if (action === 'ensure-folder') {
      await runGuardedAction(context, '创建本地目录失败：', async () => {
        const next = await saveSettings(context, collectSettingsDraft())
        const dir = await ensureLocalBlinkoFolder(context, next)
        safeNotice(context, '本地目录已就绪：' + dir, 'ok', 3200)
      })
      return
    }

    if (action === 'open-sync') {
      await runGuardedAction(context, '打开同步台失败：', async () => {
        await saveSettings(context, collectSettingsDraft())
        overlay.classList.add('hidden')
        await openPanel(context)
      })
      return
    }

    if (action === 'open-login-doc') {
      await runGuardedAction(context, '打开登录文档失败：', async () => {
        await saveSettings(context, collectSettingsDraft())
        overlay.classList.add('hidden')
        await openBlinkoLoginDoc(context)
      })
    }
  })

  const refs = {
    apiBase: overlay.querySelector('[data-field="apiBase"]'),
    apiToken: overlay.querySelector('[data-field="apiToken"]'),
    siteUrl: overlay.querySelector('[data-field="siteUrl"]'),
    localFolder: overlay.querySelector('[data-field="localFolder"]'),
    defaultTag: overlay.querySelector('[data-field="defaultTag"]'),
    pullPageSize: overlay.querySelector('[data-field="pullPageSize"]'),
    openAfterPull: overlay.querySelector('[data-field="openAfterPull"]'),
    uploadRemoteImages: overlay.querySelector('[data-field="uploadRemoteImages"]')
  }

  refs.apiBase.addEventListener('input', () => {
    syncSiteUrlDraftFromApiBase(overlay, false)
  })

  overlay._refs = refs
  document.body.appendChild(overlay)
  settingsOverlayEl = overlay
  return overlay
}

async function openSettingsDialog(context) {
  if (!context) return
  const overlay = ensureSettingsOverlay()
  overlay._context = context
  const settings = await loadSettings(context)
  const refs = overlay._refs
  refs.apiBase.value = settings.apiBase || DEFAULT_API_BASE
  refs.apiToken.value = settings.apiToken || ''
  refs.siteUrl.value = settings.siteUrl || ''
  refs.localFolder.value = settings.localFolder || 'blinko'
  refs.defaultTag.value = settings.defaultTag || ''
  refs.pullPageSize.value = String(settings.pullPageSize || 20)
  refs.openAfterPull.checked = !!settings.openAfterPull
  refs.uploadRemoteImages.checked = !!settings.uploadRemoteImages
  overlay._siteUrlSourceApiBase = refs.apiBase.value || ''
  if (!String(refs.siteUrl.value || '').trim()) {
    syncSiteUrlDraftFromApiBase(overlay, true)
  }
  overlay.classList.remove('hidden')
}

function buildSyncCardHtml(note, localPath, selected) {
  const title = escapeHtml(resolveBlinkoNoteTitle(note))
  const snippet = escapeHtml(plainTextSnippet(note && note.content ? note.content : ''))
  const tags = extractBlinkoNoteTagNames(note)
  const metaBits = [
    '#' + String(note && note.id != null ? note.id : ''),
    note && note.updatedAt ? '更新于 ' + formatDateTime(note.updatedAt) : '',
    Array.isArray(note && note.attachments) && note.attachments.length
      ? '附件 ' + note.attachments.length
      : '',
    tags.length ? '标签：' + tags.join(' / ') : ''
  ].filter(Boolean)

  const saved = !!localPath
  return `
    <div class="blinko-snap-card">
      <div class="blinko-snap-card-topline">
        <label class="blinko-snap-card-check">
          <input type="checkbox" data-action="toggle-note-selection" data-id="${escapeHtml(note.id)}" ${selected ? 'checked' : ''} />
          <span>选择拉取</span>
        </label>
        <div class="blinko-snap-card-badges">${buildStatusBadges(note, localPath)}</div>
      </div>
      <div class="blinko-snap-card-head">
        <div>
          <div class="blinko-snap-card-title">${title}</div>
          <div class="blinko-snap-card-meta">${metaBits.map((bit) => `<span>${escapeHtml(bit)}</span>`).join('')}</div>
        </div>
      </div>
      <div class="blinko-snap-card-snippet">${snippet || '这篇文章没有可预览的正文。'}</div>
      <div class="blinko-snap-card-actions">
        <button type="button" class="blinko-snap-btn" data-action="apply-note" data-id="${escapeHtml(note.id)}">写入当前文档</button>
        <button type="button" class="blinko-snap-btn" data-action="save-note" data-id="${escapeHtml(note.id)}">${saved ? '更新本地副本' : '拉取到本地'}</button>
        <button type="button" class="blinko-snap-btn primary" data-action="open-note" data-id="${escapeHtml(note.id)}">${saved ? '更新并打开' : '拉取并打开'}</button>
      </div>
    </div>
  `
}

function renderSyncPanel() {
  if (!syncOverlayEl || !syncOverlayEl._refs || !syncOverlayEl._state) return
  const refs = syncOverlayEl._refs
  const state = syncOverlayEl._state
  const settings = state.settings || createDefaultSettings()
  const selectedCount = getSelectedSyncNoteIds(state).length

  if (document.activeElement !== refs.search) {
    refs.search.value = state.searchText || ''
  }

  refs.pageLabel.textContent = `第 ${state.page} 页 · ${getSyncViewLabel(state.view)} · 列表每页 ${SYNC_PANEL_PAGE_SIZE} 篇 · 本地目录 ${normalizeLocalFolderPath(settings.localFolder)}`
  refs.status.textContent = state.loading
    ? '正在从 Blinko 拉取列表...'
    : state.error
      ? ''
      : state.lastLoadedAt
        ? `本页 ${state.notes.length} 篇 · 已选 ${selectedCount} 篇 · 上次刷新 ${state.lastLoadedAt}`
        : `本页 ${state.notes.length} 篇 · 已选 ${selectedCount} 篇`

  if (state.warning) {
    refs.warning.textContent = state.warning
    refs.warning.classList.remove('hidden')
  } else {
    refs.warning.textContent = ''
    refs.warning.classList.add('hidden')
  }

  if (state.loading) {
    refs.list.innerHTML = '<div class="blinko-snap-empty">正在加载 Blinko 文章列表...</div>'
    return
  }

  if (state.error) {
    refs.list.innerHTML = `<div class="blinko-snap-error">${escapeHtml(state.error)}</div>`
    return
  }

  if (!state.notes.length) {
    refs.list.innerHTML = '<div class="blinko-snap-empty">当前页没有文章。改个搜索词，或者去 Blinko 里先写点东西。</div>'
    return
  }

  refs.list.innerHTML = state.notes
    .map((note) => buildSyncCardHtml(note, state.localIndex[String(note.id)], isSyncNoteSelected(state, note && note.id)))
    .join('')
}

async function refreshSyncPanelData(context, opt) {
  if (!syncOverlayEl || !syncOverlayEl._state) return
  const state = syncOverlayEl._state
  if (opt && Object.prototype.hasOwnProperty.call(opt, 'searchText')) {
    state.searchText = String(opt.searchText || '').trim()
  }
  if (opt && Object.prototype.hasOwnProperty.call(opt, 'page')) {
    state.page = clampInt(opt.page, 1, 999999, 1)
  }

  const settings = await loadSettings(context)
  state.settings = settings
  state.loading = true
  state.error = ''
  state.warning = ''
  state.requestId += 1
  const requestId = state.requestId
  renderSyncPanel()

  try {
    const result = await listBlinkoNotes(context, settings, {
      page: state.page,
      size: SYNC_PANEL_PAGE_SIZE,
      searchText: state.searchText,
      view: state.view
    })
    const localIndex = await buildLocalNoteIndex(context, settings)
    if (!syncOverlayEl || !syncOverlayEl._state || syncOverlayEl._state.requestId !== requestId) {
      return
    }
    state.notes = result.notes
    state.warning = result.warning
    state.localIndex = localIndex
    state.lastLoadedAt = new Date().toLocaleString()
    syncSelectionWithVisibleNotes(state)
  } catch (error) {
    if (!syncOverlayEl || !syncOverlayEl._state || syncOverlayEl._state.requestId !== requestId) {
      return
    }
    state.notes = []
    state.localIndex = {}
    state.error = getErrorMessage(error)
    state.selectedIds = {}
  } finally {
    if (!syncOverlayEl || !syncOverlayEl._state || syncOverlayEl._state.requestId !== requestId) {
      return
    }
    state.loading = false
    renderSyncPanel()
  }
}

function findSyncNoteById(id) {
  if (!syncOverlayEl || !syncOverlayEl._state) return null
  const noteId = Number(id)
  if (!Number.isFinite(noteId)) return null
  return (
    syncOverlayEl._state.notes.find((note) => Number(note && note.id) === noteId) || null
  )
}

async function withBusyButton(button, busyText, task) {
  if (!button) return await task()
  const original = button.textContent
  button.disabled = true
  if (busyText) button.textContent = busyText
  try {
    return await task()
  } finally {
    if (button.isConnected) {
      button.disabled = false
      button.textContent = original
    }
  }
}

async function pullCurrentSyncPage(context) {
  if (!syncOverlayEl || !syncOverlayEl._state) return
  const state = syncOverlayEl._state
  const settings = await loadSettings(context)
  state.settings = settings
  const notes = Array.isArray(state.notes) ? state.notes : []
  if (!notes.length) {
    safeNotice(context, '当前页没有可拉取的文章', 'warn', 2200)
    return
  }

  if (notes.length > 1) {
    const ok = await safeConfirm(
      context,
      `将把当前页的 ${notes.length} 篇 Blinko 文章同步到本地 ${normalizeLocalFolderPath(settings.localFolder)} 文件夹，是否继续？`
    )
    if (!ok) return
  }

  const folderPath = await ensureLocalBlinkoFolder(context, settings)
  if (!state.localIndex || typeof state.localIndex !== 'object') {
    state.localIndex = await buildLocalNoteIndex(context, settings)
  }

  let success = 0
  let fail = 0
  let firstSaved = ''
  for (const note of notes) {
    try {
      const full = await fetchFullBlinkoNote(context, settings, note)
      const saved = await saveBlinkoNoteToLibrary(context, settings, full, {
        localIndex: state.localIndex,
        folderPath,
        openAfterSave: false
      })
      if (!firstSaved) firstSaved = saved
      success += 1
    } catch {
      fail += 1
    }
  }

  if (settings.openAfterPull && firstSaved && typeof context.openFileByPath === 'function') {
    try {
      await context.openFileByPath(firstSaved)
    } catch {}
  }

  renderSyncPanel()
  let msg = `已同步 ${success} 篇到 ${normalizeLocalFolderPath(settings.localFolder)}`
  if (fail) msg += `，失败 ${fail} 篇`
  safeNotice(context, msg, fail ? 'warn' : 'ok', 3200)
}

async function pullSelectedSyncNotes(context) {
  if (!syncOverlayEl || !syncOverlayEl._state) return
  const state = syncOverlayEl._state
  const selectedIds = getSelectedSyncNoteIds(state)
  if (!selectedIds.length) {
    safeNotice(context, '先在列表里勾选要拉取的文章', 'warn', 2200)
    return
  }

  const settings = await loadSettings(context)
  state.settings = settings
  const ok = await safeConfirm(
    context,
    `将把选中的 ${selectedIds.length} 篇 Blinko 文章拉取到本地 ${normalizeLocalFolderPath(settings.localFolder)} 文件夹，是否继续？`
  )
  if (!ok) return

  const folderPath = await ensureLocalBlinkoFolder(context, settings)
  if (!state.localIndex || typeof state.localIndex !== 'object') {
    state.localIndex = await buildLocalNoteIndex(context, settings)
  }

  let success = 0
  let fail = 0
  let firstSaved = ''
  for (const id of selectedIds) {
    try {
      const full = await fetchFullBlinkoNote(context, settings, id)
      const saved = await saveBlinkoNoteToLibrary(context, settings, full, {
        localIndex: state.localIndex,
        folderPath,
        openAfterSave: false
      })
      if (!firstSaved) firstSaved = saved
      success += 1
    } catch {
      fail += 1
    }
  }

  if (settings.openAfterPull && firstSaved && typeof context.openFileByPath === 'function') {
    try {
      await context.openFileByPath(firstSaved)
    } catch {}
  }

  renderSyncPanel()
  let msg = `已拉取选中的 ${success} 篇文章`
  if (fail) msg += `，失败 ${fail} 篇`
  safeNotice(context, msg, fail ? 'warn' : 'ok', 3200)
}

function ensureSyncOverlay() {
  if (syncOverlayEl) return syncOverlayEl
  ensureBlinkoStyle()

  const overlay = document.createElement('div')
  overlay.id = SYNC_OVERLAY_ID
  overlay.className = 'blinko-snap-overlay hidden'
  overlay.innerHTML = `
    <div class="blinko-snap-dialog blinko-snap-sync-dialog">
      <div class="blinko-snap-dialog-head">
        <div>
          <div class="blinko-snap-title">Blinko 同步台</div>
          <div class="blinko-snap-subtitle">从 Blinko 拉文章、写回当前文档、同步到本地 <code>blinko</code> 文件夹，都在这里做。接口是干净的，活也就干净。</div>
        </div>
        <button type="button" class="blinko-snap-btn close" data-action="close-sync">×</button>
      </div>
      <div class="blinko-snap-sync-toolbar">
        <input class="blinko-snap-search" data-role="search" type="text" placeholder="搜索标题或正文关键字" />
        <button type="button" class="blinko-snap-btn" data-action="refresh-sync">刷新列表</button>
        <button type="button" class="blinko-snap-btn" data-action="pull-selected">拉取选中</button>
        <button type="button" class="blinko-snap-btn" data-action="clear-selected">清空勾选</button>
        <button type="button" class="blinko-snap-btn" data-action="pull-page">拉取当前页</button>
        <button type="button" class="blinko-snap-btn" data-action="send-current">发送当前文档</button>
        <button type="button" class="blinko-snap-btn" data-action="open-settings">设置</button>
      </div>
      <div class="blinko-snap-sync-meta">
        <div class="blinko-snap-pagebox">
          <button type="button" class="blinko-snap-btn" data-action="prev-page">上一页</button>
          <span data-role="page-label" class="blinko-snap-status"></span>
          <button type="button" class="blinko-snap-btn" data-action="next-page">下一页</button>
        </div>
        <div data-role="status" class="blinko-snap-status"></div>
      </div>
      <div data-role="warning" class="blinko-snap-inline-warning hidden"></div>
      <div data-role="list" class="blinko-snap-sync-list"></div>
    </div>
  `

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      overlay.classList.add('hidden')
    }
  })

  overlay.addEventListener('click', async (event) => {
    const btn = event.target && event.target.closest ? event.target.closest('[data-action]') : null
    if (!btn) return
    const action = btn.getAttribute('data-action')
    const context = overlay._context || globalContextRef
    if (!context) return

    if (action === 'close-sync') {
      overlay.classList.add('hidden')
      return
    }

    if (action === 'open-settings') {
      await openSettingsDialog(context)
      return
    }

    if (action === 'refresh-sync') {
      const searchText = overlay._refs.search.value.trim()
      const nextPage = searchText === overlay._state.searchText ? overlay._state.page : 1
      await runGuardedAction(context, '刷新 Blinko 列表失败：', async () => {
        await refreshSyncPanelData(context, {
          searchText,
          page: nextPage
        })
      })
      return
    }

    if (action === 'prev-page') {
      if (overlay._state.page <= 1) return
      await runGuardedAction(context, '加载上一页失败：', async () => {
        await refreshSyncPanelData(context, { page: overlay._state.page - 1 })
      })
      return
    }

    if (action === 'next-page') {
      await runGuardedAction(context, '加载下一页失败：', async () => {
        await refreshSyncPanelData(context, { page: overlay._state.page + 1 })
      })
      return
    }

    if (action === 'pull-selected') {
      await withBusyButton(btn, '拉取中...', async () => {
        await runGuardedAction(context, '拉取选中文章失败：', async () => {
          await pullSelectedSyncNotes(context)
        })
      })
      return
    }

    if (action === 'clear-selected') {
      overlay._state.selectedIds = {}
      renderSyncPanel()
      safeNotice(context, '已清空勾选列表', 'ok', 1800)
      return
    }

    if (action === 'pull-page') {
      await withBusyButton(btn, '拉取中...', async () => {
        await runGuardedAction(context, '拉取当前页失败：', async () => {
          await pullCurrentSyncPage(context)
        })
      })
      return
    }

    if (action === 'send-current') {
      await withBusyButton(btn, '发送中...', async () => {
        await runGuardedAction(context, '发送当前文档失败：', async () => {
          await sendCurrentDocumentToBlinko(context, null, { preferSelection: false })
        })
      })
      return
    }

    const noteId = btn.getAttribute('data-id')
    const note = findSyncNoteById(noteId)
    if (action === 'toggle-note-selection') {
      setSyncNoteSelected(overlay._state, noteId, !!btn.checked)
      renderSyncPanel()
      return
    }
    if (!note) {
      safeNotice(context, '找不到对应的 Blinko 文章', 'err', 2600)
      return
    }

    if (action === 'apply-note') {
      await withBusyButton(btn, '写入中...', async () => {
        await runGuardedAction(context, '写入当前文档失败：', async () => {
          const settings = await loadSettings(context)
          const full = await fetchFullBlinkoNote(context, settings, note)
          await applyBlinkoNoteToEditor(context, full)
        })
      })
      return
    }

    if (action === 'save-note') {
      await withBusyButton(btn, '保存中...', async () => {
        await runGuardedAction(context, '保存到本地失败：', async () => {
          const settings = await loadSettings(context)
          overlay._state.settings = settings
          const folderPath = await ensureLocalBlinkoFolder(context, settings)
          if (!overlay._state.localIndex || typeof overlay._state.localIndex !== 'object') {
            overlay._state.localIndex = await buildLocalNoteIndex(context, settings)
          }
          const full = await fetchFullBlinkoNote(context, settings, note)
          const saved = await saveBlinkoNoteToLibrary(context, settings, full, {
            localIndex: overlay._state.localIndex,
            folderPath,
            openAfterSave: false
          })
          renderSyncPanel()
          safeNotice(context, '已保存到：' + saved, 'ok', 2800)
        })
      })
      return
    }

    if (action === 'open-note') {
      await withBusyButton(btn, '处理中...', async () => {
        await runGuardedAction(context, '保存并打开失败：', async () => {
          const settings = await loadSettings(context)
          overlay._state.settings = settings
          const folderPath = await ensureLocalBlinkoFolder(context, settings)
          if (!overlay._state.localIndex || typeof overlay._state.localIndex !== 'object') {
            overlay._state.localIndex = await buildLocalNoteIndex(context, settings)
          }
          const full = await fetchFullBlinkoNote(context, settings, note)
          await saveBlinkoNoteToLibrary(context, settings, full, {
            localIndex: overlay._state.localIndex,
            folderPath,
            openAfterSave: true
          })
          renderSyncPanel()
        })
      })
    }
  })

  const refs = {
    search: overlay.querySelector('[data-role="search"]'),
    pageLabel: overlay.querySelector('[data-role="page-label"]'),
    status: overlay.querySelector('[data-role="status"]'),
    warning: overlay.querySelector('[data-role="warning"]'),
    list: overlay.querySelector('[data-role="list"]')
  }

  refs.search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const context = overlay._context || globalContextRef
    if (!context) return
    const searchText = refs.search.value.trim()
    const nextPage = searchText === overlay._state.searchText ? overlay._state.page : 1
    void runGuardedAction(context, '刷新 Blinko 列表失败：', async () => {
      await refreshSyncPanelData(context, {
        searchText,
        page: nextPage
      })
    })
  })

  overlay._refs = refs
  overlay._state = createSyncState()
  document.body.appendChild(overlay)
  syncOverlayEl = overlay
  renderSyncPanel()
  return overlay
}

async function openPanel(context) {
  if (!context) return
  const overlay = ensureSyncOverlay()
  overlay._context = context
  overlay.classList.remove('hidden')
  await refreshSyncPanelData(context)
}

function buildBlinkoActionMenu(context) {
  return [
    { type: 'group', label: '发送' },
    {
      label: '发送当前文章',
      onClick: async () => {
        await runGuardedAction(context, '发送当前文档失败：', async () => {
          await sendCurrentDocumentToBlinko(context, null, { preferSelection: false })
        })
      }
    },
    { type: 'divider' },
    { type: 'group', label: '同步' },
    {
      label: '拉取待办到本地',
      onClick: async () => {
        await runGuardedAction(context, '拉取待办失败：', async () => {
          await pullBlinkoTodosToLibrary(context, { openAfterSave: true })
        })
      }
    },
    {
      label: '打开待办便签',
      onClick: async () => {
        await runGuardedAction(context, '打开待办便签失败：', async () => {
          await pullBlinkoTodosToLibrary(context, { openAsSticky: true })
        })
      }
    },
    {
      label: '打开同步台',
      onClick: async () => {
        await runGuardedAction(context, '打开同步台失败：', async () => {
          await openPanel(context)
        })
      }
    },
    { type: 'divider' },
    {
      label: '打开登录文档',
      onClick: async () => {
        await runGuardedAction(context, '打开登录文档失败：', async () => {
          await openBlinkoLoginDoc(context)
        })
      }
    },
    { type: 'divider' },
    {
      label: '设置',
      onClick: async () => {
        await openSettingsDialog(context)
      }
    }
  ]
}

function buildRibbonIconSvg() {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h9a4 4 0 0 1 4 4v7a5 5 0 0 1-5 5H5z"/><path d="M8 8h7"/><path d="M8 12h8"/><path d="M8 16h5"/></svg>'
}

function cleanupDisposers() {
  if (typeof menuDisposer === 'function') {
    try { menuDisposer() } catch {}
  }
  menuDisposer = null

  if (typeof ribbonDisposer === 'function') {
    try { ribbonDisposer() } catch {}
  }
  ribbonDisposer = null

  if (ctxMenuDisposers && ctxMenuDisposers.length) {
    for (const disposer of ctxMenuDisposers) {
      try {
        if (typeof disposer === 'function') disposer()
      } catch {}
    }
  }
  ctxMenuDisposers = []
}

export async function activate(context) {
  globalContextRef = context
  cleanupDisposers()

  let settings = createDefaultSettings()
  try {
    settings = await loadSettings(context)
  } catch {}

  try {
    await ensureLocalBlinkoFolder(context, settings)
  } catch {}

  if (context && typeof context.addMenuItem === 'function') {
    try {
      const disposer = context.addMenuItem({
        label: 'Blinko',
        title: '发送、拉取并同步 Blinko 文章',
        children: buildBlinkoActionMenu(context)
      })
      if (typeof disposer === 'function') menuDisposer = disposer
    } catch {}
  }

  if (context && typeof context.addRibbonButton === 'function') {
    try {
      const disposer = context.addRibbonButton({
        icon: buildRibbonIconSvg(),
        iconType: 'svg',
        title: 'Blinko',
        onClick: async (event) => {
          try {
            if (
              context.showDropdownMenu &&
              event &&
              (event.currentTarget || event.target)
            ) {
              context.showDropdownMenu(
                event.currentTarget || event.target,
                buildBlinkoActionMenu(context)
              )
            } else {
              await openPanel(context)
            }
          } catch (error) {
            handleActionError(context, '打开 Blinko 菜单失败：', error, true)
          }
        }
      })
      if (typeof disposer === 'function') ribbonDisposer = disposer
    } catch {}
  }

  if (context && typeof context.addContextMenuItem === 'function') {
    try {
      const sendDisposer = context.addContextMenuItem({
        label: '发送到 Blinko',
        async onClick(ctx) {
          await runGuardedAction(context, '发送到 Blinko 失败：', async () => {
            await sendCurrentDocumentToBlinko(context, ctx, { preferSelection: true })
          })
        }
      })
      if (typeof sendDisposer === 'function') ctxMenuDisposers.push(sendDisposer)
    } catch {}

    try {
      const manageDisposer = context.addContextMenuItem({
        label: 'Blinko',
        children: [
          {
            label: '拉取待办到本地',
            onClick: async () => {
              await runGuardedAction(context, '拉取待办失败：', async () => {
                await pullBlinkoTodosToLibrary(context, { openAfterSave: true })
              })
            }
          },
          {
            label: '打开待办便签',
            onClick: async () => {
              await runGuardedAction(context, '打开待办便签失败：', async () => {
                await pullBlinkoTodosToLibrary(context, { openAsSticky: true })
              })
            }
          },
          {
            label: '打开同步台',
            onClick: async () => {
              await runGuardedAction(context, '打开同步台失败：', async () => {
                await openPanel(context)
              })
            }
          },
          { type: 'divider' },
          {
            label: '打开登录文档',
            onClick: async () => {
              await runGuardedAction(context, '打开登录文档失败：', async () => {
                await openBlinkoLoginDoc(context)
              })
            }
          },
          { type: 'divider' },
          {
            label: '设置',
            onClick: async () => {
              await openSettingsDialog(context)
            }
          }
        ]
      })
      if (typeof manageDisposer === 'function') ctxMenuDisposers.push(manageDisposer)
    } catch {}
  }

  if (context && typeof context.registerAPI === 'function') {
    try {
      context.registerAPI('blinko-snap', {
        sendCurrent: async () => {
          const ctx = globalContextRef || context
          return await sendCurrentDocumentToBlinko(ctx, null, { preferSelection: false })
        },
        pullLatestToLibrary: async () => {
          const ctx = globalContextRef || context
          return await pullLatestNotesToLocalFolder(ctx)
        },
        pullTodosToLibrary: async (opt) => {
          const ctx = globalContextRef || context
          return await pullBlinkoTodosToLibrary(ctx, opt || {})
        },
        listNotes: async (query) => {
          const ctx = globalContextRef || context
          const currentSettings = await loadSettings(ctx)
          return await listBlinkoNotes(ctx, currentSettings, query || {})
        },
        pullNoteToLibrary: async (id, opt) => {
          const ctx = globalContextRef || context
          const currentSettings = await loadSettings(ctx)
          const folderPath = await ensureLocalBlinkoFolder(ctx, currentSettings)
          const localIndex = await buildLocalNoteIndex(ctx, currentSettings)
          const full = await fetchFullBlinkoNote(ctx, currentSettings, id)
          return await saveBlinkoNoteToLibrary(ctx, currentSettings, full, {
            localIndex,
            folderPath,
            openAfterSave: !!(opt && opt.openAfterSave)
          })
        },
        ensureLocalFolder: async () => {
          const ctx = globalContextRef || context
          const currentSettings = await loadSettings(ctx)
          return await ensureLocalBlinkoFolder(ctx, currentSettings)
        },
        openLoginDoc: async () => {
          const ctx = globalContextRef || context
          return await openBlinkoLoginDoc(ctx)
        },
        openPanel: async () => {
          const ctx = globalContextRef || context
          await openPanel(ctx)
        }
      })
    } catch {}
  }
}

export function deactivate() {
  cleanupDisposers()
  resetTagCache()
  globalContextRef = null

  if (settingsOverlayEl && settingsOverlayEl.parentNode) {
    try {
      settingsOverlayEl.parentNode.removeChild(settingsOverlayEl)
    } catch {}
  }
  settingsOverlayEl = null

  if (syncOverlayEl && syncOverlayEl.parentNode) {
    try {
      syncOverlayEl.parentNode.removeChild(syncOverlayEl)
    } catch {}
  }
  syncOverlayEl = null
}

export async function openSettings(context) {
  globalContextRef = context || globalContextRef
  if (!globalContextRef) return
  await openSettingsDialog(globalContextRef)
}

export async function openPanelEntry(context) {
  globalContextRef = context || globalContextRef
  if (!globalContextRef) return
  await openPanel(globalContextRef)
}
