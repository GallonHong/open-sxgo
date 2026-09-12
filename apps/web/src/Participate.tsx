import React, { useState } from 'react';
export function Participate() {
 const [saved,setSaved]=useState(false);
 return <section className="reading"><div className="eyebrow">参与资料整理</div><h1>提交前，整理好来源。</h1>
 <p>公开投稿服务尚未开放。可以先下载一份资料草稿，保存在自己的设备上；此页面不会上传内容。</p>
 <form className="panel" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);const value={project:'open sxgo',kind:f.get('kind'),legal_name:f.get('name'),scope:f.get('scope'),source_urls:String(f.get('sources')).split('\n').filter(Boolean),summary:f.get('summary')};const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='open-sxgo-draft.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setSaved(true)}}>
 <label>资料类型<select name="kind"><option>企业资料</option><option>信息纠错</option><option>来源更新</option></select></label>
 <label>企业完整名称<input name="name" required maxLength={200}/></label>
 <label>适用城市与岗位<input name="scope" required maxLength={200} placeholder="不确定的项目请写“待确认”"/></label>
 <label>公开来源地址<textarea name="sources" required maxLength={4000} placeholder="每行一个公开网页地址"/></label>
 <label>资料说明<textarea name="summary" required maxLength={2000} placeholder="只描述公开资料能支持的事实，不填写个人信息。"/></label>
 <button>下载资料草稿</button>{saved&&<p role="status">草稿已生成，请在浏览器下载记录中确认。尚未提交到服务器。</p>}</form>
 <section className="info-section"><h2>代码与文档贡献</h2><p>可以通过公开仓库报告页面问题或提交改进。请勿在公开议题中放入回执、员工信息或私密证据。</p><a href="https://github.com/GallonHong/open-sxgo" target="_blank" rel="noopener noreferrer">查看 open sxgo 仓库 ↗</a></section></section>
}
