// Milkdown Math 插件：修复 KaTeX 渲染时显示源代码的问题
import { $view } from '@milkdown/utils'
import { mathInlineSchema, mathBlockSchema } from '@milkdown/plugin-math'
import type { Node } from '@milkdown/prose/model'
import type { EditorView, NodeView } from '@milkdown/prose/view'
import { normalizeKatexLatexForInline } from '../../../utils/katexNormalize'

// 所见模式的大文档性能关键点：不要在主线程里同步渲染一堆 KaTeX。
// 这里采用“空闲时渲染 + 有输入就让路 + 小公式缓存”的策略，避免右键/按钮点击被卡住。
let _katexReady: Promise<any> | null = null
const _katexHtmlCache = new Map<string, string>()
const KATEX_HTML_CACHE_MAX = 1500
const KATEX_HTML_CACHE_MAX_LATEX_LEN = 512
let _mathIO: IntersectionObserver | null = null
const _mathIOHandlers = new WeakMap<Element, () => void>()

function isInputPendingCompat(): boolean {
  try {
    const fn = (navigator as any)?.scheduling?.isInputPending
    if (typeof fn === 'function') return !!fn.call((navigator as any).scheduling)
  } catch {}
  return false
}

function requestIdleCompat(cb: (deadline?: any) => void, timeout = 200) {
  try {
    const ric: any = (globalThis as any).requestIdleCallback
    if (typeof ric === 'function') return ric(cb, { timeout })
  } catch {}
  return setTimeout(() => cb(undefined), 16) as any
}

async function ensureKatexReady(): Promise<any> {
  if (_katexReady) return _katexReady
  _katexReady = (async () => {
    // KaTeX 与 mhchem 只需要加载一次；动态导入是为了不影响无公式文档的启动速度。
    const [katex] = await Promise.all([
      import('katex'),
      import('katex/contrib/mhchem'),
      import('katex/dist/katex.min.css'),
    ])
    return katex
  })()
  return _katexReady
}

function renderKatexToHtmlCached(katexMod: any, latex: string, displayMode: boolean): string {
  const src = latex || ''
  const canCache = src.length > 0 && src.length <= KATEX_HTML_CACHE_MAX_LATEX_LEN
  const key = canCache ? `${displayMode ? 'B' : 'I'}:${src}` : ''
  if (canCache) {
    const hit = _katexHtmlCache.get(key)
    if (hit != null) return hit
  }
  const html = katexMod.default.renderToString(src, {
    throwOnError: false,
    displayMode,
    strict: 'ignore',
  })
  if (canCache) {
    if (_katexHtmlCache.size >= KATEX_HTML_CACHE_MAX) _katexHtmlCache.clear()
    _katexHtmlCache.set(key, html)
  }
  return html
}

function observeMathOnce(el: Element, onVisible: () => void) {
  try {
    const IO: any = (globalThis as any).IntersectionObserver
    if (typeof IO !== 'function') { onVisible(); return }
    if (!_mathIO) {
      _mathIO = new IO((entries: any[]) => {
        for (const ent of entries || []) {
          try {
            if (!ent || !ent.isIntersecting) continue
            const target = ent.target as Element
            const fn = _mathIOHandlers.get(target)
            if (!fn) { try { _mathIO?.unobserve(target) } catch {} ; continue }
            _mathIOHandlers.delete(target)
            try { _mathIO?.unobserve(target) } catch {}
            fn()
          } catch {}
        }
      }, { root: null, rootMargin: '800px 0px', threshold: 0 })
    }
    _mathIOHandlers.set(el, onVisible)
    _mathIO.observe(el)
  } catch {
    onVisible()
  }
}

