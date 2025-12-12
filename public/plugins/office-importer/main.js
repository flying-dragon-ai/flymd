// main.js
// Word / Excel 导入工具插件
// 所有中文注释，符合项目约定

// 轻量多语言：跟随宿主（flymd.locale），默认用系统语言
const OI_LOCALE_LS_KEY = 'flymd.locale'
function oiDetectLocale() {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : null
    const lang = (nav && (nav.language || nav.userLanguage)) || 'en'
    const lower = String(lang || '').toLowerCase()
    if (lower.startsWith('zh')) return 'zh'
  } catch {}
  return 'en'
}
function oiGetLocale() {
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage : null
    const v = ls && ls.getItem(OI_LOCALE_LS_KEY)
    if (v === 'zh' || v === 'en') return v
  } catch {}
  return oiDetectLocale()
}
function oiText(zh, en) {
  return oiGetLocale() === 'en' ? en : zh
}

// 简单工具函数：弹出文件选择对话框
function pickOfficeFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.docx,.xlsx,.xls'
    input.style.display = 'none'

    input.onchange = () => {
      const file = input.files && input.files[0]
      if (!file) {
        reject(new Error(oiText('未选择文件', 'No file selected')))
      } else {
        resolve(file)
      }
      input.remove()
    }

    try {
      document.body.appendChild(input)
    } catch (e) {
      // 在极端情况下可能没有 document.body，直接失败
      reject(new Error(oiText('当前环境不支持文件选择', 'Current environment does not support file selection')))
      return
    }

    input.click()
  })
}

// 动态加载 mammoth 库，避免修改宿主应用
let mammothPromise = null
function ensureMammothLoaded(context) {
  if (window.mammoth && window.mammoth.convertToHtml) {
    return Promise.resolve(window.mammoth)
  }
  if (mammothPromise) return mammothPromise

  mammothPromise = new Promise((resolve, reject) => {
    try {
      const script = document.createElement('script')
      // 默认使用公共 CDN，如有需要可以改成你自己的服务器地址
      script.src = 'https://unpkg.com/mammoth@1.6.0/mammoth.browser.min.js'
      script.async = true
      script.onload = () => {
        if (window.mammoth && window.mammoth.convertToHtml) {
          resolve(window.mammoth)
        } else {
          reject(new Error(oiText('mammoth 加载完成但不可用', 'mammoth loaded but is not usable')))
        }
      }
      script.onerror = () => reject(new Error(oiText('无法加载 mammoth 库，请检查网络或更换镜像地址', 'Failed to load mammoth library. Please check network or use another mirror.')))
      document.head.appendChild(script)
    } catch (e) {
      reject(e)
    }
  }).catch((e) => {
    mammothPromise = null
    context.ui.notice(e.message || oiText('mammoth 加载失败', 'Failed to load mammoth'), 'err', 5000)
    throw e
  })

  return mammothPromise
}

// 动态加载 XLSX 库
let xlsxPromise = null
function ensureXlsxLoaded(context) {
  if (window.XLSX && window.XLSX.read && window.XLSX.utils) {
    return Promise.resolve(window.XLSX)
  }
  if (xlsxPromise) return xlsxPromise

  xlsxPromise = new Promise((resolve, reject) => {
    try {
      const script = document.createElement('script')
      script.src = 'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js'
      script.async = true
      script.onload = () => {
        if (window.XLSX && window.XLSX.read && window.XLSX.utils) {
          resolve(window.XLSX)
        } else {
          reject(new Error(oiText('XLSX 加载完成但不可用', 'XLSX loaded but is not usable')))
        }
      }
      script.onerror = () => reject(new Error(oiText('无法加载 XLSX 库，请检查网络或更换镜像地址', 'Failed to load XLSX library. Please check network or use another mirror.')))
      document.head.appendChild(script)
    } catch (e) {
      reject(e)
    }
  }).catch((e) => {
    xlsxPromise = null
    context.ui.notice(e.message || oiText('XLSX 加载失败', 'Failed to load XLSX'), 'err', 5000)
    throw e
  })

  return xlsxPromise
}

