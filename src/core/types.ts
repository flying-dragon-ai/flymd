// 共享类型定义
export type Mode = 'edit' | 'preview'
export type LibSortMode = 'name_asc' | 'name_desc' | 'mtime_asc' | 'mtime_desc'
export type LogLevel = 'info' | 'warn' | 'error' | 'debug'

export interface DocPos {
  scrollTop?: number
  cursorLine?: number
  cursorCol?: number
}

export interface UpdateAssetInfo {
  name: string
  browser_download_url: string
  size: number
}

export interface CheckUpdateResp {
  tag_name: string
  name: string
  body: string
  html_url: string
  assets: UpdateAssetInfo[]
}

export interface UpdateExtra {
  changelog?: string
  [key: string]: any
}
