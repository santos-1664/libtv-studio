# LibTV Studio

更新日期：2026-09-16

一个参照 LibTV 交互方式构建的 AI 视频创作工作台，包含首页与画布、项目管理、Agent、React 前端、Express 后端和 SQLite。文本与 Agent 使用 OpenAI 兼容 API，图片和视频支持百炼协议。

**本交付是无凭据、无历史数据的源码包。** 不包含数据库、模型配置、加密主密钥、项目、会话、上传素材或生成结果，`data/` 仅保留 `.gitkeep`。首次启动自动初始化空数据库并生成新的本地主密钥；接收人必须自行在设置中填写 API URL、API Key 和模型，才能调用真实服务。

## 启动

### Docker

安装并启动 Docker，在项目目录执行：

```bash
docker compose up --build -d
```

打开 [本机工作台](http://localhost:3100)。首次使用空的 `studio-data` 数据卷时，应用自动建表并生成新主密钥。该源码包没有历史数据可恢复。后续自行创建的项目、配置和媒体保存在数据卷中，已有数据卷不会被初始化流程覆盖。

日常停止使用 `docker compose down`，保留数据卷即可保留自己创建的项目。`.env` 中的 `PORT` 只修改宿主机访问端口，容器内部固定监听 3100；`DATA_DIR` 仅用于本地 Node 启动，Compose 使用 `/app/data` 和命名数据卷。

### 本地 Node.js

要求 Node.js 22.16 或更新的 22.x 版本。项目使用 Node 内置 SQLite，无需另装数据库。

```bash
npm ci
npm run build
npm start
```

打开 [本地工作台](http://127.0.0.1:3100)。首次启动会在本地数据目录建立空数据库和新主密钥。可选复制 `.env.example` 为 `.env`，配置端口、数据目录或访问密码；模板不包含实际凭据。

### 首次配置

1. 打开“设置”，填写自己的文本 API URL、API Key。
2. 点击“验证并获取模型”，从实际返回的列表选择默认模型并保存。
3. 分别填写图片、视频服务的协议、地址、API Key 和模型。
4. 新建项目，按实际需要提交生成任务。模型目录可读不代表所有模型都支持聊天、工具调用或媒体生成。

未配置 AI 服务时，项目创建、画布编辑、素材上传和本地预览可以使用；真实生成和 Agent 回复需要有效配置。密钥保存后不回填前端，之后留空保存会保留该部署中已保存的密钥；首次配置不能用空值代替有效密钥。

## 三个模块

- **首页与画布**：空白画布与创作提示模板；文本、图片、视频节点；名称、提示词、模型和参数编辑；拖动、缩放、引用连接、复制、删除、撤销重做；上传、预览、下载、自动保存和草稿恢复。
- **项目页**：创建、搜索、网格/列表显示、更新时间/名称排序、重命名、删除、重新打开；用户上传的图片可作为初始封面。
- **Agent**：Skill 分类、搜索、收藏、附件、模型选择、项目会话切换、流式回复、操作卡片；可创建脚本与分镜、修改指定节点和提交生成任务。

画布快捷键：`Space` 拖动画布、`T` 添加文本、`F` 适应视图、`Ctrl/Cmd+S` 保存、`Ctrl/Cmd+Z` 撤销、`Ctrl/Cmd+D` 复制。输入框和弹窗中不触发删除等画布快捷键。

上传支持 PNG、JPEG、WebP、GIF、MP4、WebM，单文件最大 100 MB。后端校验文件内容及项目归属。创作提示模板和界面插画属于产品资源，不是随包提供的个人作品或模型生成结果。

## 模型接口

| 能力 | 接入方式 | 配置要求 |
| --- | --- | --- |
| 文本与 Agent | OpenAI 兼容模型列表、聊天、SSE 和工具调用 | API URL、API Key、实际可用的文本模型 |
| 图片 | 百炼 Qwen-Image 3.0；另保留 OpenAI 图片适配器 | 对应协议、服务地址、API Key、支持的模型 |
| 视频 | 百炼 Wan 2.7 异步任务；另保留方舟适配器 | 对应协议、服务地址、API Key、支持的模型 |

文本 API URL 只填根地址时自动补 `/v1`；已含 `/v1`、`/compatible-mode/v1` 等显式路径时保留原路径，不重复添加。服务端再追加 `/models`、`/chat/completions`，不要填写完整聊天端点。使用百炼兼容文本接口时，需填写该服务实际提供的 `/compatible-mode/v1` 基地址。

百炼图片与视频填写自己的业务空间 HTTPS 根地址，不附加 `/api/v1` 或 `/compatible-mode/v1`。适配器支持 `qwen-image-3.0`、`wan2.7-t2v` 等已实现协议的模型；这些名称不代表源码包内已开通或保存模型服务。实际权限与模型列表以接收人账户为准。

视频节点模型留空、服务默认选择已支持的 Wan 文生视频系列且连接图片时，会使用配套 `wan2.7-i2v-2026-04-25` 首帧模型。显式指定模型时尊重该选择。百炼视频时长为 2–15 秒，图生视频需要一张有效首帧，比例跟随首帧。

文本环境变量为 `TEXT_BASE_URL`、`TEXT_API_KEY`、`TEXT_MODEL`；设置字段为 `textBaseUrl`、`textKey`、`textModel`。已保存的部署配置优先于环境变量。详见 [接口接入说明](docs/接口接入说明.md)。

## 工程目录

```text
client/              React 页面、画布、Agent 与设置
shared/types.ts      前后端数据契约
server/app.ts        API、会话、上传和静态资源
server/store.ts      SQLite 初始化与持久化
server/config.ts     配置与凭据加密
server/agent.ts      Agent 工具执行循环
server/providers.ts  模型适配层与 SSE 解析
server/jobs.ts       持久化任务与重启恢复
server/media.ts      文件校验、归档与下载
server/schema.ts     请求与数据校验
tests/               本地集成与协议测试
public/art/          产品模板插画
data/.gitkeep        空运行目录占位
Dockerfile           两阶段构建与非 root 运行
compose.yaml         端口、配置与持久化数据卷
```

## 检查与验证范围

```bash
npm test
npm run build
docker compose config --quiet
```

开发阶段已完成 44 项自动测试、TypeScript 与 Vite 构建、Docker 镜像构建，以及真实文本、图片、视频、Agent 创建分镜和局部修改后重新生成的验证。对应开发数据和凭据不随本包交付；这些记录不代表脱敏后又发起了真实模型或付费请求。源码交付的检查范围见 [验收记录](docs/验收记录.md)。测试模拟服务只用于自动测试，产品不会返回伪造的生成成果。

## 部署与备份

该版本是单工作区应用，默认端口仅绑定本机。需要网络访问时，设置 `ACCESS_PASSWORD`，配置 HTTPS 反向代理和准确的 `APP_ORIGIN`。本地 HTTP 使用 `COOKIE_SECURE=false`，HTTPS 部署按实际情况启用安全 Cookie。

开始使用后，备份自己部署的数据时应停止服务，再完整复制数据库、媒体与 `.master-key`。如果使用 `SETTINGS_ENCRYPTION_KEY`，应妥善保存同一个值以解密已有配置。这些运行数据属于接收人自行建立的内容，不应混入无凭据源码发布包。

生成提交状态不确定时，任务保留错误并阻止重复提交。确认供应商未受理原请求后，可通过 `POST /api/projects/:projectId/jobs/:jobId/resolve` 和 `{"confirmedNotSubmitted":true}` 解除保护。已取得外部任务 ID 的视频任务可以继续查询，已有结果但下载未完成的任务可恢复归档。

当前不包含视频内容理解、完整时间线剪辑、成片拼接、实时协作及多租户权限体系。详细范围见 [产品方案文档](产品方案文档.md)。
