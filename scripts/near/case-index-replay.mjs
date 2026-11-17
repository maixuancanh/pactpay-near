import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,readFile,link,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {replayReferences} from '../../lib/near-case-index.mjs';
import {caseReader} from '../../lib/near-case-rpc.mjs';

// Local immutable, fsynced objects. A process killed before link leaves only an
// ignored temporary file; killed after link leaves the complete durable object.
export function diskStore(directory) {
  const root = resolve(directory);
  const path = key => join(root,createHash('sha256').update(key).digest('hex')+'.json');
  return {
    async get(key) {
      try { return JSON.parse(await readFile(path(key),'utf8')).value; }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async put(key,value) {
      await mkdir(root,{recursive:true});
      const temp = join(root,randomUUID()+'.tmp');
      const file = await open(temp,'wx');
      try { await file.writeFile(JSON.stringify({key,value})); await file.sync(); }
      finally { await file.close(); }
      try { await link(temp,path(key)); return true; }
      catch (error) { if (error.code === 'EEXIST') return false; throw error; }
      finally { await unlink(temp); }
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input,output,...extra] = process.argv.slice(2);
  if (!input || !output || extra.length) throw new Error('Usage: node scripts/near/case-index-replay.mjs references.json local-output-directory');
  const data = JSON.parse(await readFile(input,'utf8'));
  if (data.network !== 'testnet' || typeof data.escrow !== 'string' || !Array.isArray(data.references))
    throw new Error('Expected {network:"testnet",escrow,references:[{hash,signer}]}');
  const references = await replayReferences({reader:caseReader(AbortSignal.timeout(120000)),
    store:diskStore(output),escrow:data.escrow,references:data.references});
  console.log(JSON.stringify({coverage:'partial',source:'finalized-rpc',references},null,2));
}
