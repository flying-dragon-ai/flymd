/**
 * Mermaid 图表工具模块
 * 从 main.ts 拆分，包含缩放、导出、缓存等功能
 */

import { save } from '@tauri-apps/plugin-dialog'
import { writeTextFile, writeFile } from '@tauri-apps/plugin-fs'

// Mermaid 缓存开关：默认暂时关闭缓存以排查"图片很小"的问题；可用 localStorage 覆盖
const DISABLE_MERMAID_CACHE_DEFAULT = false

export function isMermaidCacheDisabled(): boolean {
  try {
    const v = localStorage.getItem('flymd:disableMermaidCache')
    if (v === '1' || (v || '').toLowerCase() === 'true') return true
    if (v === '0' || (v || '').toLowerCase() === 'false') return false
  } catch {}
  return DISABLE_MERMAID_CACHE_DEFAULT
}

export function getMermaidScale(): number {
  try {
    const v = localStorage.getItem('flymd:mermaidScale')
    const n = v ? parseFloat(v) : NaN
    if (Number.isFinite(n) && n > 0 && n < 10) return n
  } catch {}
  // 默认缩放改为 0.75
  return 0.75
}

// Mermaid 缩放参数（按钮步进与范围）
export const MERMAID_SCALE_MIN = 0.3
export const MERMAID_SCALE_MAX = 3.0
export const MERMAID_SCALE_STEP = 0.1

function clamp(n: number, a: number, b: number): number { return Math.max(a, Math.min(b, n)) }

export function setMermaidScaleClamped(next: number): void {
  try {
    const z = clamp(Math.round(next * 100) / 100, MERMAID_SCALE_MIN, MERMAID_SCALE_MAX)
    try { localStorage.setItem('flymd:mermaidScale', String(z)) } catch {}
    try { adjustExistingMermaidSvgsForScale() } catch {}
  } catch {}
}

export function adjustExistingMermaidSvgsForScale(): void {
  try {
    const scale = getMermaidScale()
    const svgs = Array.from(document.querySelectorAll(
      '.preview-body .mmd-figure > svg, .preview-body svg[data-mmd-hash], .preview-body .mermaid svg, #md-wysiwyg-root .ov-mermaid svg, #md-wysiwyg-root .mmd-figure > svg, #md-wysiwyg-root .mermaid-chart-display svg'
    )) as SVGElement[]
    for (const svgEl of svgs) {
      try {
        let vw = 0
        const vb = (svgEl.getAttribute('viewBox') || '').trim()
        if (vb) {
          const parts = vb.split(/\s+/)
          const w = parseFloat(parts[2] || '')
          const h = parseFloat(parts[3] || '')
          if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) vw = w
        }
        if (!vw) {
          try { const bb = (svgEl as any).getBBox ? (svgEl as any).getBBox() : null; if (bb && bb.width > 0) vw = bb.width } catch {}
        }
        const host = (svgEl.closest('.preview-body') as HTMLElement | null) || (svgEl.parentElement as HTMLElement | null)
        const pbW = Math.max(0, host?.clientWidth || 0)
        const base = vw ? (pbW > 0 ? Math.min(Math.ceil(pbW), vw) : vw) : pbW
        const finalW = Math.max(10, Math.round(base * (Number.isFinite(scale) && scale > 0 ? scale : 1)))
        ;(svgEl.style as any).width = finalW + 'px'
      } catch {}
    }
  } catch {}
}

