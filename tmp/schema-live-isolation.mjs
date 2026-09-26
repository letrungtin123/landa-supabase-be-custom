// Diagnostic only. No private source reads, writes, admission, persistence or Apply.
process.env.NODE_ENV = 'production';
process.env.PGOPTIONS = '-c default_transaction_read_only=on';
const {pool} = await import('../dist/config/database.js');
const {decryptAiProviderKey} = await import('../dist/modules/ai-chatbot/ai-secret.service.js');
const {spawn} = await import('node:child_process');
const {randomUUID} = await import('node:crypto');
try {
  if(process.argv[2] !== '--authorized-synthetic') throw new Error('AUTHORIZATION_REQUIRED');
  const cases=process.argv[3].split(',');
  const start=Number(process.argv[4]);
  if(!Number.isInteger(start)||start<1||start+cases.length-1>10) throw new Error('CALL_CAP');
  const {rows:[d]} = await pool.query(`SELECT d.model,s.lesson_author_model,k.encrypted_api_key
    FROM lesson_author_chapter_drafts d JOIN tenant_ai_settings s ON s.tenant_id=d.tenant_id
    JOIN tenant_ai_provider_secrets k ON k.tenant_id=s.tenant_id AND k.provider=s.provider
    WHERE d.id=$1 AND d.tenant_id=$2`,['ae11652f-24ef-40da-841b-a89bff559c33','4c8ebffd-c9e3-4c2f-bbef-adb45fa13ee3']);
  if(!d||d.model!==d.lesson_author_model) throw new Error('RUNTIME_MISMATCH');
  const child=spawn('../landa-ai-rag/.venv/Scripts/python.exe',['-X','utf8','-B','tmp/schema_live_isolation.py'],
    {cwd:'../landa-ai-rag',stdio:['pipe','pipe','pipe'],windowsHide:true});
  child.stdout.pipe(process.stdout); // child contract: safe metadata only
  let stderrBytes=0;
  child.stderr.on('data',chunk=>stderrBytes+=chunk.length);
  child.stdin.end(JSON.stringify({model:d.model,api_key:decryptAiProviderKey(d.encrypted_api_key),cases,
    start_number:start,correlation_id:randomUUID()}));
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  console.log(JSON.stringify({event:'probe_process_exit',code,stderr_bytes:stderrBytes}));
  process.exitCode=code||0;
} catch(error) {
  console.log(JSON.stringify({event:'local_probe_failure',error_type:error.constructor.name}));
  process.exitCode=1;
} finally {await pool.end();process.exit(process.exitCode||0);}
