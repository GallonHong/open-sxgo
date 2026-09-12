import React from 'react';
import { Link, useLocation } from 'react-router-dom';

const sections = [
  ['', '参与贡献'],
  ['rules', '规则与资格'],
  ['proposals', '治理提案'],
  ['roles', '职责与授权'],
  ['mirrors', '公共节点'],
  ['transparency', '透明报告'],
] as const;
const fields = [
  ['资料与纠错', '核对主体、适用岗位和来源，补充实质变化。未能支持收录的认真核验也有价值。'],
  ['审核与培训', '学习合成案例，独立核对来源，明确不知道的部分。'],
  ['代码与文档', '修复问题、完善解释、改善无障碍体验，以实际工作认定贡献。'],
  ['节点与恢复', '提供可验证公共副本，记录服务周期，参与恢复演练。'],
  ['安全与治理', '私密报告风险，参与规则审阅，保护提出不同意见的人。'],
];
export function Community() {
  const section = useLocation().pathname.split('/')[2] ?? '';
  return (
    <section>
      <div className="eyebrow">open sxgo / 参与共建</div>
      <h1>参与共建</h1>
      <p className="lead">贡献可以成为申请责任的依据。每一项权限，都需要独立评估与明确授权。</p>
      <div className="message">建设阶段 · 独立治理尚未就绪</div>
      <nav aria-label="社区栏目" className="community-nav">
        {sections.map(([path, title]) => (
          <Link
            key={path}
            aria-current={section === path ? 'page' : undefined}
            to={'/community' + (path ? '/' + path : '')}
          >
            {title}
          </Link>
        ))}
      </nav>
      {section === '' ? (
        <>
          <p><Link className="button" to="/contribute">整理一份资料</Link> <a className="button ghost" href="https://github.com/GallonHong/open-sxgo">参与代码与文档</a></p><div className="community-grid">
            {fields.map(([title, description], index) => (
              <article className="panel" key={title}>
                <div className="eyebrow">0{index + 1}</div>
                <h2>{title}</h2>
                <p>{description}</p>
              </article>
            ))}
          </div>
          <section className="panel">
            <h2>从参与，到承担责任</h2>
            <p>提交工作 → 去重与认定 → 培训或等效申请 → 独立评估 → 限时授权</p>
            <p>
              提交数量、捐献金额、服务器数量不会自动兑换审核权或选票。你可以拒绝超出能力的任务，也可以退出。
            </p>
          </section>
        </>
      ) : section === 'rules' ? (
        <section className="panel">
          <h2>共同遵守的规则</h2>
          <ul>
            <li>每份公开事实候选需要同一版本的独立双审。</li>
            <li>贡献按领域认定，不设可交易总积分和排行榜。</li>
            <li>角色有范围与有效期，历史贡献不会随到期消失。</li>
            <li>提供理由、纠错与独立申诉；合理异议不受惩罚。</li>
            <li>署名自愿，匿名线索不会自动关联公开成员身份。</li>
            <li>当前不接收内部附件，也不通过邮件或私聊绕行收取。</li>
          </ul>
          <p className="muted">
            当前展示开发章程说明。具有执行效力的政策须经批准并作为签名公共包发布。
          </p>
        </section>
      ) : (
        <section className="panel">
          <h2>{sections.find(([path]) => path === section)?.[1] ?? '社区'}</h2>
          <p>尚无已验证的公开治理记录。</p>
          <p className="muted">
            成员资格、提案通过和节点运行不会因演示页面而被视为真实有效。公开记录将在独立审批及签名发布后展示。
          </p>
          {section === 'transparency' && (
            <p>
              私人贡献细分不足五人时不公开；公开汇总至少延迟七天。系统不公布个人案件轨迹、排班或雇主关系。
            </p>
          )}
          {section === 'mirrors' && (
            <p>
              节点只提供公共内容。社区镜像不得收取管理员凭据、回执或私人材料；节点数量不等于独立副本数量。
            </p>
          )}
        </section>
      )}
    </section>
  );
}