export async function exportMermaidViaDialog(svgEl: SVGElement): Promise<void> {
  try {
    const getDims = (): { vw: number; vh: number } => {
      try {
        const vb = (svgEl.getAttribute('viewBox') || '').trim().split(/\s+/)
        const vw = parseFloat(vb[2] || '')
        const vh = parseFloat(vb[3] || '')
        if (Number.isFinite(vw) && Number.isFinite(vh) && vw > 0 && vh > 0) return { vw, vh }
      } catch {}
      try { const bb = (svgEl as any).getBBox ? (svgEl as any).getBBox() : null; if (bb && bb.width > 0 && bb.height > 0) return { vw: bb.width, vh: bb.height } } catch {}
      return { vw: 800, vh: 600 }
    }
    const dims = getDims()
    const scale = (() => { try { const n = getMermaidScale(); return (Number.isFinite(n) && n > 0) ? n : 1 } catch { return 1 } })()
    const pngW = Math.max(10, Math.round(dims.vw * scale))
    const pngH = Math.max(10, Math.round(dims.vh * scale))

    const path = await save({
      defaultPath: 'mermaid.svg',
      filters: [ { name: 'SVG', extensions: ['svg'] } ] as any
    } as any)
    if (!path) return
    const lower = String(path).toLowerCase()
    const fmt: 'svg' | 'png' = 'svg'

    if (fmt === 'svg') {
      const clone = svgEl.cloneNode(true) as SVGElement
      try { if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg') } catch {}
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` + new XMLSerializer().serializeToString(clone)
      await writeTextFile(path, xml)
    } else {
      const clone = svgEl.cloneNode(true) as SVGElement
      try { if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg') } catch {}
      const svgText = new XMLSerializer().serializeToString(clone)
      const canvas = document.createElement('canvas')
      canvas.width = pngW
      canvas.height = pngH
      const ctx = canvas.getContext('2d')!
      try {
        const mod: any = await import('canvg')
        const Canvg = (mod && (mod.Canvg || (mod.default && mod.default.Canvg))) ? (mod.Canvg || mod.default.Canvg) : (mod.Canvg || mod.default)
        const v = await Canvg.fromString(ctx, svgText, { ignoreMouse: true, ignoreAnimation: true, useCORS: true })
        await v.render()
      } catch (e) {
        // 兜底：如 canvg 不可用，回退到 Image 路线（可能受安全限制）
        try {
          const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const img = new Image()
          await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = (err) => reject(err); img.src = url })
          try { URL.revokeObjectURL(url) } catch {}
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        } catch (e2) {
          console.error('导出 PNG 回退失败', e2)
          throw e
        }
      }
      const dataUrl = canvas.toDataURL('image/png')
      const b64 = dataUrl.split(',')[1] || ''
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      await writeFile(path, bytes)
    }
  } catch (e) {
    console.error('导出 Mermaid 失败', e)
  }
}

export function createMermaidToolsFor(svgEl: SVGElement): HTMLDivElement {
  const tools = document.createElement('div')
  tools.className = 'mmd-tools'
  const row1 = document.createElement('div')
  row1.className = 'tools-row'
  const row2 = document.createElement('div')
  row2.className = 'tools-row'
  const btnOut = document.createElement('button')
  btnOut.textContent = '-'
  const btnIn = document.createElement('button')
  btnIn.textContent = '+'
  const btnReset = document.createElement('button')
  btnReset.textContent = 'R'
  row1.appendChild(btnOut)
  row1.appendChild(btnIn)
  row1.appendChild(btnReset)
  const btnExport = document.createElement('button')
  btnExport.textContent = 'export'
  row2.appendChild(btnExport)
  tools.appendChild(row1)
  tools.appendChild(row2)
  try { btnOut.title = 'Mermaid 缩小' } catch {}
  try { btnIn.title = 'Mermaid 放大' } catch {}
  try { btnReset.title = 'Mermaid 重置为100%' } catch {}
  try { btnExport.title = '导出（SVG）' } catch {}
  const step = MERMAID_SCALE_STEP
  btnOut.addEventListener('click', (ev) => { ev.stopPropagation(); try {
    const cur = getMermaidScale(); const next = Math.max(MERMAID_SCALE_MIN, Math.round((cur - step) * 100) / 100)
    ;(window as any).setMermaidScale ? (window as any).setMermaidScale(next) : setMermaidScaleClamped(next)
  } catch {} })
  btnIn.addEventListener('click', (ev) => { ev.stopPropagation(); try {
    const cur = getMermaidScale(); const next = Math.min(MERMAID_SCALE_MAX, Math.round((cur + step) * 100) / 100)
    ;(window as any).setMermaidScale ? (window as any).setMermaidScale(next) : setMermaidScaleClamped(next)
  } catch {} })
  btnReset.addEventListener('click', (ev) => { ev.stopPropagation(); try {
    const next = 1.0
    ;(window as any).setMermaidScale ? (window as any).setMermaidScale(next) : setMermaidScaleClamped(next)
  } catch {} })
  btnExport.addEventListener('click', (ev) => { ev.stopPropagation(); try {
    const el = svgEl || (tools.closest('.mmd-figure')?.querySelector('svg') as SVGElement | null)
    if (el) void exportMermaidViaDialog(el)
  } catch {} })
  return tools
}

// Mermaid 渲染缓存（按源代码文本缓存 SVG，避免重复渲染导致布局抖动）
export const mermaidSvgCache = new Map<string, { svg: string; renderId: string }>()
export let mermaidSvgCacheVersion = 0

export function getCachedMermaidSvg(code: string, desiredId: string): string | null {
  try {
    if (isMermaidCacheDisabled()) return null
    const cached = mermaidSvgCache.get(code)
    if (!cached || !cached.renderId || !cached.svg) return null
    if (!cached.svg.includes('<svg')) return null
    // 将缓存中的旧 ID 替换为当前渲染需要的新 ID，确保 DOM 中 ID 唯一
    return cached.svg.split(cached.renderId).join(desiredId)
  } catch {
    return null
  }
}

export function cacheMermaidSvg(code: string, svg: string, renderId: string) {
  try {
    if (isMermaidCacheDisabled()) return
    if (!code || !svg || !renderId) return
    mermaidSvgCache.set(code, { svg, renderId })
  } catch {}
}

// 规范化 Mermaid 生成的 SVG：保证在不同环境下按容器宽度自适应
export function normalizeMermaidSvg(svgEl: SVGElement) {
  try {
    try { (svgEl.style as any).display = 'block'; (svgEl.style as any).maxWidth = '100%'; (svgEl.style as any).height = 'auto'; (svgEl.style as any).overflow = 'visible' } catch {}
    try { if (!svgEl.getAttribute('preserveAspectRatio')) svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet') } catch {}
    try {
      const vb = svgEl.getAttribute('viewBox') || ''
      if (!/(\d|\s)\s*(\d|\s)/.test(vb)) {
        const w = parseFloat(svgEl.getAttribute('width') || '')
        const h = parseFloat(svgEl.getAttribute('height') || '')
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`)
      }
    } catch {}
    try { if (svgEl.hasAttribute('width')) svgEl.removeAttribute('width') } catch {}
    try { if (svgEl.hasAttribute('height')) svgEl.removeAttribute('height') } catch {}
  } catch {}
}

