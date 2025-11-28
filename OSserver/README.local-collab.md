# flyMD 协同服务器（闭源版部署说明）

本说明针对闭源协同服务器 `local-collab/server.js`，用于生产环境或需要后台管理、人数控制的场景。  
开源精简版请参考同目录下的 `README.md`（OSserver/server.js）。

## 功能概览

- WebSocket 协同接口（内部路径）：`/ws`
- HTTP 接口：
  - `/health`：健康检查
  - `/plugin/*`：插件文件（manifest/main.js 等）
  - `/flynn`、`/flynn/*`：后台管理页面（房间创建、人数上限、封禁等）
- 房间元数据持久化在 MySQL：
  - `collab_rooms`：房间号、密码哈希、人数上限、有效期、备注
  - `collab_admins`：后台管理员账号

## 环境要求

- Node.js 18 或以上
- MySQL 5.7+ / 8.0+
- 根目录已安装依赖（需要 `ws`、`mysql2` 等）：

```bash
npm install
```

## 配置步骤

1. 进入 `local-collab` 目录，复制环境变量模板：

```bash
cd local-collab
cp .env.example .env
```

2. 编辑 `.env`，根据实际环境修改：

- `COLLAB_SERVER_PORT`：监听端口（默认 `3456`）
- `DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME`：MySQL 连接配置
- `COLLAB_PASSWORD_SALT`：房间密码哈希盐值
- `COLLAB_ADMIN_SALT`、`COLLAB_ADMIN_SESSION_SECRET`：后台管理员密码与会话签名用盐

3. 准备数据库：

服务器启动时会自动创建 `collab_rooms`、`collab_admins` 等表，无需手动建表；只需保证：

- MySQL 实例可用；
- `.env` 中的数据库账号拥有建表与读写权限。

## 启动服务器

在项目根目录执行：

```bash
node local-collab/server.js
```

默认监听 `http://127.0.0.1:3456`，成功启动后会在日志中打印：

- 服务器地址
- 插件 manifest 地址：`/plugin/manifest.json`

## 反向代理示例（Nginx）

闭源服务器常见的部署方式是为其加一个 `/server` 前缀，对外暴露 `/server/*`。  
内部 Node 进程仍然只认根路径 `/` 和 `/ws`。

```nginx
# 对外暴露 /server/ 前缀下的 HTTP 接口
location /server/ {
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    # 去掉 /server 前缀，转发到后端根路径 /
    proxy_pass http://127.0.0.1:3456/;
}

# 单独给 WebSocket /server/ws 做升级
location /server/ws {
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    # 映射到后端 Node 进程的 /ws（local-collab/server.js 只认 /ws）
    proxy_pass http://127.0.0.1:3456/ws;
}
```

这样：

- 插件端可以使用 `wss://your-domain/server/ws` 作为协同服务器地址；
- 后台管理页面访问地址为 `https://your-domain/server/flynn`。

## 搭配闭源协同插件使用

- 插件位置：`local-collab/plugin/`
- 插件对应的 manifest 由闭源服务器通过 `/plugin/manifest.json` 暴露，对 Nginx 前缀包装后通常是：

```text
https://your-domain/server/plugin/manifest.json
```

插件在连接协同时，一般内置服务器地址（例如 `wss://your-domain/server/ws`），只向外暴露房间号和密码配置。

## 与开源版 OSserver 的关系

- 两者 WebSocket 协议保持兼容（`room/password/name` + 消息类型）。
- 部署方式类似：都是 Node + `ws` + Nginx 反向代理。
- 差异：
  - 闭源版多了 MySQL、后台管理和人数/有效期等控制；
  - 开源版不依赖数据库，房间在内存中自动创建，适合自建协同和开源示例。

