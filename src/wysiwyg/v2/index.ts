// 所见模式 V2：基于 Milkdown 的真实所见编辑视图
// 暴露 enable/disable 与 setMarkdown/getMarkdown 能力，供主流程挂接

import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx, editorViewCtx, commandsCtx } from '@milkdown/core'
import { convertFileSrc } from '@tauri-apps/api/core'
import { readFile } from '@tauri-apps/plugin-fs'
// 用于外部（main.ts）在所见模式下插入 Markdown（文件拖放时复用普通模式逻辑）
import { replaceAll, getMarkdown } from '@milkdown/utils'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { automd } from '@milkdown/plugin-automd'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { upload, uploadConfig } from '@milkdown/plugin-upload'
import { uploader } from './plugins/paste'
// 注：保留 automd 插件以提供编辑功能，通过 CSS 隐藏其 UI 组件
// 引入富文本所见视图的必要样式（避免工具条/布局错乱导致不可编辑/不可滚动）
// 注：不直接导入 @milkdown/crepe/style.css，避免 Vite 对未导出的样式路径解析失败。

let _editor: Editor | null = null
let _root: HTMLElement | null = null
let _onChange: ((md: string) => void) | null = null
let _suppressInitialUpdate = false
let _lastMd = ''
let _imgObserver: MutationObserver | null = null
let _overlayTimer: number | null = null
let _overlayHost: HTMLDivElement | null = null