// Excel 工作簿转 Markdown 文本
function workbookToMarkdown(workbook) {
  // 使用最笨但清晰的方式：按顺序遍历所有工作表
  const sheetNames = workbook.SheetNames || []
  const parts = []

  sheetNames.forEach((name, index) => {
    const sheet = workbook.Sheets[name]
    if (!sheet) return

    // 读取成二维数组
    const rows = window.XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: true,
      defval: ''
    })

    if (!rows.length) return

    parts.push(`# ${oiText('工作表', 'Sheet')} ${index + 1}: ${name}`)
    parts.push('')

    // 计算列数
    let maxCols = 0
    for (const row of rows) {
      if (Array.isArray(row) && row.length > maxCols) maxCols = row.length
    }
    if (maxCols === 0) return

    // 填充行列，转为 Markdown 表格
    const header = rows[0]
    const headerLine = '|' + header.map((cell, i) => {
      const v = String(cell ?? '').trim()
      if (v) return v
      return oiText(`列${i + 1}`, `Col ${i + 1}`)
    }).join('|') + '|'
    const alignLine = '|' + new Array(maxCols).fill('---').join('|') + '|' // 全部左对齐

    parts.push(headerLine)
    parts.push(alignLine)

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]
      const cells = []
      for (let c = 0; c < maxCols; c++) {
        const v = row && row[c] != null ? row[c] : ''
        cells.push(String(v))
      }
      parts.push('|' + cells.join('|') + '|')
    }

    parts.push('')
  })

  if (!parts.length) {
    return (
      '> ' +
      oiText(
        '未在 Excel 中解析到任何有效数据。',
        'No valid data parsed from Excel.',
      )
    )
  }

  return parts.join('\n')
}

// 激活函数：注册菜单
export function activate(context) {
  // 添加一个主菜单项，下面挂子菜单，避免菜单拥挤
  context.addMenuItem({
    label: oiText('导入 Word/Excel', 'Import Word/Excel'),
    title: oiText(
      '从本地 docx/xlsx 文件转换为 Markdown 并导入',
      'Convert local docx/xlsx files to Markdown and import',
    ),
    onClick: async () => {
      let file
      try {
        file = await pickOfficeFile()
      } catch (e) {
        context.ui.notice(
          e.message || oiText('选择文件失败', 'Failed to pick file'),
          'err',
          3000,
        )
        return
      }

      if (!file) {
        context.ui.notice(
          oiText('未选择任何文件', 'No file selected'),
          'err',
          3000,
        )
        return
      }

      const name = file.name || ''
      const lower = name.toLowerCase()

      let loadingId = null
      try {
        if (context.ui.showNotification) {
          loadingId = context.ui.showNotification(
            oiText('正在解析 ', 'Parsing ') + name + ' ...',
            {
              type: 'info',
              duration: 0
            })
        } else {
          context.ui.notice(
            oiText('正在解析 ', 'Parsing ') + name + ' ...',
            'ok',
            2000,
          )
        }

        const arrayBuffer = await file.arrayBuffer()

        let md = ''

        if (lower.endsWith('.docx')) {
          // 动态确保 mammoth 已加载
          await ensureMammothLoaded(context)

          // 先转成 HTML，再用规则转 Markdown，保证可读性即可
          const result = await window.mammoth.convertToHtml({ arrayBuffer })
          const html = result && result.value ? result.value : ''
          if (!html) {
            context.ui.notice(
              oiText('未从 Word 文件中解析到内容', 'No content parsed from Word file'),
              'err',
              4000,
            )
            return
          }

          // 极简 HTML -> Markdown 转换，只处理常见结构，避免过度复杂
          md = await simpleHtmlToMarkdown(html, name, context)
        } else if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
          // 动态确保 XLSX 已加载
          await ensureXlsxLoaded(context)

          const workbook = window.XLSX.read(arrayBuffer, { type: 'array' })
          md = workbookToMarkdown(workbook)
        } else {
          context.ui.notice(
            oiText('仅支持 .docx / .xlsx / .xls 文件', 'Only .docx / .xlsx / .xls files are supported'),
            'err',
            4000,
          )
          return
        }

        if (!md || !md.trim()) {
          context.ui.notice(
            oiText('转换结果为空，未导入内容', 'Converted result is empty, nothing imported'),
            'err',
            4000,
          )
          return
        }

        // 默认策略：在当前编辑器追加导入结果，并添加分隔线
        const current = context.getEditorValue() || ''
        const prefix = current.trim().length ? current + '\n\n---\n\n' : ''
        const finalMd = prefix + md

        context.setEditorValue(finalMd)
        context.ui.notice(
          oiText('已成功导入：', 'Imported successfully: ') + name,
          'ok',
          4000,
        )
      } catch (e) {
        console.error('[office-importer] 解析失败', e)
        context.ui.notice(
          oiText('解析失败：', 'Parse failed: ') +
            (e && e.message ? e.message : String(e)),
          'err',
          5000,
        )
      } finally {
        if (loadingId && context.ui.hideNotification) {
          try {
            context.ui.hideNotification(loadingId)
          } catch (e) {
            // 忽略通知关闭错误
          }
        }
      }
    }
  })
}

