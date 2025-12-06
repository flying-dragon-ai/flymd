// 核心扩展管理：自动安装等（无 UI 依赖）
// 从 main.ts 拆分，负责：
// - 核心扩展状态持久化（如 AI 助手）
// - 启动后自动安装/激活核心扩展

import type { Store } from '@tauri-apps/plugin-store'
import {
  loadInstalledPlugins,
  installPluginFromGitCore,
  type InstalledPlugin,
} from './runtime'
import { logInfo } from '../core/logger'

type CoreExtensionState = 'pending' | 'installed' | 'blocked'

const CORE_EXT_STATE_KEY = 'coreExtensions:autoInstall'
export const CORE_AI_EXTENSION_ID = 'ai-assistant'
const CORE_AI_MANIFEST_URL =
  'https://raw.githubusercontent.com/flyhunterl/flymd/main/public/plugins/ai-assistant/manifest.json'

async function getCoreExtensionStateMap(
  store: Store | null,
): Promise<Record<string, CoreExtensionState>> {
  try {
    if (!store) return {}
    const raw = await store.get(CORE_EXT_STATE_KEY)
    if (raw && typeof raw === 'object') {
      const next: Record<string, CoreExtensionState> = {}
      for (const [key, val] of Object.entries(
        raw as Record<string, unknown>,
      )) {
        if (val === 'blocked' || val === 'installed' || val === 'pending') {
          next[key] = val
        }
      }
      return next
    }
  } catch {}
  return {}
}

async function setCoreExtensionStateMap(
  store: Store | null,
  map: Record<string, CoreExtensionState>,
): Promise<void> {
  try {
    if (!store) return
    await store.set(CORE_EXT_STATE_KEY, map)
    await store.save()
  } catch {}
}

async function getCoreExtensionState(
  store: Store | null,
  id: string,
): Promise<CoreExtensionState> {
  const map = await getCoreExtensionStateMap(store)
  return map[id] ?? 'pending'
}

async function setCoreExtensionState(
  store: Store | null,
  id: string,
  state: CoreExtensionState,
): Promise<void> {
  try {
    if (!store) return
    const map = await getCoreExtensionStateMap(store)
    if (map[id] === state) return
    map[id] = state
    await setCoreExtensionStateMap(store, map)
  } catch {}
}

export async function markCoreExtensionBlocked(
  store: Store | null,
  id: string,
): Promise<void> {
  await setCoreExtensionState(store, id, 'blocked')
}

export async function ensureAiAssistantAutoInstall(
  store: Store | null,
  appVersion: string,
  activatePlugin: (p: InstalledPlugin) => Promise<void>,
): Promise<void> {
  try {
    if (!store) return
    const state = await getCoreExtensionState(store, CORE_AI_EXTENSION_ID)
    if (state === 'blocked') return

    const installed = await loadInstalledPlugins(store)
    if (installed[CORE_AI_EXTENSION_ID]) {
      if (state !== 'installed') {
        await setCoreExtensionState(store, CORE_AI_EXTENSION_ID, 'installed')
      }
      return
    }

    await setCoreExtensionState(store, CORE_AI_EXTENSION_ID, 'pending')
    const rec = await installPluginFromGitCore(
      CORE_AI_MANIFEST_URL,
      undefined,
      { appVersion, store },
    )
    await activatePlugin(rec)
    await setCoreExtensionState(store, CORE_AI_EXTENSION_ID, 'installed')
    try {
      logInfo('AI 助手扩展已自动安装')
    } catch {}
  } catch (error) {
    console.warn('[CoreExt] 自动安装 AI 助手失败', error)
  }
}

export async function ensureCoreExtensionsAfterStartup(
  store: Store | null,
  appVersion: string,
  activatePlugin: (p: InstalledPlugin) => Promise<void>,
): Promise<void> {
  await ensureAiAssistantAutoInstall(store, appVersion, activatePlugin)
}

