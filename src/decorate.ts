// 代码块装饰：语言角标、行号与复制按钮（仅阅读模式生成行号；不改动 hljs 结构，避免 HTML 等语言错位）
export function decorateCodeBlocks(preview: HTMLElement) {
  try {
    const codes = Array.from(preview.querySelectorAll('pre > code.hljs')) as HTMLElement[]
    for (const code of codes) {
      const pre = code.parentElement as HTMLElement | null
      if (!pre || pre.getAttribute('data-codebox') === '1') continue
      if (code.classList.contains('language-mermaid')) continue

      const lang = ((Array.from(code.classList).find(c => c.startsWith('language-')) || '').slice(9) || 'text').toUpperCase()

      // 外层容器（不改动 code 内部结构）
      const box = document.createElement('div')
      box.className = 'codebox'
      if (pre.parentElement) pre.parentElement.insertBefore(box, pre)
      box.appendChild(pre)

      // 仅在阅读模式生成行号列
      let isWysiwyg = false
      try {
        const containerEl = preview.closest('.container') as HTMLElement | null
        isWysiwyg = !!(containerEl && (containerEl.classList.contains('wysiwyg') || containerEl.classList.contains('wysiwyg-v2')))
      } catch {}
      if (!isWysiwyg) {
        try {
          const raw = code.textContent || ''
          const lines = raw.endsWith('\n') ? raw.slice(0, -1).split('\n') : raw.split('\n')
          const lnWrap = document.createElement('div')
          lnWrap.className = 'code-lnums'
          lnWrap.setAttribute('aria-hidden', 'true')
          let buf = ''
          for (let i = 0; i < lines.length; i++) buf += '<span class="ln">' + (i + 1) + '</span>'
          lnWrap.innerHTML = buf
          pre.appendChild(lnWrap)
        } catch {}
      }

      // 角标与复制按钮
      const badge = document.createElement('div')
      badge.className = 'code-lang'
      badge.textContent = lang
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'code-copy'
      btn.textContent = '复制'
      box.appendChild(badge)
      box.appendChild(btn)

      pre.setAttribute('data-codebox', '1')
    }
  } catch {}
}