function toLocalAbsFromSrc(src: string): string | null {
  try {
    if (!src) return null
    let s = String(src).trim()
    // 去掉 Markdown 尖括号 <...>
    if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1)
    // 尽量解码一次
    try { s = decodeURIComponent(s) } catch {}
    // data/blob/asset/http 跳过
    if (/^(data:|blob:|asset:|https?:)/i.test(s)) return null
    // file:// 解析
    if (/^file:/i.test(s)) {
      try {
        const u = new URL(s)
        let p = u.pathname || ''
        if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1)
        p = decodeURIComponent(p)
        if (/^[a-zA-Z]:\//.test(p)) p = p.replace(/\//g, '\\')
        return p
      } catch { /* fallthrough */ }
    }
    // Windows 盘符或 UNC
    if (/^[a-zA-Z]:[\\/]/.test(s)) return s.replace(/\//g, '\\')
    if (/^\\\\/.test(s)) return s.replace(/\//g, '\\')
    // 绝对路径（类 Unix）
    if (/^\//.test(s)) return s
    return null
  } catch { return null }
}

function fromFileUri(u: string): string | null {
  try {
    if (!/^file:/i.test(u)) return null
    const url = new URL(u)
    const host = url.hostname || ''
    let p = url.pathname || ''
    if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1)
    p = decodeURIComponent(p)
    if (host) {
      // UNC: file://server/share/path -> \\server\share\path
      const pathPart = p.replace(/^\//, '').replace(/\//g, '\\')
      return '\\' + '\\' + host + (pathPart ? '\\' + pathPart : '')
    }
    if (/^[a-zA-Z]:\//.test(p)) p = p.replace(/\//g, '\\')
    return p
  } catch { return null }
}
function isTauriRuntime(): boolean {
  try { return typeof (window as any).__TAURI__ !== 'undefined' } catch { return false }
}

function rewriteLocalImagesToAsset() {
  try {
    const host0 = _root as HTMLElement | null
    const host = (host0?.querySelector('.ProseMirror') as HTMLElement | null) || host0
    if (!host) return

    const toDataUrl = async (abs: string): Promise<string | null> => {
      try {
        const bytes = await readFile(abs as any)
        const mime = (() => {
          const m = (abs || '').toLowerCase().match(/\.([a-z0-9]+)$/)
          switch (m?.[1]) {
            case 'jpg':
            case 'jpeg': return 'image/jpeg'
            case 'png': return 'image/png'
            case 'gif': return 'image/gif'
            case 'webp': return 'image/webp'
            case 'bmp': return 'image/bmp'
            case 'avif': return 'image/avif'
            case 'ico': return 'image/x-icon'
            case 'svg': return 'image/svg+xml'
            default: return 'application/octet-stream'
          }
        })()
        const blob = new Blob([bytes], { type: mime })
        return await new Promise<string>((resolve, reject) => {
          try {
            const fr = new FileReader()
            fr.onerror = () => reject(fr.error || new Error('读取图片失败'))
            fr.onload = () => resolve(String(fr.result || ''))
            fr.readAsDataURL(blob)
          } catch (e) { reject(e as any) }
        })
      } catch { return null }
    }

    const convertOne = (imgEl: HTMLImageElement) => {
      try {
        const raw = imgEl.getAttribute('src') || ''
        const abs = toLocalAbsFromSrc(raw)
        if (!abs) return
        void (async () => {
          const dataUrl = await toDataUrl(abs)
          if (dataUrl) {
            if (imgEl.src !== dataUrl) imgEl.src = dataUrl
          }
        })()
      } catch {}
    }

    host.querySelectorAll('img[src]').forEach((img) => { try { convertOne(img as HTMLImageElement) } catch {} })

    if (_imgObserver) { try { _imgObserver.disconnect() } catch {} }
    _imgObserver = new MutationObserver((list) => {
      try {
        for (const m of list) {
          if (m.type === 'attributes' && (m.target as any)?.tagName === 'IMG') {
            const el = m.target as HTMLImageElement
            if (!m.attributeName || m.attributeName.toLowerCase() === 'src') convertOne(el)
          } else if (m.type === 'childList') {
            m.addedNodes.forEach((n) => {
              try {
                if ((n as any)?.nodeType === 1) {
                  const el = n as Element
                  if (el.tagName === 'IMG') { convertOne(el as any) }
                  el.querySelectorAll?.('img[src]')?.forEach((img) => { try { convertOne(img as HTMLImageElement) } catch {} })
                }
              } catch {}
            })
          }
        }
      } catch {}
    })
    _imgObserver.observe(host, { subtree: true, attributes: true, attributeFilter: ['src'], childList: true })
  } catch {}
}function cleanupEditorOnly() {
  try { if (_imgObserver) { _imgObserver.disconnect(); _imgObserver = null } } catch {}
  if (_editor) {
    try { _editor.destroy() } catch {}
    _editor = null
  }
}

export async function enableWysiwygV2(root: HTMLElement, initialMd: string, onChange: (md: string) => void) {
  // 规范化内容：空内容也是合法的（新文档或空文档）
  const content = (initialMd || '').toString()
  console.log('[WYSIWYG V2] enableWysiwygV2 called, content length:', content.length)

  // 仅销毁旧编辑器与观察器，保留外层传入的 root（避免被移除导致空白）
  cleanupEditorOnly()
  _root = root
  _onChange = onChange
  _suppressInitialUpdate = true
  _lastMd = content

  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root)
      ctx.set(defaultValueCtx, _lastMd)
      // 配置编辑器视图选项，确保可编辑
      ctx.set(editorViewOptionsCtx, { editable: () => true })
      // 配置上传：接入现有图床上传逻辑，同时允许从 HTML 粘贴的文件触发上传
      try {
        ctx.update(uploadConfig.key, (prev) => ({
          ...prev,
          uploader,
          enableHtmlFileUploader: true,
        }))
      } catch {}
    })
    .use(commonmark)
    .use(gfm)
    .use(automd)
    .use(listener)
    .use(upload)
    .create()

  try { rewriteLocalImagesToAsset() } catch {}

  try { rewriteLocalImagesToAsset() } catch {}
  // 初次渲染后聚焦
  try {
    const view = (editor as any).ctx.get(editorViewCtx)
    requestAnimationFrame(() => { try { view?.focus() } catch {} })
  } catch {}
  // 初次渲染后重写本地图片为 asset: url（仅影响 DOM，不改 Markdown）
  try { setTimeout(() => { try { rewriteLocalImagesToAsset() } catch {} }, 0) } catch {}
  // 首次挂载后运行一次增强渲染（Mermaid / LaTeX 块）
  try { setTimeout(() => { try { scheduleOverlayRender() } catch {} }, 60) } catch {}
  try { window.addEventListener('resize', () => { try { scheduleOverlayRender() } catch {} }) } catch {}
  // 成功创建后清理占位文案（仅移除纯文本节点，不影响编辑器 DOM）
  try {
    if (_root && _root.firstChild && (_root.firstChild as any).nodeType === 3) {
      _root.removeChild(_root.firstChild)
    }
  } catch {}
  // 兜底：确保编辑区可见且占满容器
  try {
    const pm = _root?.querySelector('.ProseMirror') as HTMLElement | null
    if (pm) {
      pm.style.display = 'block'
      pm.style.minHeight = '100%'
      pm.style.width = '100%'
      // 滚动时也刷新覆盖渲染（重定位预览块）
      try { pm.addEventListener('scroll', () => { try { scheduleOverlayRender() } catch {} }) } catch {}
    }
    const host = _root?.firstElementChild as HTMLElement | null
    if (host) {
      host.style.display = host.style.display || 'block'
      host.style.minHeight = host.style.minHeight || '100%'
      host.style.width = host.style.width || '100%'
    }
  } catch {}
  // 监听内容更新并回写给外层（用于保存与切回源码视图）
  try {
    const ctx = (editor as any).ctx
    const lm = ctx.get(listenerCtx)
    try {
      lm.docChanged((_ctx) => {
        if (_suppressInitialUpdate) return
        try { if (_writeBackTimer != null) { clearTimeout(_writeBackTimer as any); _writeBackTimer = null } } catch {}
      _writeBackTimer = window.setTimeout(async () => {
        try {
          const md = await (editor as any).action(getMarkdown())
          _lastMd = md
          _onChange?.(md)
        } catch {}
      }, 80)
      // 文档变更后，稍后刷新自动预览层
      scheduleOverlayRender()
    })
    } catch {}
    lm.markdownUpdated((_ctx, markdown) => {
      if (_suppressInitialUpdate) return
      // 统一 Windows/UNC/含空格路径的图片写法：在 Markdown 中为目标包上尖括号 <...>
      const md2 = (() => {
        try {
          return String(markdown).replace(/!\[[^\]]*\]\(([^)]+)\)/g, (m, g1) => {
            const s = String(g1 || '').trim()
            // 已经是 <...> 的不处理
            if (s.startsWith('<') && s.endsWith('>')) return m
            const dec = (() => { try { return decodeURIComponent(s) } catch { return s } })()
            const localFromFile = fromFileUri(dec)
            if (localFromFile) return m.replace(s, `<${localFromFile}>`)
            const looksLocal = /^(?:file:|[a-zA-Z]:[\\/]|\\\\|\/)/.test(dec)
            const hasSpaceOrSlash = /[\s()\\]/.test(dec)
            if (looksLocal && hasSpaceOrSlash) {
              return m.replace(s, `<${dec}>`)
            }
            return m
          })
        } catch { return markdown }
      })()
      _lastMd = md2
      try { _onChange?.(md2) } catch {}
      try { setTimeout(() => { try { rewriteLocalImagesToAsset() } catch {} }, 0) } catch {}
      // Markdown 更新时，也刷新增强渲染
      scheduleOverlayRender()
    })
  } catch {}
  _suppressInitialUpdate = false
  _editor = editor
}

