// 共享 Store 单例：避免同一 settings 文件被多处 Store.load() 打开导致的“各写各的/互相覆盖”
// 原则：main.ts 负责初始化并绑定；其它模块只通过这里拿 Store。

import { Store } from '@tauri-apps/plugin-store'

let _store: Store | null = null
let _loading: Promise<Store> | null = null

export function bindSharedStore(store: Store | null): void {
  _store = store
  if (!store) _loading = null
}

export async function getSharedStore(): Promise<Store> {
  if (_store) return _store
  if (_loading) return await _loading
  _loading = (async () => {
    const s = await Store.load('flymd-settings.json')
    _store = s
    return s
  })()
  return await _loading
}

