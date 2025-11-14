# flyMD 扩展开发文档

> 本文档介绍如何为 flyMD 开发扩展插件

## 目录

- [概述](#概述)
- [快速开始](#快速开始)
- [插件结构](#插件结构)
- [插件API](#插件api)
- [生命周期](#生命周期)
- [示例插件](#示例插件)
- [发布插件](#发布插件)
- [主题扩展（Theme）](#主题扩展theme)

## 概述

flyMD 提供了灵活的扩展系统，允许开发者通过编写插件来扩展编辑器的功能。插件可以：

- 添加自定义菜单项
- 访问和修改编辑器内容
- 调用 Tauri 后端命令
- 使用 HTTP 客户端进行网络请求
- 存储插件专属的配置数据
- 显示通知和确认对话框

### 内置扩展

flyMD 已内置以下扩展：

1. **图床 (S3/R2)** - 支持将图片上传到 S3/R2 对象存储
2. **WebDAV 同步** - 支持通过 WebDAV 协议同步文档
3. **Typecho 发布器** - 将文章发布到 Typecho 博客平台（可选安装）

## 快速开始

### 1. 创建插件项目

创建一个新的目录，并添加以下文件：

```
my-plugin/
├── manifest.json    # 插件清单文件
└── main.js          # 插件主文件
```

### 2. 编写 manifest.json

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "插件功能描述",
  "main": "main.js"
}
```

**字段说明：**
- `id`（必需）：插件唯一标识符，建议使用小写字母和连字符
- `name`（必需）：插件显示名称
- `version`（必需）：插件版本号，建议使用语义化版本
- `author`（可选）：作者信息
- `description`（可选）：插件功能描述
- `main`（必需）：插件入口文件，默认为 `main.js`

### 3. 编写 main.js

```javascript
// main.js
export function activate(context) {
  // 插件激活时执行
  context.ui.notice('我的插件已激活！', 'ok', 2000);

  // 添加菜单项
  context.addMenuItem({
    label: '我的插件',
    title: '点击执行插件功能',
    onClick: async () => {
      const content = context.getEditorValue();
      context.ui.notice('当前内容长度：' + content.length, 'ok');
    }
  });
}

export function deactivate() {
  // 插件停用时执行（可选）
  console.log('插件已停用');
}

export function openSettings(context) {
  // 打开插件设置界面（可选）
  context.ui.notice('打开设置界面', 'ok');
}
```

### 4. 发布到 GitHub

1. 在 GitHub 创建仓库
2. 将 `manifest.json` 和 `main.js` 推送到仓库
3. 用户可通过 `username/repo` 或 `username/repo@branch` 格式安装

### 5. 安装插件

在 flyMD 中：
1. 点击菜单栏"扩展"按钮
2. 在安装扩展输入框中输入：
   - GitHub 仓库：`username/repository` 或 `username/repository@branch`
   - HTTP URL：`https://example.com/path/to/manifest.json`
3. 点击"安装"按钮

## 插件结构

### 基本结构

```
my-plugin/
├── manifest.json       # 插件清单（必需）
├── main.js            # 插件主文件（必需）
├── README.md          # 说明文档（推荐）
└── assets/            # 资源文件（可选）
    └── icon.png
```

### manifest.json 详解

```json
{
  "id": "example-plugin",
  "name": "示例插件",
  "version": "1.0.0",
  "author": "Your Name <email@example.com>",
  "description": "这是一个示例插件，展示如何开发 flyMD 扩展",
  "main": "main.js",
  "homepage": "https://github.com/username/example-plugin",
  "repository": "https://github.com/username/example-plugin"
}
```

## 插件API

插件通过 `context` 对象访问 flyMD 的功能。

### context.http

HTTP 客户端，用于网络请求。

```javascript
// GET 请求
const response = await context.http.fetch('https://api.example.com/data', {
  method: 'GET',
  headers: {
    'Content-Type': 'application/json'
  }
});
const data = await response.json();

// POST 请求
const response = await context.http.fetch('https://api.example.com/post', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ key: 'value' })
});
```

### context.invoke

调用 Tauri 后端命令。

```javascript
// 调用后端命令
try {
  const result = await context.invoke('command_name', {
    param1: 'value1',
    param2: 'value2'
  });
  console.log('命令执行结果：', result);
} catch (error) {
  console.error('命令执行失败：', error);
}
```

### context.storage

插件专属的存储空间。

```javascript
// 保存数据
await context.storage.set('key', { name: 'value', count: 42 });

// 读取数据
const data = await context.storage.get('key');
console.log(data); // { name: 'value', count: 42 }

// 删除数据（设置为 null）
await context.storage.set('key', null);
```

### context.addMenuItem

在菜单栏添加自定义菜单项。

```javascript
const removeMenuItem = context.addMenuItem({
  label: '菜单文本',
  title: '鼠标悬停提示',
  onClick: () => {
    // 点击时执行的操作
    context.ui.notice('菜单被点击了！');
  }
});

// 移除菜单项（可选）
// removeMenuItem();
```

**注意：** 每个插件只能添加一个菜单项。

### context.ui.notice

显示通知消息。

```javascript
// 显示成功通知（默认）
context.ui.notice('操作成功！', 'ok', 2000);

// 显示错误通知
context.ui.notice('操作失败！', 'err', 3000);

// 参数说明：
// - message: 通知内容
// - level: 'ok' 或 'err'，默认 'ok'
// - ms: 显示时长（毫秒），默认 1600
```

### context.ui.confirm

显示确认对话框。

```javascript
const confirmed = await context.ui.confirm('确定要执行此操作吗？');
if (confirmed) {
  context.ui.notice('用户确认了操作');
} else {
  context.ui.notice('用户取消了操作');
}
```

### context.getEditorValue

获取编辑器当前内容。

```javascript
const content = context.getEditorValue();
console.log('当前内容：', content);
console.log('字符数：', content.length);
```

### context.setEditorValue

设置编辑器内容。

```javascript
// 替换全部内容
context.setEditorValue('# 新内容\n\n这是新的内容');

// 追加内容
const current = context.getEditorValue();
context.setEditorValue(current + '\n\n附加的内容');
```

**注意：** 调用此方法会：
- 标记文档为未保存状态
- 更新标题栏和状态栏
- 如果在预览模式，会自动重新渲染预览

### context.pickDocFiles

在桌面版中弹出文件选择对话框，选择一个或多个 Markdown 文档（`md / markdown / txt`），返回绝对路径数组。

```javascript
// 选择多个文档
const files = await context.pickDocFiles({ multiple: true });

if (!files || files.length === 0) {
  context.ui.notice('未选择任何文档', 'err');
} else {
  context.ui.notice('已选择 ' + files.length + ' 个文档', 'ok');
}
```

**注意：**
- 仅在桌面版（Tauri 应用）可用，浏览器环境会返回空数组并弹出提示。
- 返回值为字符串数组，每一项是文件的绝对路径。

### context.openFileByPath

按给定绝对路径打开本地文档，相当于用户在界面中打开该文件。

```javascript
// 打开单个文档
await context.openFileByPath('C:/docs/note.md');

// 打开后可以继续读取内容
const content = context.getEditorValue();
context.ui.notice('已打开文档，长度：' + content.length, 'ok');
```

**注意：**
- 仅支持当前 flyMD 支持的文档类型（`md / markdown / txt / pdf`）。
- 同样走应用内部的打开流程，会更新当前文档路径、最近文件等状态。

### context.exportCurrentToPdf

将当前文档导出为 PDF 文件，目标路径由插件指定。

```javascript
// 将当前文档导出到指定路径
await context.exportCurrentToPdf('C:/docs/note.pdf');
context.ui.notice('PDF 导出完成', 'ok');
```

**注意：**
- 仅在桌面版（Tauri 应用）可用，依赖内置的 PDF 导出能力。
- `target` 应为完整文件路径（包含 `.pdf` 扩展名），若路径无效会抛出错误。
- 插件无需关心渲染细节，导出内容与应用中“另存为 PDF”的效果一致。

## 主题扩展（Theme）

flyMD 内置了主题系统，并对外暴露了可选的 Theme 扩展 API，便于插件对“颜色调色板、排版风格、Markdown 渲染风格”进行扩展或覆写。

### 能力概览

- 颜色调色板：在主题面板中追加可选颜色（用于编辑/阅读/所见三种背景）
- 排版风格：为现有排版风格覆写 CSS（字体/字号/行距等）
- Markdown 风格：为现有风格覆写 CSS（标题、引用、代码块、表格等）
- 主题偏好：读取/保存/应用当前主题设置
- 主题事件：监听主题变更，联动插件 UI

注意：当前版本 ID 列表为固定集合，注册不存在的 ID 将被忽略。

- Typography ID（排版风格）：`default | serif | modern | reading | academic`
- Markdown Style ID（MD 风格）：`standard | github | notion | journal | card | docs`

### 全局对象与 API

在渲染进程中可直接访问全局对象：`window.flymdTheme`

```ts
interface ThemePrefs {
  editBg: string       // 编辑背景
  readBg: string       // 阅读背景
  wysiwygBg: string    // 所见背景
  typography: 'default' | 'serif' | 'modern' | 'reading' | 'academic'
  mdStyle:   'standard' | 'github' | 'notion' | 'journal' | 'card' | 'docs'
}

// 扩展入口
flymdTheme.registerPalette(label: string, color: string, id?: string): void
flymdTheme.registerTypography(id: ThemePrefs['typography'], label: string, css?: string): void
flymdTheme.registerMdStyle(id: ThemePrefs['mdStyle'], label: string, css?: string): void

// 主题状态
flymdTheme.applyThemePrefs(prefs: ThemePrefs): void
flymdTheme.saveThemePrefs(prefs: ThemePrefs): void
flymdTheme.loadThemePrefs(): ThemePrefs

// 主题变更事件（插件可监听联动）
window.addEventListener('flymd:theme:changed', (e) => {
  const prefs = (e.detail || {}).prefs
  console.log('Theme changed:', prefs)
})
```

### 使用示例：增加调色板 + 调整 Docs 风格代码高亮

```js
// main.js（插件）
export function activate(context) {
  // 1) 增加两种可选颜色到主题面板
  flymdTheme.registerPalette('薰衣草', '#ede9fe')
  flymdTheme.registerPalette('薄荷绿', '#e8fff4')

  // 2) 为 Docs 风格追加/覆写一段 CSS（仅在 md-docs 生效）
  flymdTheme.registerMdStyle('docs', 'Docs', `
    .container.md-docs { --c-key:#1f4eff; --c-str:#0ea5e9; --c-num:#d97706; --c-fn:#7c3aed; --c-com:#94a3b8; }
    @media (prefers-color-scheme: dark) {
      .container.md-docs { --c-key:#93c5fd; --c-str:#67e8f9; --c-num:#fdba74; --c-fn:#c4b5fd; --c-com:#9ca3af; }
    }
  `)

  // 3) 快速应用某一主题偏好（示例：将阅读背景切到薰衣草）
  const prefs = flymdTheme.loadThemePrefs()
  prefs.readBg = '#ede9fe'
  flymdTheme.saveThemePrefs(prefs)
  flymdTheme.applyThemePrefs(prefs)

  context.ui.notice('主题扩展已加载', 'ok')
}
```

### 使用示例：调整排版风格（阅读）

```js
export function activate() {
  // 为“阅读”排版风格追加更大行距（不会影响其它风格）
  flymdTheme.registerTypography('reading', '阅读', `
    .container.typo-reading .preview-body,
    .container.typo-reading.wysiwyg-v2 .ProseMirror { line-height: 2.0; font-size: 18px; }
  `)
}
```

### 可用 CSS 变量（主题相关）

- 布局基色
  - `--bg` 编辑背景（应用于 `.container` 作用域）
  - `--preview-bg` 阅读背景（`.container:not(.wysiwyg):not(.wysiwyg-v2) .preview`）
  - `--wysiwyg-bg` 所见背景（`.container.wysiwyg-v2`）
- 代码配色（高亮 token）
  - `--code-bg`、`--code-border`、`--code-fg`
  - `--c-key`、`--c-str`、`--c-num`、`--c-fn`、`--c-com`
- 代码块装饰
  - `--code-pre-pad-y` 代码块基础上下内边距（结合语言角标让位）
  - `--code-lang-gap` 语言角标让位额外高度（定义在 `.codebox`）

### 注意事项与最佳实践

- 避免直接覆盖 `.codebox pre` 的 `padding-top`，统一通过 `--code-pre-pad-y + --code-lang-gap` 让位，防止语言角标与首行重叠。
- Typography/MdStyle 的 `id` 目前为固定集合；可通过传入 `css` 来细化、覆写现有风格。
- 使用 `applyThemePrefs` 修改主题只影响当前会话；配合 `saveThemePrefs` 可持久化到下一次启动。
- 监听 `flymd:theme:changed` 事件可实现插件 UI 与主题的联动更新。

## 生命周期

### activate(context)

插件激活时调用（必需）。

```javascript
export function activate(context) {
  console.log('插件已激活');

  // 初始化插件
  context.addMenuItem({
    label: '我的功能',
    onClick: async () => {
      // 功能实现
    }
  });
}
```

### deactivate()

插件停用时调用（可选）。

```javascript
export function deactivate() {
  console.log('插件已停用');
  // 清理资源
}
```

### openSettings(context)

打开插件设置界面（可选）。

```javascript
export function openSettings(context) {
  // 从存储中读取配置
  const loadConfig = async () => {
    const apiKey = await context.storage.get('apiKey') || '';
    const apiUrl = await context.storage.get('apiUrl') || '';
    return { apiKey, apiUrl };
  };

  // 保存配置
  const saveConfig = async (config) => {
    await context.storage.set('apiKey', config.apiKey);
    await context.storage.set('apiUrl', config.apiUrl);
    context.ui.notice('配置已保存', 'ok');
  };

  // 创建设置界面（示例：使用 prompt）
  const showSettings = async () => {
    const config = await loadConfig();
    const apiKey = prompt('请输入 API Key:', config.apiKey);
    if (apiKey !== null) {
      const apiUrl = prompt('请输入 API URL:', config.apiUrl);
      if (apiUrl !== null) {
        await saveConfig({ apiKey, apiUrl });
      }
    }
  };

  showSettings();
}
```

## 示例插件

### 1. 字数统计插件

```javascript
// main.js
export function activate(context) {
  context.addMenuItem({
    label: '字数统计',
    title: '统计当前文档的字符数、词数和行数',
    onClick: () => {
      const content = context.getEditorValue();
      const chars = content.length;
      const words = content.split(/\s+/).filter(w => w.length > 0).length;
      const lines = content.split('\n').length;

      context.ui.notice(
        `字符数: ${chars} | 词数: ${words} | 行数: ${lines}`,
        'ok',
        3000
      );
    }
  });
}
```

```json
// manifest.json
{
  "id": "word-count",
  "name": "字数统计",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "统计 Markdown 文档的字符数、词数和行数",
  "main": "main.js"
}
```

### 2. 文本转换插件

```javascript
// main.js
export function activate(context) {
  context.addMenuItem({
    label: '大写转换',
    title: '将选中文本转换为大写',
    onClick: async () => {
      const content = context.getEditorValue();
      const confirmed = await context.ui.confirm('确定将所有文本转换为大写吗？');

      if (confirmed) {
        const upperCase = content.toUpperCase();
        context.setEditorValue(upperCase);
        context.ui.notice('转换完成！', 'ok');
      }
    }
  });
}
```

### 3. HTTP 请求插件

```javascript
// main.js
export function activate(context) {
  context.addMenuItem({
    label: '获取 IP',
    title: '获取当前公网 IP 地址',
    onClick: async () => {
      try {
        const response = await context.http.fetch('https://api.ipify.org?format=json', {
          method: 'GET'
        });

        const data = await response.json();
        context.ui.notice(`您的 IP 地址是: ${data.ip}`, 'ok', 3000);
      } catch (error) {
        context.ui.notice('获取 IP 失败: ' + error.message, 'err', 3000);
      }
    }
  });
}
```

### 4. 配置存储插件

```javascript
// main.js
export function activate(context) {
  context.addMenuItem({
    label: '我的工具',
    onClick: async () => {
      // 读取配置
      const prefix = await context.storage.get('prefix') || '>> ';

      // 使用配置
      const content = context.getEditorValue();
      const lines = content.split('\n');
      const prefixed = lines.map(line => prefix + line).join('\n');

      context.setEditorValue(prefixed);
      context.ui.notice('已添加前缀', 'ok');
    }
  });
}

export function openSettings(context) {
  (async () => {
    const currentPrefix = await context.storage.get('prefix') || '>> ';
    const newPrefix = prompt('设置行前缀:', currentPrefix);

    if (newPrefix !== null) {
      await context.storage.set('prefix', newPrefix);
      context.ui.notice('设置已保存', 'ok');
    }
  })();
}
```

## 发布插件

### 方式一：GitHub 发布（推荐）

1. **创建 GitHub 仓库**

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/username/my-plugin.git
   git push -u origin main
   ```

2. **文件结构**

   确保仓库根目录包含：
   - `manifest.json`
   - `main.js`
   - `README.md`（推荐）

3. **安装方式**

   用户可通过以下格式安装：
   ```
   username/my-plugin
   username/my-plugin@main
   username/my-plugin@develop
   ```

### 方式二：HTTP 发布

1. **部署文件**

   将插件文件部署到 Web 服务器：
   ```
   https://example.com/plugins/my-plugin/
   ├── manifest.json
   └── main.js
   ```

2. **确保 CORS**

   服务器需要允许跨域访问：
   ```
   Access-Control-Allow-Origin: *
   ```

3. **安装方式**

   用户通过完整 URL 安装：
   ```
   https://example.com/plugins/my-plugin/manifest.json
   ```
   
## 提交插件/扩展到应用内市场

将插件/扩展地址及说明发送到fly@llingfei.com或issue


## 最佳实践

### 1. 错误处理

始终使用 try-catch 处理可能的错误：

```javascript
export function activate(context) {
  context.addMenuItem({
    label: '我的功能',
    onClick: async () => {
      try {
        // 可能出错的操作
        const data = await context.http.fetch('https://api.example.com');
        // 处理数据
      } catch (error) {
        context.ui.notice('操作失败: ' + error.message, 'err', 3000);
        console.error('详细错误:', error);
      }
    }
  });
}
```

### 2. 用户反馈

及时给用户反馈操作状态：

```javascript
export function activate(context) {
  context.addMenuItem({
    label: '上传',
    onClick: async () => {
      context.ui.notice('正在上传...', 'ok', 999999); // 长时间显示

      try {
        await uploadFunction();
        context.ui.notice('上传成功！', 'ok', 2000);
      } catch (error) {
        context.ui.notice('上传失败', 'err', 3000);
      }
    }
  });
}
```

### 3. 数据验证

在操作前验证数据的有效性：

```javascript
export function activate(context) {
  context.addMenuItem({
    label: '处理',
    onClick: async () => {
      const content = context.getEditorValue();

      if (!content || content.trim().length === 0) {
        context.ui.notice('编辑器内容为空', 'err');
        return;
      }

      // 继续处理...
    }
  });
}
```

### 4. 配置管理

为插件提供合理的默认配置：

```javascript
async function getConfig(context) {
  return {
    apiKey: await context.storage.get('apiKey') || '',
    timeout: await context.storage.get('timeout') || 5000,
    enabled: await context.storage.get('enabled') ?? true
  };
}
```

### 5. 兼容性

考虑不同环境的兼容性：

```javascript
export function activate(context) {
  // 检查必需的 API 是否可用
  if (!context.http) {
    context.ui.notice('HTTP 功能不可用', 'err');
    return;
  }

  // 继续初始化...
}
```

## 常见问题

### Q: 如何调试插件？

A: 使用 `console.log` 输出调试信息，在 flyMD 中按 `F12` 或 `Ctrl+Shift+I` 打开开发者工具查看。

```javascript
export function activate(context) {
  console.log('插件激活', context);

  context.addMenuItem({
    label: '调试',
    onClick: () => {
      console.log('当前内容:', context.getEditorValue());
    }
  });
}
```

### Q: 插件可以访问文件系统吗？

A: 可以通过 `context.invoke` 调用 Tauri 后端命令来访问文件系统。

### Q: 如何更新已安装的插件？

A: 目前需要先移除旧版本，再重新安装新版本。

### Q: 插件的存储空间有限制吗？

A: 没有硬性限制，但建议只存储必要的配置数据，避免存储大量数据。

### Q: 可以创建多个菜单项吗？

A: 每个插件只能添加一个主菜单项，但可以在菜单项的点击事件中弹出子菜单。

## 参考资源

- [Typecho Publisher 插件](https://github.com/TGU-HansJack/typecho-publisher-flymd) - 官方示例插件
- [flyMD GitHub 仓库](https://github.com/flyhunterl/flymd)
- [Tauri 文档](https://tauri.app/)

## 许可证

本文档遵循与项目一致的许可：飞速MarkDown（flyMD）非商业开源许可协议（NC 1.0），详见 [LICENSE](LICENSE)。

---

如有问题或建议，欢迎提交 [Issue](https://github.com/flyhunterl/flymd/issues)。