export function deactivate() {
  // 当前无需特殊清理
}

// 根据 MIME 类型推断图片扩展名
function guessExtFromMime(mime) {
  const m = String(mime || '').toLowerCase()
  if (m.includes('png')) return 'png'
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg'
  if (m.includes('gif')) return 'gif'
  if (m.includes('webp')) return 'webp'
  if (m.includes('bmp')) return 'bmp'
  if (m.includes('svg')) return 'svg'
  if (m.includes('avif')) return 'avif'
  return 'bin'
}

// 将 data:URL 转换为二进制数据和建议文件名
function dataUrlToBytes(dataUrl, baseName, index) {
  const raw = String(dataUrl || '').trim()
  const m = raw.match(/^data:([^;,]+)?((?:;[^,]+)*)?,([\s\S]*)$/i)
  if (!m) {
    throw new Error(oiText('无效的 data URL', 'Invalid data URL'))
  }
  const mime = m[1] || 'application/octet-stream'
  const params = m[2] || ''
  const body = m[3] || ''
  const isBase64 = /;base64/i.test(params)

  let bytes
  if (isBase64) {
    const clean = body.replace(/\s+/g, '')
    let bin = ''
    if (typeof atob === 'function') {
      bin = atob(clean)
    } else if (typeof Buffer !== 'undefined') {
      bin = Buffer.from(clean, 'base64').toString('binary')
    } else {
      throw new Error(
        oiText('当前环境不支持 base64 解码', 'Base64 decoding not supported in this environment'),
      )
    }
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) {
      arr[i] = bin.charCodeAt(i) & 0xff
    }
    bytes = arr
  } else {
    const decoded = decodeURIComponent(body.replace(/\s+/g, ''))
    if (typeof TextEncoder !== 'undefined') {
      bytes = new TextEncoder().encode(decoded)
    } else {
      const arr = new Uint8Array(decoded.length)
      for (let i = 0; i < decoded.length; i++) {
        arr[i] = decoded.charCodeAt(i) & 0xff
      }
      bytes = arr
    }
  }

  const ext = guessExtFromMime(mime)
  const safeBase =
    (baseName && String(baseName).trim().replace(/[\\/:*?"<>|]+/g, '_')) || 'image'
  const idxStr = String(index || 1).padStart(3, '0')
  const fileName = `${safeBase}-${idxStr}.${ext}`
  return { data: bytes, fileName }
}

// 极简 HTML -> Markdown 转换
// 目标：把 Word 常见结构（标题、段落、粗体、斜体、列表、图片、链接）转成可读 Markdown，而不是完美还原
async function simpleHtmlToMarkdown(html, fileName, context) {
  let text = String(html || '')

  // 提前处理图片：使用占位符存起来，后面统一落地为本地文件
  const images = []
  text = text.replace(/<img[^>]*>/gi, (m) => {
    const srcMatch = m.match(/src=["']([^"']+)["']/i)
    if (!srcMatch) return ''
    const altMatch = m.match(/alt=["']([^"']*)["']/i)
    const src = srcMatch[1]
    const alt = altMatch ? altMatch[1] : ''
    const placeholder = `__OFFICE_IMG_${images.length}__`
    images.push({ placeholder, src, alt })
    return placeholder
  })

  // 替换换行，避免出现一长行
  text = text.replace(/<br\s*\/?>(\r?\n)?/gi, '\n')

  // 标题：h1-h6
  for (let level = 6; level >= 1; level--) {
    const re = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi')
    text = text.replace(re, (_m, inner) => {
      const prefix = '#'.repeat(level)
      return `\n${prefix} ${inner.trim()}\n`
    })
  }

  // 无序列表
  text = text.replace(/<ul[^>]*>[\s\S]*?<\/ul>/gi, (m) => {
    return m
      .replace(/<ul[^>]*>/gi, '')
      .replace(/<\/ul>/gi, '')
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m2, item) => `- ${item.trim()}\n`)
  })

  // 有序列表
  text = text.replace(/<ol[^>]*>[\s\S]*?<\/ol>/gi, (m) => {
    let idx = 1
    return m
      .replace(/<ol[^>]*>/gi, '')
      .replace(/<\/ol>/gi, '')
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m2, item) => {
        const n = idx++
        return `${n}. ${item.trim()}\n`
      })
  })

  // 加粗/斜体
  text = text.replace(/<(b|strong)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
  text = text.replace(/<(i|em)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')

  // 超链接
  text = text.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
    const label = String(inner || '').trim() || href
    return `[${label}](${href})`
  })

  // 段落
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')

  // 表格：尽量还原为 Markdown 真表格
  text = text.replace(/<table[\s\S]*?<\/table>/gi, (m) => {
    const rows = []
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
    let trMatch
    while ((trMatch = trRe.exec(m))) {
      const trInner = trMatch[1] || ''
      const cells = []
      const cellRe = /<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi
      let cellMatch
      while ((cellMatch = cellRe.exec(trInner))) {
        let cell = cellMatch[2] || ''
        // 去掉单元格内部标签，只保留文本和前面已经转好的 Markdown 标记
        cell = cell.replace(/<[^>]+>/g, ' ')
        cell = cell.replace(/\s+/g, ' ').trim()
        cells.push(cell)
      }
      if (cells.length) rows.push(cells)
    }

    if (!rows.length) return ''

    // 计算列数
    let maxCols = 0
    for (const r of rows) {
      if (Array.isArray(r) && r.length > maxCols) maxCols = r.length
    }
    if (!maxCols) return ''

    const lines = []

    // 表头行：使用第一行，如果为空则用“列1/列2...”占位
    const header = rows[0]
    const headerCells = []
    for (let c = 0; c < maxCols; c++) {
      const v = header[c]
      headerCells.push((v && v.trim()) || `列${c + 1}`)
    }
    const headerLine = '|' + headerCells.join('|') + '|'
    const alignLine = '|' + new Array(maxCols).fill('---').join('|') + '|'
    lines.push(headerLine)
    lines.push(alignLine)

    // 数据行
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]
      const cellsOut = []
      for (let c = 0; c < maxCols; c++) {
        const v = row[c] != null ? row[c] : ''
        cellsOut.push(String(v))
      }
      lines.push('|' + cellsOut.join('|') + '|')
    }

    return '\n' + lines.join('\n') + '\n'
  })

  // 去掉所有剩余标签
  text = text.replace(/<[^>]+>/g, '')

  // 将图片占位符替换为 Markdown，并尽量写到本地 images 目录
  if (images.length) {
    const hasSaveBinary =
      context && typeof context.saveBinaryToCurrentFolder === 'function'
    const hasDownload =
      context && typeof context.downloadFileToCurrentFolder === 'function'
    const baseRaw =
      (fileName && typeof fileName === 'string' && fileName.trim()) || 'image'
    const safeBase =
      baseRaw.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_') || 'image'

    for (let i = 0; i < images.length; i++) {
      const info = images[i]
      let target = info.src
      try {
        if (hasSaveBinary && /^data:/i.test(info.src)) {
          const parsed = dataUrlToBytes(info.src, safeBase, i + 1)
          if (parsed && parsed.data && parsed.data.length) {
            const saved = await context.saveBinaryToCurrentFolder({
              fileName: parsed.fileName,
              data: parsed.data,
              subDir: 'images',
              onConflict: 'renameAuto'
            })
            if (saved && (saved.fullPath || saved.relativePath)) {
              target = (saved.fullPath || saved.relativePath).replace(/\\/g, '/')
            }
          }
        } else if (hasDownload && /^https?:\/\//i.test(info.src)) {
          const suggested = `${safeBase}-${String(i + 1).padStart(3, '0')}.png`
          const saved = await context.downloadFileToCurrentFolder({
            url: info.src,
            fileName: suggested,
            subDir: 'images',
            onConflict: 'renameAuto'
          })
          if (saved && (saved.fullPath || saved.relativePath)) {
            target = (saved.fullPath || saved.relativePath).replace(/\\/g, '/')
          }
        }
      } catch (e) {
        // 单个图片失败不影响整体流程，保留原始 src
        console.error('[office-importer] 保存图片失败', e)
      }
      const alt = String(info.alt || '').replace(/]/g, '\\]')
      const needsAngle = /\s|\(|\)/.test(target)
      const wrappedSrc = needsAngle ? '<' + target + '>' : target
      const mdImg = `![${alt}](${wrappedSrc})`
      if (text.indexOf(info.placeholder) >= 0) {
        text = text.split(info.placeholder).join(mdImg)
      } else {
        text += '\n\n' + mdImg + '\n'
      }
    }
  }

  // 合理压缩空行
  text = text.replace(/\n{3,}/g, '\n\n').trim()

  // 在开头加一行来源说明，方便用户知道这是导入结果
  const header = `> ${oiText('本文档由 Word 文件导入：', 'Document imported from Word file: ')}${fileName || ''}`.trim()
  return header + '\n\n' + text + '\n'
}
