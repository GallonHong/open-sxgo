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
      scopes:[{scope_id:'sc_apple_beijing',company_id:'co_apple_beijing',city:'北京',city_code:'110100',site_label:'具体工作场所待确认',job_group:'岗位范围待确认',employment_type:'unknown',work_time_regime:'special_regime_pending_review',listing_state:'recheck_required',record_revision:1,
        limitations:['本记录仅整理官方页面提及的中国大陆法律主体，不构成劳动友好推荐。','北京为主体名称所示地域，不代表已核实员工工作地点。','Apple 美国福利页面不适用于推断此主体的休息安排、合同、工时或实际执行。','不涵盖 Apple Inc.、其他关联公司、经销商、供应商或外包团队。'],
        claims:dimensions.map(d=>({claim_id:'cl_apple_'+d,scope_id:'sc_apple_beijing',dimension:d,value:null,evidence_status:'unknown',source_ids:[],checked_on:null,valid_from:null,valid_until:null,rule_version:'cn-reference-v1'}))}]
    }],
    sources:[{source_id:'src_apple_identity',url:'https://www.apple.com.cn/shop/open/salespolicies',title:'Apple 中国大陆销售和退款政策',publisher:'Apple',published_on:null,checked_on:checked,source_family:'family_apple',kind:'company',supported_claim_ids:[]}],
    brands:[],relations:[],stores:[],products:[],links:[],decisions:[],mirrors:[],
    rules:[{rule_version:'cn-reference-v1',jurisdiction:'CN',effective_from:checked,effective_to:null,reviewed_on:checked,sources:[],policy_ttl_days:180,practice_ttl_days:90,warning_days:30,metadata_ttl_hours:48,demo:true}]
  };
}