export async function disableWysiwygV2() {  try {
    if (_editor) {
      try { const mdNow = await (_editor as any).action(getMarkdown()) ; _lastMd = mdNow; _onChange?.(mdNow) } catch {}
    }
  } catch {}
  try { if (_imgObserver) { _imgObserver.disconnect(); _imgObserver = null } } catch {}
  try { if (_overlayHost && _overlayHost.parentElement) { _overlayHost.parentElement.removeChild(_overlayHost); _overlayHost = null } } catch {}
  if (_editor) {
    try { await _editor.destroy() } catch {}
    _editor = null
  }
  try {
    // 隐藏并移除根节点，避免覆盖层残留拦截点击
    const host = document.getElementById('md-wysiwyg-root') as HTMLElement | null
    if (host) {
      try { host.style.display = 'none' } catch {}
      try { host.innerHTML = '' } catch {}
      try { host.parentElement?.removeChild(host) } catch {}
    }
  } catch {}
  _root = null
  _onChange = null
}

export function isWysiwygV2Enabled(): boolean { return !!_editor }

// 供外部调用：将整个文档替换为指定 Markdown（简易接口）
export async function wysiwygV2ReplaceAll(markdown: string) {
  if (!_editor) return
  try { await _editor.action(replaceAll(markdown)) } catch {}
}

