/**
 * 多标签系统模块入口
 */

export * from './types'
export { TabManager, tabManager } from './TabManager'
export { TabBar } from './TabBar'
export { initTabSystem, shouldOpenInNewTab, openFileInNewTab } from './integration'
