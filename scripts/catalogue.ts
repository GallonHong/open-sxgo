import type { Dataset, Claim } from '../packages/protocol/src/public';
/** Public factual reference record; never a positive labour assessment. */
export function catalogueDataset(): Dataset {
  const checked = '2026-09-12';
  const dimensions: Claim['dimension'][] = ['rest_schedule','written_contract_policy','working_hours_policy','overtime_payment_practice','salary_policy','social_insurance_policy','annual_leave_policy'];
  return {
    schema_version:'1.0', demo:true,
    companies:[{
      company_id:'co_apple_beijing', legal_name:'苹果电子产品商贸（北京）有限公司',
      jurisdiction:'CN', public_identifier:'Apple 中国大陆销售政策所列主体；登记信息待复核',
      aliases:['Apple','苹果'],industry:'消费电子',entity_status:'pending',official_website_link_id:null,brand_ids:[],
      scopes:[{scope_id:'sc_apple_beijing',company_id:'co_apple_beijing',city:'北京',city_code:'110100',site_label:'具体工作场所待确认',job_group:'岗位范围待确认',employment_type:'unknown',work_time_regime:'special_regime_pending_review',listing_state:'recheck_required',record_revision:2,
        limitations:['本记录仅整理官方页面提及的中国大陆法律主体，不构成劳动友好推荐。','北京为主体名称所示地域，不代表已核实员工工作地点。','Apple 大中华区汇总数据、零售招聘说明与全球福利概述，不等于本法律主体及具体岗位的执行证明。','已核对中国报告和招聘原文；仍缺具体门店的劳动合同雇主、薪酬数字、社保缴费明细、年假天数及实际排班。','招聘页允许晚间、周末和公共节假日排班，不能标注为已核实周末双休。','不涵盖 Apple Inc.、其他关联公司、经销商、供应商或外包团队。'],
        claims:dimensions.map(d=>({claim_id:'cl_apple_'+d,scope_id:'sc_apple_beijing',dimension:d,value:null,evidence_status:'unknown',source_ids:[],checked_on:null,valid_from:null,valid_until:null,rule_version:'cn-reference-v1'}))}]
    }],
    sources:[
      {source_id:'src_apple_identity',url:'https://www.apple.com.cn/legal/sales-support/sales-policies/retail_cn.html',title:'中国大陆 Apple Store 零售销售政策',summary:'官方政策将北京商贸公司与上海贸易公司列为 Apple Store 零售店所有方。',applicability:'仅确认零售业务关联；未核实工商登记，也不能据此确定某家门店或招聘岗位的劳动合同雇主。'},
      {source_id:'src_apple_csr2025',url:'https://www.apple.com.cn/job-creation/Apple_China_CSR_Report_2025.pdf',title:'Apple 中国企业责任报告 2024–2025 · 第 44、47、68–69 页',summary:'报告披露 Apple 大中华区劳动合同签订率、社会保险缴纳率均为 100%；介绍带薪病假、亲子及照护假和员工健康支持。',applicability:'企业自报的区域汇总。报告主要覆盖 2024 年 5 月至 2025 年 4 月，数据口径见附录；没有北京主体单独数据、缴费明细、年假天数或独立执行佐证。'},
      {source_id:'src_apple_retail_benefits',url:'https://www.apple.com/careers/cn/work-at-apple/retail.html',title:'Apple 中国职业页面 · 零售团队福利',summary:'页面介绍全职和兼职零售团队的福利，包括带薪病假、年假和亲子假；另提及培训、股票计划与员工折扣。',applicability:'招聘宣传与福利概述，未列明本主体具体条款、假期天数、适用门店和生效时间。'},
      {source_id:'src_apple_benefits_limits',url:'https://www.apple.com/careers/cn/life-at-apple/benefits.html',title:'Apple 员工福利 · 地区与资格限制',summary:'Apple 明确说明福利因国家或地区而异，需满足资格条件，并可能变更。',applicability:'中文页面不代表所有中国员工均享有每项福利；不能套用美国待遇、退休计划或园区设施。'},
      {source_id:'src_apple_retail_schedule',url:'https://jobs.apple.com/zh-cn/details/200678946/cn-expert',title:'西安 CN-资深专家 · 职位 200678946',published_on:'2026-08-20',summary:'招聘要求可按业务需要在晚间、周末和公共节假日到店，按排定班次工作。',applicability:'仅是该西安零售职位的招聘要求，不是北京主体的实际排班或工时证据；每周休息天数仍未知，不能推定周末双休。'},
    ].map(source=>({...source,publisher:'Apple',published_on:source.published_on??null,checked_on:checked,source_family:'family_apple',kind:'company' as const,supported_claim_ids:[],related_company_ids:['co_apple_beijing']})),
    brands:[],relations:[],stores:[],products:[],links:[],decisions:[],mirrors:[],
    rules:[{rule_version:'cn-reference-v1',jurisdiction:'CN',effective_from:checked,effective_to:null,reviewed_on:checked,sources:[],policy_ttl_days:180,practice_ttl_days:90,warning_days:30,metadata_ttl_hours:48,demo:true}]
  };
}