// =============== 自动渲染覆盖层：Mermaid 代码块 + $$...$$ 数学块 ===============
function scheduleOverlayRender() {
  try { if (_overlayTimer != null) { clearTimeout(_overlayTimer); _overlayTimer = null } } catch {}
  _overlayTimer = window.setTimeout(() => { try { renderOverlaysNow() } catch {} }, 120)
}

function getHost(): HTMLElement | null {
  try {
    const host0 = _root as HTMLElement | null
    return (host0?.querySelector('.ProseMirror') as HTMLElement | null) || host0
  } catch { return null }
}

function ensureOverlayHost(): HTMLDivElement | null {
  try {
    const root = _root
    if (!root) return null
    if (_overlayHost && _overlayHost.parentElement) return _overlayHost
    const ov = document.createElement('div')
    ov.className = 'overlay-host'
    ov.style.position = 'absolute'
    ov.style.inset = '0'
    ov.style.zIndex = '5'
    ov.style.pointerEvents = 'none'
    root.appendChild(ov)
    _overlayHost = ov
    return ov
  } catch { return null }
}

async function renderMermaidInto(el: HTMLDivElement, code: string) {
  try {
    const mod: any = await import('mermaid')
    const mermaid = mod?.default || mod
    try { mermaid.initialize?.({ startOnLoad: false, securityLevel: 'loose', theme: 'default' }) } catch {}
    const id = 'mmd-' + Math.random().toString(36).slice(2)
    const { svg } = await mermaid.render(id, code || '')
    el.innerHTML = svg
  } catch (e) {
    el.innerHTML = `<div style="color:crimson;">Mermaid 渲染失败：${(e as any)?.message || e}</div>`
  }
}

async function renderKatexInto(el: HTMLDivElement, src: string, display: boolean) {
  try {
    const mod: any = await import('katex')
    const katex = mod?.default || mod
    katex.render(src || '', el, { displayMode: !!display, throwOnError: false, output: 'html' })
  } catch (e) {
    el.innerHTML = `<div style=\"color:crimson;\">KaTeX 渲染失败：${(e as any)?.message || e}</div>`
  }
}

