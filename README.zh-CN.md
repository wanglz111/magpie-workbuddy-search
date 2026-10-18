# Magpie WorkBuddy Search

为 Magpie 提供的纯搜索插件。插件直接调用 WorkBuddy AI 搜索服务，返回真实搜索结果的标题、摘要片段和链接；不会抓取网页全文，也不会调用模型生成摘要。

## 使用要求

- Magpie `0.1.1285` 或更高版本（已测试版本：`0.1.1285`）。
- WorkBuddy 认证插件 `@magpie-community/opencode-workbuddy-auth` `0.1.24` 或更高版本。
- Node.js 22 或更高版本，仅在本地运行测试时需要；Magpie 使用 Bun 运行插件。

## 安装与启用

先确保已安装 WorkBuddy 认证插件；如果尚未安装：

```sh
magpie plugin add @magpie-community/opencode-workbuddy-auth@latest
```

如果还没有在 Magpie 登录 `workbuddy-ai`，先完成登录。可使用浏览器或桌面登录方式；如果已经登录，无需重新登录或更换账号：

```sh
magpie plugin login workbuddy-ai
```

安装搜索插件并关联现有登录：

```sh
magpie plugin add github:wanglz111/magpie-workbuddy-search
magpie plugin login workbuddy-search
```

`workbuddy-search` 登录会自动关联现有的主 WorkBuddy AI 账号，不会申请新密钥，也不会复制或另存访问令牌。

最后，在 Magpie 的 **Settings → Web search** 中选择 **WorkBuddy Search**。它使用虚拟模型 `web-search`，供支持 Magpie Web search 的模型调用。

> Magpie 的 GitHub 社区发现列表以 `magpie-plugin` 为主题进行发现；这是第三方插件。Magpie 缓存约 10 分钟，GitHub 索引也可能另有延迟。通过上面的 GitHub 命令直接安装，不必等待列表刷新。

## 工作方式与限制

- 仅使用现有的主 `workbuddy-ai` 国际版登录及其 WorkBuddy AI 搜索服务；不使用中国版 WorkBuddy，也不连接 7864 网关。
- 每次请求最多搜索一次，并返回最多 5 条结果的标题、URL 和摘要片段；不会读取结果网页全文，也不会生成模型摘要。
- `allowed_domains` 和 `blocked_domains` 在本地对搜索结果过滤。服务最多返回 5 条，因此严格的域名过滤可能导致没有匹配结果。
- 搜索会使用现有 WorkBuddy 账号的搜索额度；插件不调用语言模型，模型 token 用量报告为 0。搜索额度仍按 WorkBuddy 服务规则计算。
- 认证委托给原 WorkBuddy 认证插件处理，包括令牌刷新；刷新后的令牌仍由 Magpie 写回原登录。搜索失败、额度拒绝、无匹配结果或无效响应会作为错误返回，不会静默切换到其他搜索服务。

## 故障排查

- **提示缺少登录或认证失败：**确认 `workbuddy-ai` 已在 Magpie 登录。如果原登录凭据已过期，请通过 `magpie plugin login workbuddy-ai` 重新完成浏览器或桌面登录，然后重试；不要为搜索插件单独创建密钥。
- **没有结果：**检查请求中的域名允许/屏蔽过滤条件是否过严。过滤在本地执行，服务最多提供 5 条候选结果。
- **额度错误：**搜索使用现有 WorkBuddy 账号的额度；达到服务额度限制时会返回错误，请检查账号额度后再试。
- **安装后找不到插件：**确认 Magpie 版本满足要求，并检查插件安装成功。Magpie 列表缓存约 10 分钟，GitHub 索引也可能另有延迟；GitHub 直接安装不受列表刷新延迟影响。

## 本地开发

克隆仓库后运行测试：

```sh
npm test
```

如需从本地开发版迁移到 GitHub 安装，可选地先移除旧的本地 `workbuddy-search` 插件注册，再按“安装与启用”中的命令安装 GitHub 版本：

```sh
magpie plugin rm /absolute/path/to/local/plugin
magpie plugin add github:wanglz111/magpie-workbuddy-search
magpie plugin login workbuddy-search
```

此操作只移除旧的本地搜索插件注册；保留并继续使用共享的 `workbuddy-ai` 登录。不要删除或退出 `workbuddy-ai` 登录。
