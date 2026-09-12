import api from '../../api/src/worker';
import assets from 'virtual:site-assets';
export default {
  async fetch(request: Request, env: Parameters<typeof api.fetch>[1]) {
    const url = new URL(request.url);
    if (url.pathname === '/health' || url.pathname.startsWith('/private/v1/') || url.pathname.startsWith('/admin/v1/')) {
      try { return await api.fetch(request, env); }
      catch { return Response.json({error:{code:'SERVICE_UNAVAILABLE'}},{status:503,headers:{'Cache-Control':'no-store'}}); }
    }
    if (!['GET','HEAD'].includes(request.method)) return new Response(null,{status:405});
    const intake = ['/contribute','/receipt','/report'].includes(url.pathname);
    const admin = url.pathname === '/admin' || url.pathname.startsWith('/member/') || url.pathname.startsWith('/review/') || url.pathname.startsWith('/governance/');
    let path = url.pathname;
    if (intake) path='/intake.html';
    else if(admin) path='/admin.html';
    else if (!assets[path] && !/\.[a-z0-9]+$/i.test(path) && !path.startsWith('/public/')) path='/index.html';
    const asset=assets[path];
    if(!asset)return new Response('Not found',{status:404});
    const headers = new Headers({'Content-Type':asset.type,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':path.startsWith('/assets/')?'public,max-age=31536000,immutable':'no-store'});
    if(intake || admin)headers.set('Cache-Control','private,no-store');
    return new Response(request.method==='HEAD'?null:Uint8Array.from(atob(asset.base64),c=>c.charCodeAt(0)),{headers});
  },
  scheduled: api.scheduled,
};