function renderOverlaysNow() {
  const host = getHost()
  const ov = ensureOverlayHost()
  if (!host || !ov) return
  try { ov.innerHTML = '' } catch {}
  // 清理上一次为预览预留的 margin 空间
  try { Array.from(host.querySelectorAll('[data-ov-mb]')).forEach((el) => { try { (el as HTMLElement).style.marginBottom = ''; (el as HTMLElement).removeAttribute('data-ov-mb') } catch {} }) } catch {}
  const hostRc = (_root as HTMLElement).getBoundingClientRect()
  const addOverlay = (rect: DOMRect, cls: string, render: (el: HTMLDivElement)=>void) => {
    const wrap = document.createElement('div')
    wrap.className = cls
    wrap.style.position = 'absolute'
    wrap.style.left = Math.max(0, rect.left - hostRc.left) + 'px'
    wrap.style.top = Math.max(0, rect.bottom - hostRc.top + 4) + 'px'
    wrap.style.width = Math.max(10, rect.width) + 'px'
    wrap.style.pointerEvents = 'none'
    const inner = document.createElement('div')
    inner.style.pointerEvents = 'auto'
    inner.style.background = 'var(--bg)'
    inner.style.borderRadius = '8px'
    inner.style.padding = '6px'
    inner.style.border = '1px solid var(--border-strong)'
    wrap.appendChild(inner)
    ov.appendChild(wrap)
    render(inner)
  }
  // Mermaid blocks
  Array.from(host.querySelectorAll('pre')).forEach((pre) => {
    try {
      const codeEl = (pre as HTMLElement).querySelector('code') as HTMLElement | null
      const langFromClass = codeEl ? /\blanguage-([\w-]+)\b/.exec(codeEl.className || '')?.[1] : ''
      const langFromAttr = ((pre as HTMLElement).getAttribute('data-language') || (pre as HTMLElement).getAttribute('data-lang') || '').toLowerCase()
      const lang = (langFromAttr || langFromClass || '').toLowerCase()
      if (lang !== 'mermaid') return
      const code = (codeEl?.textContent || '').trim()
      const rc = (pre as HTMLElement).getBoundingClientRect()
      addOverlay(rc, 'ov-mermaid', (pane) => {
        void (async () => {
          await renderMermaidInto(pane, code)
          // 渲染完成后根据实际高度为源码块留出空间，避免遮挡下面文本
          try {
            const update = () => {
              const h = pane.offsetHeight
              ;(pre as HTMLElement).style.paddingBottom = Math.max(8, h + 8) + 'px'
              ;(pre as HTMLElement).setAttribute('data-ov-mb', '1')
            }
            // 下一帧测量，确保布局已更新
            try { requestAnimationFrame(update) } catch { update() }
          } catch {}
        })()
      })
    } catch {}
  })
  // Block math $$...$$ overlays
  Array.from(host.querySelectorAll('p,li,div')).forEach((el) => {
    try {
      if ((el as HTMLElement).closest('pre')) return
      const text = el.textContent || ''
      const m = text.match(/\$\$([\s\S]+?)\$\$/)
      if (!m || !m[1]) return
      const src = (m[1] || '').trim()
      const rc = (el as HTMLElement).getBoundingClientRect()
      addOverlay(rc, 'ov-katex', (pane) => {
        void (async () => {
          await renderKatexInto(pane, src, true)
          try {
            const update = () => {
              const h = pane.offsetHeight
              ;(el as HTMLElement).style.paddingBottom = Math.max(8, h + 8) + 'px'
              ;(el as HTMLElement).setAttribute('data-ov-mb', '1')
            }
            try { requestAnimationFrame(update) } catch { update() }
          } catch {}
        })()
      })
    } catch {}
  })
}

// =============== 所见模式：编辑命令桥接（加粗/斜体/链接） ===============
export async function wysiwygV2ToggleBold() {
  if (!_editor) return
  const { toggleStrongCommand } = await import('@milkdown/preset-commonmark')
  await _editor.action((ctx) => { ctx.get(commandsCtx).call((toggleStrongCommand as any).key) })
}
export async function wysiwygV2ToggleItalic() {
  if (!_editor) return
  const { toggleEmphasisCommand } = await import('@milkdown/preset-commonmark')
  await _editor.action((ctx) => { ctx.get(commandsCtx).call((toggleEmphasisCommand as any).key) })
}
export async function wysiwygV2ApplyLink(href: string, title?: string) {
  if (!_editor) return
  const { toggleLinkCommand, updateLinkCommand } = await import('@milkdown/preset-commonmark')
  await _editor.action((ctx) => {
    const commands = ctx.get(commandsCtx)
    // 优先：若有选区，切换/更新链接
    if (!commands.call((toggleLinkCommand as any).key, { href, title })) {
      // 兜底：尝试更新当前链接 mark（如果光标处已有）
      commands.call((updateLinkCommand as any).key, { href, title })
    }
  })
}






