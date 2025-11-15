// 启动性能优化工具

export interface PerformanceMarks {
  appStart: number
  domReady: number
  appReady: number
  firstRender: number
}

const marks: Partial<PerformanceMarks> = {}

export function markStartup(name: keyof PerformanceMarks) {
  marks[name] = performance.now()
  performance.mark(`flymd-${name}`)
}

export function getStartupMetrics(): PerformanceMarks & { total: number } {
  const appStart = marks.appStart || 0
  const appReady = marks.appReady || performance.now()
  return {
    appStart,
    domReady: marks.domReady || 0,
    appReady,
    firstRender: marks.firstRender || 0,
    total: appReady - appStart
  }
}

export function logStartupMetrics() {
  const metrics = getStartupMetrics()
  console.log('[Startup Performance]', {
    'DOM Ready': `${(metrics.domReady - metrics.appStart).toFixed(0)}ms`,
    'First Render': `${(metrics.firstRender - metrics.appStart).toFixed(0)}ms`,
    'App Ready': `${(metrics.appReady - metrics.appStart).toFixed(0)}ms`,
    'Total': `${metrics.total.toFixed(0)}ms`
  })
}

// 延迟执行非关键任务
export function deferTask(fn: () => void | Promise<void>, priority: 'idle' | 'animation' | 'timeout' = 'idle') {
  switch (priority) {
    case 'idle':
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => {
          try {
            const result = fn()
            if (result instanceof Promise) {
              result.catch(e => console.warn('[Deferred task error]', e))
            }
          } catch (e) {
            console.warn('[Deferred task error]', e)
          }
        })
      } else {
        setTimeout(() => {
          try {
            const result = fn()
            if (result instanceof Promise) {
              result.catch(e => console.warn('[Deferred task error]', e))
            }
          } catch (e) {
            console.warn('[Deferred task error]', e)
          }
        }, 100)
      }
      break
    case 'animation':
      requestAnimationFrame(() => {
        try {
          const result = fn()
          if (result instanceof Promise) {
            result.catch(e => console.warn('[Deferred task error]', e))
          }
        } catch (e) {
          console.warn('[Deferred task error]', e)
        }
      })
      break
    case 'timeout':
      setTimeout(() => {
        try {
          const result = fn()
          if (result instanceof Promise) {
            result.catch(e => console.warn('[Deferred task error]', e))
          }
        } catch (e) {
          console.warn('[Deferred task error]', e)
        }
      }, 0)
      break
  }
}
