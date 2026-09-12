import { cp, rm } from 'node:fs/promises';
// Sites hosts the read-only public build. Private workspaces deploy separately.
await rm('dist/client', { recursive:true, force:true });
await cp('dist/web','dist/client',{recursive:true});