// 插入到 DOM 之后再做一次自适应校正：
// 如果 viewBox 非常大而容器较小，强制用实际内容 bbox 重置 viewBox，避免"看起来很小"。
export function postAttachMermaidSvgAdjust(svgEl: SVGElement) {
  try {
    // 放到 DOM 后统一用内容 bbox 重置 viewBox，确保按内容尺寸自适应
    setTimeout(() => {
      try {
        const bb = (svgEl as any).getBBox ? (svgEl as any).getBBox() : null
        if (bb && isFinite(bb.width) && isFinite(bb.height) && bb.width > 0 && bb.height > 0) {
          const pad = (() => { try { return Math.max(2, Math.min(24, Math.round(Math.max(bb.width, bb.height) * 0.02))) } catch { return 8 } })()
          const vx = Math.floor(bb.x) - pad
          const vy = Math.floor(bb.y) - pad
          const vw = Math.ceil(bb.width) + pad * 2
          const vh = Math.ceil(bb.height) + pad * 2
          svgEl.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`)
          // 宽度采用"内容宽度与容器宽度取最小"，避免过大或过小
          try {
            const pb = (svgEl.closest('.preview-body') as HTMLElement | null) || (svgEl.parentElement as HTMLElement | null)
            const pbW = Math.max(0, pb?.clientWidth || 0)
            const targetW = vw
            const scale = getMermaidScale()
            const base = pbW > 0 ? Math.min(Math.ceil(pbW), targetW) : targetW
            const finalW = Math.max(10, Math.round(base * (Number.isFinite(scale) && scale > 0 ? scale : 1)))
            ;(svgEl.style as any).width = finalW + 'px'
          } catch {}
        }
      } catch {}
    }, 0)
  } catch {}
}

export function invalidateMermaidSvgCache(reason?: string) {
  try {
    mermaidSvgCache.clear()
    mermaidSvgCacheVersion++
    console.log('Mermaid 缓存已清空', reason || '')
  } catch {}
}
