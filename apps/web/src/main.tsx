import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Routes, Route, useParams, useSearchParams } from 'react-router-dom';
import { loadDirectory, type Loaded } from './data';
import { search, type Filters } from '../../../packages/search/src/index';
import {
  dimensionLabels,
  statusLabels,
  validClaim,
  eligible,
  usableLink,
} from '../../../packages/domain/src/index';
import type { Company, Scope } from '../../../packages/protocol/src/public';
import './style.css';
import { Community } from './Community';
import { Participate } from './Participate';
const intake = import.meta.env.VITE_INTAKE_ORIGIN || (import.meta.env.DEV ? 'http://127.0.0.1:5174' : '');
const shortDate = (date: string) => date.replaceAll('-', '.');
function App() {
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState('');
  useEffect(() => {
    loadDirectory()
      .then(setLoaded)
      .catch((e) => setError(e.message));
    const timer = setInterval(
      () =>
        setLoaded((current) =>
          current && Date.parse(current.manifest.expires_at) <= Date.now()
            ? { ...current, historical: true, notice: '发布元数据已到期，当前仅显示历史资料。' }
            : current,
        ),
      30000,
    );
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <div className="demo-strip">受邀测试准备版 · 企业资料尚待独立双审</div>
      <header>
        <Link className="wordmark" to="/">
          <span className="mark">sx</span>open sxgo
        </Link>
        <nav>
          <Link to="/companies">找企业</Link>
          <Link to="/methodology">核验方法</Link>
          <Link to="/community">参与共建</Link>
        </nav>
        <a className="button small ghost" href={intake + '/contribute'}>
          ＋ 推荐企业
        </a>
      </header>
      <div className="page">
        {error ? (
          <section className="empty" role="alert">
            <h1>暂时无法验证目录</h1>
            <p>没有可用的已验证数据。请稍后重试。</p>
            <code>{error}</code>
            <button onClick={() => location.reload()}>重新获取</button>
          </section>
        ) : !loaded ? (
          <section className="loading" role="status">
            正在核对数据来源与完整性…
          </section>
        ) : (
          <>
            <div className={'data-line ' + (loaded.historical ? 'warning' : '')}>
              <span>
                {loaded.historical ? '历史副本' : '公开资料'} /{' '}
                {shortDate(loaded.manifest.issued_at.slice(0, 10))}
              </span>
              <Link to="/data">{loaded.notice} ↗</Link>
            </div>
            <Routes>
              <Route path="/contribute" element={<Participate />} />
              <Route path="/report" element={<Participate />} />
              <Route path="/community/*" element={<Community />} />
              <Route path="/" element={<Directory loaded={loaded} />} />
              <Route path="/companies" element={<Directory loaded={loaded} />} />
              <Route path="/companies/:id" element={<Detail loaded={loaded} />} />
              <Route path="/scopes/:id" element={<Detail loaded={loaded} scopeOnly />} />
              <Route path="/out/:id" element={<Outbound loaded={loaded} />} />
              <Route path="/data" element={<DataPage loaded={loaded} />} />
              <Route path="/mirrors" element={<Info kind="mirrors" />} />
              <Route path="/privacy" element={<Info kind="privacy" />} />
              <Route path="/about" element={<Info kind="about" />} />
              <Route path="/methodology" element={<Info kind="methodology" />} />
              <Route path="/pilot" element={<Info kind="pilot" />} />
              <Route
                path="*"
                element={
                  <section className="empty">
                    <h1>找不到这个页面</h1>
                    <Link to="/">返回目录</Link>
                  </section>
                }
              />
            </Routes>
          </>
        )}
      </div>
      <footer>
        <div>
          <strong>open sxgo / 企业资料目录</strong>
          <p>有来源，有范围，有时效。</p>
        </div>
        <div>
          <Link to="/privacy">隐私与数据</Link>
          <Link to="/mirrors">镜像与参与</Link>
          <Link to="/about">关于项目</Link>
          <Link to="/pilot">受邀测试说明</Link>
          <a href={intake + '/report'}>纠错与申诉</a>
        </div>
        <p className="disclaimer">
          本目录不构成对企业全部劳动行为的法律认证。未收录不表示企业违法。
        </p>
      </footer>
    </>
  );
}
function Directory({ loaded }: { loaded: Loaded }) {
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState(params.toString());
  useEffect(() => setDraft(params.toString()), [params]);
  const selectedParams = new URLSearchParams(draft);
  const reset = () => {
    setDraft('');
    setParams({});
  };
  const f: Filters = {
    q: selectedParams.get('q') || '',
    city: selectedParams.get('city') || '',
    industry: selectedParams.get('industry') || '',
    job: selectedParams.get('job') || '',
    rest: selectedParams.get('rest') || '',
    evidence: selectedParams.get('evidence') || '',
    history: true,
  };
  const update = (key: string, value: string) => {
    const p = new URLSearchParams(draft);
    value ? p.set(key, value) : p.delete(key);
    setDraft(p.toString());
    setParams(p, { replace: true });
  };
  const results = search(loaded.data.companies, f).filter(c => selectedParams.get('qualified') !== 'true' || (!loaded.historical && c.scopes.some(s => eligible(s))));
  const cities = [...new Set(loaded.data.companies.flatMap((c) => c.scopes.map((s) => s.city)))];
  return (
    <>
      <section className="intro">
        <div>
          <div className="eyebrow">企业资料目录</div>
          <h1>先了解，再判断。</h1>
          <p>查阅企业公开资料，逐项核对工作条件。</p>
        </div>
        <Link to="/methodology" className="method-note">
          <span>我们如何核验？</span>
          <p>
            公开制度 ≠ 实际执行
            <br />
            每一条信息，都有适用边界。
          </p>
          <b>了解收录标准 ↗</b>
        </Link>
      </section>
      <div className="directory-layout">
        <aside>
          <div className="aside-title">
            筛选企业
            <button className="text-button" onClick={reset}>
              重置
            </button>
          </div>
          <label>
            所在城市
            <select value={f.city} onChange={(e) => update('city', e.target.value)}>
              <option value="">所有城市</option>
              {cities.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            行业
            <select value={f.industry} onChange={(e) => update('industry', e.target.value)}>
              <option value="">所有行业</option>
              {[...new Set(loaded.data.companies.map((c) => c.industry))].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            岗位范围
            <select value={f.job} onChange={(e) => update('job', e.target.value)}>
              <option value="">所有岗位</option>
              {[
                ...new Set(loaded.data.companies.flatMap((c) => c.scopes.map((s) => s.job_group))),
              ].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>休息安排</legend>
            {[
              ['', '不限'],
              ['weekend', '周末双休'],
              ['two_days', '每周两天休息'],
            ].map(([value, label]) => (
              <label className="check" key={value}>
                <input
                  type="radio"
                  name="rest"
                  checked={f.rest === value}
                  onChange={() => update('rest', value)}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <label>
            证据等级
            <select value={f.evidence} onChange={(e) => update('evidence', e.target.value)}>
              <option value="">所有等级</option>
              <option value="source_checked">公开资料已核对</option>
              <option value="practice_corroborated">实践有交叉佐证</option>
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={selectedParams.get('qualified') === 'true'}
              onChange={(e) => update('qualified', e.target.checked ? 'true' : '')}
            />
            仅查看符合收录条件的记录
          </label>
          <div className="aside-note">
            范围之外，不作推断。
            <br />
            请在详情中核对城市、岗位
            <br />
            和信息有效期。
          </div>
        </aside>
        <section className="results">
          <div className="searchbox">
            <span aria-hidden="true">⌕</span>
            <input
              aria-label="搜索企业"
              placeholder="搜索企业全名、品牌、别名或城市"
              value={f.q}
              onChange={(e) => update('q', e.target.value)}
            />
            <kbd>搜索</kbd>
          </div>
          <div className="results-heading">
            <span>
              <strong>{results.length}</strong> 家企业
              <span className="muted">
                {' '}
                · {loaded.historical ? '历史资料' : '公开资料记录 · 不等于推荐名单'}
              </span>
            </span>
            <span className="muted">按相关性与核验时间排序</span>
          </div>
          <div className="cards">
            {results.map((c, i) => (
              <CompanyCard
                key={c.company_id}
                company={c}
                index={i}
                historical={loaded.historical}
              />
            ))}
            {!results.length && (
              <div className="empty">
                <h2>暂时没有匹配的记录</h2>
                <p>未收录不代表企业不符合条件或违法。试试其他筛选。</p>
                <button onClick={reset}>清除筛选</button>
              </div>
            )}
          </div>
          <div className="bottom-note">
            只展示资料能够支持的结论。发现信息变化？<a href={intake + '/report'}>告诉我们 ↗</a>
          </div>
        </section>
      </div>
    </>
  );
}
function CompanyCard({
  company: c,
  index,
  historical,
}: {
  company: Company;
  index: number;
  historical: boolean;
}) {
  const scope = c.scopes[0];
  const rest = scope.claims.find((x) => x.dimension === 'rest_schedule');
  const weekend =
    rest &&
    typeof rest.value === 'object' &&
    rest.value?.usual_rest_days.includes('saturday') &&
    rest.value.usual_rest_days.includes('sunday');
  const contract = scope.claims.find((x) => x.dimension === 'written_contract_policy');
  const active = !historical && scope.listing_state === 'active';
  return (
    <article className="company-card">
      <div className="card-top">
        <span className={'company-icon tone-' + (index % 4)}>
          {(c.aliases[0] ?? c.legal_name).slice(0, 1)}
        </span>
        <span className="category">{c.industry}</span>
      </div>
      <Link className="card-title" to={'/companies/' + c.company_id}>
        {c.legal_name}
        <span>↗</span>
      </Link>
      <p className="scope-line">
        {scope.city} <span>/</span> {scope.job_group}
      </p>
      <div className="tags">
        <span className="tag blue">
          {!active
            ? (historical ? '历史资料' : '待核实')
            : !rest || !validClaim(rest)
              ? '休息安排未知或到期'
              : weekend
                ? '周末双休'
                : typeof rest.value === 'object' && rest.value?.usual_rest_days_per_week === 2
                  ? '每周两天轮休'
                  : '见休息安排'}
        </span>
        <span className="tag">
          {contract && validClaim(contract) ? '书面合同制度' : '合同情况未知或到期'}
        </span>
      </div>
      <div className="card-evidence">
        <span className="evidence-symbol">▤</span>
        {historical ? '历史资料，仅供参考' : eligible(scope) ? '公开资料已核对' : '劳动条件尚待核实'}
        <span className="evidence-help">资料状态</span>
      </div>
      <div className="card-bottom">
        <span>{rest?.checked_on ? '核验 ' + rest.checked_on : '暂无劳动条件核验记录'}</span>
        <Link to={'/companies/' + c.company_id}>查看适用范围 →</Link>
      </div>
    </article>
  );
}
function Detail({ loaded, scopeOnly = false }: { loaded: Loaded; scopeOnly?: boolean }) {
  const { id } = useParams();
  const company = loaded.data.companies.find((c) =>
    scopeOnly ? c.scopes.some((s) => s.scope_id === id) : c.company_id === id,
  );
  const [selected, setSelected] = useState('');
  if (!company) return <div className="empty">没有此公开记录</div>;
  const scope =
    company.scopes.find((s) => s.scope_id === (scopeOnly ? id : selected)) ?? company.scopes[0];
  return (
    <section className="detail">
      <Link className="breadcrumb" to="/companies">
        ← 企业目录
      </Link>
      <div className="detail-head">
        <span className="company-icon large">
          {(company.aliases[0] ?? company.legal_name).slice(0, 1)}
        </span>
        <div>
          <div className="eyebrow">
            {company.industry} · {company.public_identifier}
          </div>
          <h1>{company.legal_name}</h1>
          <p>{company.aliases.join(' / ')}</p>
        </div>
      </div>
      <div className="notice">
        {loaded.historical
          ? '正在查看历史副本，不作为当前推荐依据。'
          : eligible(scope) ? '已核对公开制度资料，不代表实际执行情况已获证实。' : '企业资料参考记录。劳动条件尚待核实，当前不在推荐名单内。'}
      </div>
      <div className="detail-columns">
        <div>
          <section className="panel">
            <h2>
              劳动条件 <span className="muted">/ 适用范围</span>
            </h2>
            <label>
              查看范围
              <select value={scope.scope_id} onChange={(e) => setSelected(e.target.value)}>
                {company.scopes.map((s) => (
                  <option key={s.scope_id} value={s.scope_id}>
                    {s.city} · {s.job_group} · {s.employment_type === 'full_time_employee' ? '全日制员工' : '用工类型待确认'}
                  </option>
                ))}
              </select>
            </label>
            <div className="claim-table">
              {scope.claims.map((c) => (
                <div className="claim-row" key={c.claim_id}>
                  <div>
                    <strong>{dimensionLabels[c.dimension]}</strong>
                    <p>
                      {typeof c.value === 'string'
                        ? c.value
                        : typeof c.value === 'object' && c.value
                          ? `通常每周休息 ${c.value.usual_rest_days_per_week} 天，${c.value.usual_rest_days.includes('saturday') ? '周六、周日' : '轮休'}`
                          : '该主体与岗位的制度及实际执行仍待核实'}
                    </p>
                  </div>
                  <span className={'tag ' + (validClaim(c) ? 'blue' : '')}>
                    {
                      statusLabels[
                        c.evidence_status === 'unknown'
                          ? 'unknown'
                          : validClaim(c)
                            ? c.evidence_status
                            : 'expired'
                      ]
                    }
                  </span>
                  <small>{c.valid_until ? '有效至 ' + c.valid_until : '无有效核验记录'}</small>
                </div>
              ))}
            </div>
          </section>
          <section className="panel">
            <h2>已找到的公开资料</h2>
            <p className="muted">核对到原文不等于核实执行。以下背景资料不会自动计入推荐资格；Apple 自有页面属于同一来源家族。</p>
            {loaded.data.sources
              .filter((s) =>
                s.supported_claim_ids.some((id) => scope.claims.some((c) => c.claim_id === id)) || s.related_company_ids?.includes(company.company_id) || (company.company_id === 'co_apple_beijing' && s.source_id === 'src_apple_identity'),
              )
              .map((s) => (
                <div className="source" key={s.source_id}>
                  <strong>{s.title}</strong>
                  {s.summary && <p>{s.summary}</p>}
                  {s.applicability && <p><strong>适用边界：</strong>{s.applicability}</p>}
                  <p>
                    {s.publisher} · {s.kind === 'company' ? '企业自有资料' : '第三方资料'}
                  </p>
                  <p>
                    发布 {s.published_on ?? '日期未知'} / 核对 {s.checked_on}
                  </p>
                  <a href={s.url} target="_blank" rel="noopener noreferrer">
                    查看来源 ↗
                  </a>
                </div>
              ))}
          </section>
        </div>
        <div>
          <section className="panel">
            <h2>核验边界</h2>
            {scope.limitations.map((t) => (
              <p key={t}>{t}</p>
            ))}
            <hr />
            <p>加班报酬、社保实际缴纳等未知事项，不因双休制度而自动通过。</p>
          </section>
          <section className="panel">
            <h2>资料使用说明</h2>
            {company.official_website_link_id && (
              <Link className="button ghost full" to={'/out/' + company.official_website_link_id}>
                企业官网 ↗
              </Link>
            )}
            {company.brand_ids.map((b) => (
              <Link className="brand-link" key={b} to={'/brands/' + b}>
                {loaded.data.brands.find((x) => x.brand_id === b)?.name} →
              </Link>
            ))}
            <p className="muted">主体来源只支持身份线索，不支持劳动条件结论。请从左侧公开来源查看原文。</p>
          </section>
          <a className="button ghost full" href={intake + '/report?record_id=' + scope.scope_id}>
            信息可能已变化
          </a>
        </div>
      </div>
    </section>
  );
}
function Outbound({ loaded }: { loaded: Loaded }) {
  const { id } = useParams();
  const link = loaded.data.links.find((l) => l.link_id === id);
  if (!link) return <div className="empty">链接不存在或尚未核对</div>;
  const allowed = usableLink(link, loaded.data) && !loaded.historical;
  const company = loaded.data.companies.find((c) => c.company_id === link.seller_company_id);
  return (
    <section className="reading panel">
      <div className="eyebrow">离开目录之前</div>
      <h1>{loaded.historical ? '历史记录中的链接' : '即将访问企业网站'}</h1>
      <p>经营主体：{company?.legal_name}</p>
      <p className="url">{link.url}</p>
      <p>最近检查：{link.checked_on}</p>
      <p>本目录的劳动条件核验仅覆盖所列范围，不构成对商品质量、售后或完整供应链的保证。</p>
      {allowed && !loaded.data.demo ? (
        <a className="button" href={link.url} rel="noopener noreferrer" target="_blank">
          确认前往 ↗
        </a>
      ) : (
        <div className="notice">
          {loaded.data.demo
            ? '演示地址不会前往真实商家。'
            : '当前无法确认链接与推荐资格有效，出站已暂停。'}
        </div>
      )}
      <Link className="brand-link" to={'/companies/' + company?.company_id}>
        返回企业资料
      </Link>
    </section>
  );
}
function DataPage({ loaded }: { loaded: Loaded }) {
  return (
    <section className="reading">
      <div className="eyebrow">OPEN & VERIFIABLE</div>
      <h1>数据与验证</h1>
      <p>可下载、可验证、可镜像。公开包不包含投稿、回执或私密审核材料。</p>
      <section className="panel">
        <h2>版本 {loaded.manifest.release_id}</h2>
        <p>{loaded.notice}</p>
        <p>
          签发：{loaded.manifest.issued_at}
          <br />
          元数据到期：{loaded.manifest.expires_at}
        </p>
        {loaded.manifest.artifacts
          .filter((a) => ['directory.sqlite', 'companies.jsonl', 'rules.json'].includes(a.path))
          .map((a) => (
            <div className="download" key={a.path}>
              <a href={`/public/releases/${loaded.manifest.release_id}/${a.path}`} download>
                {a.path} ↓
              </a>
              <span>{(a.byte_length / 1024).toFixed(1)} KB</span>
              <code>{a.sha256}</code>
            </div>
          ))}
      </section>
      <p>此网页的提示无法证明网页代码本身可信。独立验证器与可信根指纹提供额外核对途径。</p>
    </section>
  );
}
const info: Record<string, { title: string; sections: [string, string][] }> = {
  pilot: {
    title: '受邀测试说明',
    sections: [
      ['本轮范围', '计划邀请 5–10 人，包含两名不同人员担任审核员。先完成账号、身份和访问范围配置，再安排一次 24 小时测试；当前尚未开放招募。'],
      ['阅读与提交', '先阅读苹果的公开来源和适用边界，再通过“推荐企业”提交公开资料或纠错。不要提交内部合同、工资条、身份信息或附件。妥善保存私密回执，用于查询、补充和撤回。'],
      ['独立审核', '两名审核员分别登录，完成双因素认证与安全密钥确认，核对同一版本的主体、岗位、来源和结论。利益冲突必须回避；同一人使用两个账号不算双审。账号与授权配置未完成前，审核测试不开始。'],
      ['测试与发布', '测试通过不等于正式上线，也不会自动将苹果列为劳动友好企业。推广和生产发布保持关闭。签名与数据完整性验证仅确认下载未被篡改，不证明劳动待遇或资料已获双人批准。'],
      ['时间与反馈', '在“数据与验证”查看本次发布有效期。测试必须在有效期内完成；到期后旧资料仅供历史浏览。发现错误可使用页脚的“纠错与申诉”；遇到隐私泄漏或越权，应停止相关测试并联系测试负责人。'],
    ],
  },
  methodology: {
    title: '核验方法',
    sections: [
      [
        '范围先于结论',
        '每条信息绑定法律主体、城市或场所、岗位群、用工类型与时间。总部、子公司、加盟店和外包团队不会自动共享结论。',
      ],
      [
        '制度与实践，分开展示',
        '企业公开文件可以支持制度声明。只有具备独立实践资料并完成双人审查，才能显示实践有交叉佐证。转载同一信息不算多个独立来源。',
      ],
      [
        '收录必须有依据',
        '至少两项劳动条件有公开资料支持，其中包含核心维度与积极制度；主体明确、来源可查，并由两名无利益冲突人员批准。',
      ],
      [
        '每条结论都有有效期',
        '公开制度默认 180 天复核，短期实践最长 90 天。变化反馈进入私密复核，必要时暂停相关范围的推荐。',
      ],
      ['没有收录，不代表不好', '资料不足是未知，不代表违法。双休也不等同于全部劳动行为合规。'],
    ],
  },
  privacy: {
    title: '隐私与数据',
    sections: [
      [
        '普通浏览不需要账号',
        '不采集精准位置、个人搜索历史、浏览企业序列和购买记录。浏览器只保存公共缓存。',
      ],
      [
        '投稿回执是访问钥匙',
        '不要求姓名、手机号或身份证。回执丢失且无恢复文件时无法找回，请妥善保存。不要向不可信镜像输入回执。',
      ],
      [
        '第一版不接收内部附件',
        '请勿上传合同、工资条、工号或同事信息。投稿原文只供授权审核，不进入公开数据包。',
      ],
      [
        '公开复制存在边界',
        '已公开数据可能被第三方复制，无法保证撤回全部副本。网络和云服务可能产生日志，不能保证绝对匿名。',
      ],
    ],
  },
  mirrors: {
    title: '镜像与恢复',
    sections: [
      ['只读与分权', '镜像仅提供经过验证的公共数据，不接收投稿，不取得审核或签名权限。'],
      [
        '独立比数量重要',
        '不同域名指向同一账号不构成独立副本。正式发布要求至少两个独立控制的完整副本。',
      ],
      [
        '验证后再切换',
        '同步检查根、阈值、版本、有效期、文件长度和摘要。失败保留旧副本并显示历史日期，分叉时暂停跟随。',
      ],
      ['当前为本地演示', '尚未登记真实独立镜像，也不宣称已完成多方治理或全球可访问。'],
    ],
  },
  about: {
    title: '关于 open sxgo',
    sections: [
      ['项目状态', 'open sxgo 正在建设中。企业资料来自公开来源；劳动条件尚待独立审核。签名基础设施仍使用测试信任根。'],
      ['商业边界', '不收认证费、排名费或购买佣金。赞助不能改变自然排序、审核标准与异议处理。'],
      [
        '参与与纠错',
        '欢迎提供范围明确的公开资料。信息变化、身份冒用、错误链接和隐私请求进入可信投稿站的分类处理流程。',
      ],
    ],
  },
};
function Info({ kind }: { kind: string }) {
  const value = info[kind];
  return (
    <section className="reading">
      <div className="eyebrow">WFD / {kind.toUpperCase()}</div>
      <h1>{value.title}</h1>
      {value.sections.map(([title, body]) => (
        <section className="info-section" key={title}>
          <h2>{title}</h2>
          <p>{body}</p>
        </section>
      ))}
    </section>
  );
}
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);

if (import.meta.env.PROD && 'serviceWorker' in navigator)
  void navigator.serviceWorker.register('/sw.js').catch(() => {});
