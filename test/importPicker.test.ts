import { afterEach, describe, expect, it, vi } from 'vitest';
import { importNamed } from '../src/vfs/save';
import { errorMessage } from '../src/util/errorMessage';

afterEach(()=>vi.unstubAllGlobals());
describe('map import picker',()=>{
  for (const name of ['guild1.zip','guild1.DS1']) it(`accepts ${name} in the combined Map picker`,async()=>{
    const bytes = new Uint8Array([1,2,3]);
    const handlers = new Map<string,()=>void>();
    const input = {style:{}, files:[{name,arrayBuffer:async()=>bytes.buffer}],addEventListener:(n:string,fn:()=>void)=>handlers.set(n,fn),click:()=>handlers.get('change')!(),remove:()=>{}};
    vi.stubGlobal('document',{createElement:()=>input,body:{appendChild:()=>{}}});
    vi.stubGlobal('setTimeout',()=>0);
    expect(await importNamed('ds1,zip')).toEqual({name,bytes});
  });
  it('describes both native and browser failures',()=>{
    expect(errorMessage('Access denied')).toBe('Access denied');
    expect(errorMessage(new Error('Invalid ZIP'))).toBe('Invalid ZIP');
    expect(errorMessage({message:'Missing file'})).toBe('Missing file');
    expect(errorMessage(undefined)).not.toContain('undefined');
  });
});
