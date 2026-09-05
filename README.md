# MCSLite — 轻量 Minecraft 服务器管理面板

参考 MCSManager 设计理念的极简 MC 服务器面板:零依赖 Node.js 实现,占用小,启动即用。

## 功能

- 玩家界面(默认):免登录查看服务器 CPU/内存占用、在线玩家、版本、MOTD、IP
- 管理后台:账号密码登录,多用户(管理员/操作员)
- 整合包导入:浏览器上传 `.zip` / `.tar.gz`,或填写本地路径,自动识别服务端 jar
- 文件管理:目录浏览、上传/下载、在线编辑、重命名、删除、解压
- 可视化配置:`server.properties` 图形化编辑,JVM 内存、EULA、自动启动
- Java 自动检测:扫描 `JAVA_HOME`、PATH、常见安装目录、`.minecraft` 运行时,按 MC 版本自动匹配
- 世界备份:定时/手动备份,运行中服务端自动 `save-off`/`save-all` 后打包
- IP 绑定:检测本机局域网 IP,一键写入 `server-ip` / `server-port`

## 快速开始

1. 安装 [Node.js](https://nodejs.org) 22.13+(账号存储使用内置 `node:sqlite`)
2. 安装 Java 8 / 17 / 21(面板自动检测)
3. 双击 `start.bat`,或执行 `node server.js`
4. 浏览器打开 http://127.0.0.1:8333
5. 默认账号 `admin / admin123`,首次登录后立即修改密码

局域网访问使用 `http://本机IP:8333`。

## 目录结构

```
MCSLite/
├── server.js          # 主程序(唯一入口)
├── start.bat          # Windows 一键启动
├── bg.jpg             # 默认背景副本(面板读取 web/bg.jpg)
├── lib/               # 后端模块(路由/认证/实例/Java/探测/文件)
├── web/               # 前端(HTML/CSS/JS,零构建)
├── data/              # 运行时数据:配置、用户、背景
└── servers/           # 每个服务器实例一个文件夹
```

## 使用流程

1. 管理后台「新建 / 导入整合包」:上传 `.zip` 或填写本机路径,面板自动解压并识别服务端 jar
2. 实例设置:勾选「同意 EULA」,选择内存与 Java 版本(或自动)
3. 概览页点击启动;控制台可查看日志、发送指令(如 `list`、`op 玩家名`)
4. 可视化配置中设置 `server-ip`(留空监听所有网卡)与 `server-port`
5. 玩家连接游戏服务器 `本机IP:25565`;玩家界面打开 `http://本机IP:8333`

## 更新

面板数据全部在 `data/` 与 `servers/`:

1. 停止面板
2. 备份 `data/`、`servers/`
3. 用新版覆盖 `server.js`、`lib/`、`web/`、`start.bat`
4. 重新启动,配置与实例不受影响

## 安全说明

- 默认监听 `0.0.0.0:8333`;玩家界面公开只读,管理后台需登录
- 密码使用 scrypt + 随机盐哈希存储;登录接口 60 秒限流
- 文件管理限制在实例目录内;背景图/首页图仅允许图片文件
- 玩家下载世界存档/备份有每 IP 限速
- 外部命令通过参数数组调用,不使用 shell

## 常见问题

- 启动报错「未找到 Java」:在「Java 检测」页扫描,或安装 JDK 21(兼容 1.20.5+)
- 看不到在线玩家列表:服务端需开启 `enable-query=true`(可视化配置中勾选)
- 修改端口:`node server.js --port 9000 --host 0.0.0.0`,或修改 `data/config.json`
- 整合包没有服务端文件:部分整合包只含客户端文件,请使用服务端版整合包

## License

MIT
