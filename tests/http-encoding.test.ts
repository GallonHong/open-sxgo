import {it,expect,vi,afterEach} from 'vitest';
import {fetchHTTP} from '../packages/verifier/src/index';
afterEach(()=>vi.unstubAllGlobals());
it('allows encoded overhead for tiny signed files',async()=>{vi.stubGlobal('fetch',async()=>new Response('[]',{headers:{'content-length':'22','content-encoding':'gzip'}}));expect(await fetchHTTP('https://example.org/','mirrors.json',2)).toEqual(new TextEncoder().encode('[]'));});
it('still rejects decompressed bytes above the signed limit',async()=>{vi.stubGlobal('fetch',async()=>new Response('oversized',{headers:{'content-length':'1','content-encoding':'gzip'}}));await expect(fetchHTTP('https://example.org/','mirrors.json',2)).rejects.toThrow('DOWNLOAD_TOO_LARGE');});
