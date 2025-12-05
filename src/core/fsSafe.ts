// 通用文件系统安全操作封装（与 UI 解耦，只做路径与读写）

import { mkdir, rename, readFile, writeFile, remove } from '@tauri-apps/plugin-fs'

// 统一路径分隔符（在当前平台风格下清洗多余分隔符）
export function normSep(p: string): string {
  return p.replace(/[\\/]+/g, p.includes('\\') ? '\\' : '/')
}

// 判断 p 是否位于 root 之内（大小写不敏感，按规范化路径前缀判断）
export function isInside(root: string, p: string): boolean {
  try {
    const r = normSep(root).toLowerCase()
    const q = normSep(p).toLowerCase()
    const base = r.endsWith('/') || r.endsWith('\\') ? r : r + (r.includes('\\') ? '\\' : '/')
    return q.startsWith(base)
  } catch {
    return false
  }
}

// 确保目录存在（递归创建）
export async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true } as any)
  } catch {}
}

// 安全移动文件：优先尝试 rename，失败则回退到复制+删除
export async function moveFileSafe(src: string, dst: string): Promise<void> {
  try {
    await rename(src, dst)
  } catch {
    const data = await readFile(src)
    await ensureDir(dst.replace(/[\\/][^\\/]*$/, ''))
    await writeFile(dst, data as any)
    try {
      await remove(src)
    } catch {}
  }
}

// 安全重命名：在同一目录内构造新路径并调用 moveFileSafe
export async function renameFileSafe(p: string, newName: string): Promise<string> {
  const base = p.replace(/[\\/][^\\/]*$/, '')
  const dst = base + (base.includes('\\') ? '\\' : '/') + newName
  await moveFileSafe(p, dst)
  return dst
}

