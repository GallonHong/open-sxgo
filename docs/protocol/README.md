# 公开协议与验证边界

公开模型：`packages/protocol/src/public.ts`；私密模型：`private.ts`。发布构建只接受严格 PUB Dataset，不导出私密数据库；未知字段拒绝。`pnpm demo` 输出独立 JSON Schema。所有企业、范围、来源、品牌、关系、店铺与出站地址进入同一发布清单。

业务对象采用确定性 JSON 编码，整数值、对象键排序；签名输入以 `WFD-SIGNED-OBJECT-v1\n` 区分用途。TUF 元数据使用官方规范对应的 canonical JSON，不能互换。重复 JSON 字段、异常路径、过大响应、错误摘要和不足阈值均拒绝。

根内明确 environment 与 epoch。Root 阈值 2/3、Targets 阈值 2/3；snapshot、timestamp、suspensions 是单独角色。生产业务签名还需根签署的人员授权清单，企业范围和不同 `person_id` 都要满足；多个签名属于同一个人不算独立。签名只能证明授权与完整性，不能证明劳动事实真实。

暂停清单只能减少推荐资格。客户端保存暂停版本、摘要与范围；同版本变更为分叉，旧版回放拒绝。恢复被暂停范围需绑定新发布摘要，并额外满足 Targets 阈值；生产新发布也需独立业务审核。初次客户端无法知道未见过的撤减，应依靠较短清单有效期与多渠道校验限制风险。

共用验证核心通过 116 项官方兼容性用例；3 项 ML-DSA 为明确不支持的可选算法。WFD 发布仍采用平面 Targets 与 Ed25519，已实现的委派遍历会针对当前父角色重新校验缓存子角色。Node CLI 使用官方 [`tuf-js`](https://github.com/theupdateframework/tuf-js) 加 WFD 业务检查；完整结果记录于 docs/acceptance/conformance.json，并非声称支持所有算法；测试依据为 [`tuf-conformance`](https://github.com/theupdateframework/tuf-conformance)。两者必须分别保存测试报告。

CLI、浏览器与镜像持久化高水位。清空浏览器数据/更换信任根会丢失本地历史。现版本严格拒绝多序号跳跃，缺少中间历史时需受控恢复，不能静默信任新头。生产仍需完善历史追赶与根历史分发。

离线模式按最后一次成功验证时间复查保存的包，并明确展示历史状态；任何当前推荐和出站资格不得依赖离线状态。网页和根公钥都可被恶意镜像替换，必须在可信客户端和独立渠道核对根指纹；不能由该网页宣称自己安全。

## 离线签名工具

`pnpm key:new <新私钥文件>` 在当前机器创建 Ed25519 私钥及独立公钥文件；私钥文件权限为 0600，并拒绝覆盖。生产运行必须放在由该人员独立控制的离线环境；本次没有生成或分配生产密钥。

`pnpm sign <待签载荷.json> <私钥JWK.json> <新签名.json> business` 生成业务签名；最后一个参数为 `tuf` 时生成 TUF 签名。工具只输出签名文件位置和公钥编号。每人独立核对载荷后签署，不在后台代签。

`pnpm release:prepare <批准对象及业务签名.json> <可信根.json> <根签署的人员授权.json> <构建目录> <序号> <前摘要或null> [门槛证明.json]` 验证授权后准备包及 `targets.unsigned.json`。生产对象没有十项门槛的根阈值证明会失败。Targets 签名聚合与存储分发由 `publisher.ts` 提供，尚需接入实际运营交接界面和目标 R2 资源。