// Math Inline NodeView
class MathInlineNodeView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement | null
  private katexContainer: HTMLElement
  private node: Node
  private renderSeq = 0

  constructor(node: Node, view: EditorView, getPos: () => number | undefined) {
    this.node = node

    // 创建外层容器
    this.dom = document.createElement('span')
    this.dom.classList.add('math-inline-wrapper')
    this.dom.dataset.type = 'math_inline'
    this.dom.style.display = 'inline-block'
    this.dom.style.position = 'relative'

    // 创建隐藏的 contentDOM（保持可编辑）
    this.contentDOM = document.createElement('span')
    this.contentDOM.style.position = 'absolute'
    this.contentDOM.style.opacity = '0'
    this.contentDOM.style.pointerEvents = 'none'
    this.contentDOM.style.width = '0'
    this.contentDOM.style.height = '0'
    this.contentDOM.style.overflow = 'hidden'
    this.dom.appendChild(this.contentDOM)

    // 创建 KaTeX 渲染容器
    this.katexContainer = document.createElement('span')
    this.katexContainer.classList.add('katex-display-inline')
    this.dom.appendChild(this.katexContainer)

    // 初始渲染
    this.scheduleRender()
  }

  private scheduleRender() {
    const seq = ++this.renderSeq
    const doRender = async () => {
      if (seq !== this.renderSeq) return
      // 用户正在输入/滚动时，先别抢 UI。
      if (isInputPendingCompat()) { requestIdleCompat(() => { void doRender() }, 200); return }
      let katex: any
      try { katex = await ensureKatexReady() } catch { return }
      if (seq !== this.renderSeq) return
      try {
        const code = this.node.textContent || ''
        const valueRaw = this.node.attrs.value || code
        const value = normalizeKatexLatexForInline(valueRaw)
        try { (this.dom as HTMLElement).dataset.value = valueRaw } catch {}

        // 使用 renderToString + innerHTML，减少 DOM 操作开销；并对小公式做缓存。
        this.katexContainer.innerHTML = renderKatexToHtmlCached(katex, value, false)
      } catch {
        try { this.katexContainer.textContent = this.node.textContent || '' } catch {}
      }
    }

    // 超大文档：只在元素进入可视区域附近再渲染，避免一次性创建几千个 KaTeX 把 UI 卡死。
    observeMathOnce(this.dom, () => { requestIdleCompat(() => { void doRender() }, 200) })
  }

  update(node: Node) {
    if (node.type !== this.node.type) return false

    const oldValue = this.node.attrs.value || this.node.textContent
    const newValue = node.attrs.value || node.textContent

    this.node = node

    if (oldValue !== newValue) {
      this.scheduleRender()
    }

    return true
  }

  ignoreMutation() {
    return true
  }

  destroy() {
    // 节点被移除时取消观察，避免观察器长期持有无用目标。
    try { _mathIOHandlers.delete(this.dom) } catch {}
    try { _mathIO?.unobserve(this.dom) } catch {}
  }
}

// Math Block NodeView
class MathBlockNodeView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement | null
  private katexContainer: HTMLElement
  private node: Node
  private renderSeq = 0

  constructor(node: Node, view: EditorView, getPos: () => number | undefined) {
    this.node = node

    // 创建外层容器
    this.dom = document.createElement('div')
    this.dom.classList.add('math-block-wrapper')
    this.dom.dataset.type = 'math_block'
    this.dom.style.margin = '1em 0'
    this.dom.style.position = 'relative'

    // 创建隐藏的 contentDOM（保持可编辑）
    this.contentDOM = document.createElement('div')
    this.contentDOM.style.position = 'absolute'
    this.contentDOM.style.opacity = '0'
    this.contentDOM.style.pointerEvents = 'none'
    this.contentDOM.style.width = '0'
    this.contentDOM.style.height = '0'
    this.contentDOM.style.overflow = 'hidden'
    this.dom.appendChild(this.contentDOM)

    // 创建 KaTeX 渲染容器
    this.katexContainer = document.createElement('div')
    this.katexContainer.classList.add('katex-display-block')
    this.katexContainer.style.textAlign = 'center'
    this.dom.appendChild(this.katexContainer)

    // 初始渲染
    this.scheduleRender()
  }

  private scheduleRender() {
    const seq = ++this.renderSeq
    const doRender = async () => {
      if (seq !== this.renderSeq) return
      if (isInputPendingCompat()) { requestIdleCompat(() => { void doRender() }, 200); return }
      let katex: any
      try { katex = await ensureKatexReady() } catch { return }
      if (seq !== this.renderSeq) return
      try {
        const valueRaw = this.node.attrs.value || this.node.textContent || ''
        const value = normalizeKatexLatexForInline(valueRaw)
        try { (this.dom as HTMLElement).dataset.value = valueRaw } catch {}
        this.katexContainer.innerHTML = renderKatexToHtmlCached(katex, value, true)
      } catch {
        try { this.katexContainer.textContent = this.node.textContent || '' } catch {}
      }
    }

    observeMathOnce(this.dom, () => { requestIdleCompat(() => { void doRender() }, 200) })
  }

  update(node: Node) {
    if (node.type !== this.node.type) return false

    const oldValue = this.node.attrs.value || this.node.textContent
    const newValue = node.attrs.value || node.textContent

    this.node = node

    if (oldValue !== newValue) {
      this.scheduleRender()
    }

    return true
  }

  ignoreMutation() {
    return true
  }

  destroy() {
    try { _mathIOHandlers.delete(this.dom) } catch {}
    try { _mathIO?.unobserve(this.dom) } catch {}
  }
}

// 创建 math inline 插件
export const mathInlineViewPlugin = $view(mathInlineSchema.node, () => {
  return (node, view, getPos) => {
    return new MathInlineNodeView(node, view, getPos as () => number | undefined)
  }
})

// 创建 math block 插件
export const mathBlockViewPlugin = $view(mathBlockSchema.node, () => {
  return (node, view, getPos) => {
    return new MathBlockNodeView(node, view, getPos as () => number | undefined)
  }
})
