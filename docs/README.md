# EzDSH 文档

EzDSH 是 DeepSeek Harness 的桌面发行版；它是一个 AI 工作团队，让每一次执行都更有分工、更有条理，也更容易得到稳定结果。

## 文档导航

- [产品需求](./product-requirements.md)：产品目标、用户流程、功能范围和验收标准
- [多角色 AI 员工使用指南](./ai-employees.md)：员工理念、能力边界、使用方法和常见自动化场景
- [技术架构](./architecture.md)：进程结构、启动流程、配置存储、安全和更新机制
- [DSH Runtime 依赖关系](./runtime-dependency.md)：项目依赖、本机安装和打包运行时的边界
- [发布手册](./release-manual.md)：版本、素材、验证、打包、签名、公证和自动更新的完整流程
- [发布与自动更新](./update-distribution.md)：Vercel 更新源、版本元数据和安装包分发方案
- [开发计划](./superpowers/plans/2026-08-15-ezdsh-foundation.md)：按任务拆分的后续实施顺序

## 当前产品边界

EzDSH 与 DeepSeek Harness 绑定。Harness 负责 Agent Runtime、模型调用、工具执行和 Web UI；EzDSH 负责桌面宿主能力以及面向桌面应用的配置、恢复、安全和发布体验。

## 文档约定

- 产品名称统一写作 `EzDSH`。
- 运行时统一写作 `DeepSeek Harness` 或 `DSH Runtime`。
- API Key、Session、Profile、Plugin 等用户数据不得写入应用安装目录。
- 任何密钥、完整请求内容和用户项目代码不得写入普通日志。
- 需求未明确时，优先选择可恢复、可测试、最小化的实现。
