import assert from 'node:assert/strict';
import test from 'node:test';

test('workspace existing-only runtime settings perform SELECT only; legacy initialization remains opt-in by default',async t=>{
  const pg=await import('pg');
  const calls:string[]=[];let missing=false;
  t.mock.method(pg.default.Pool.prototype,'connect',()=>{throw new Error('REAL_DATABASE_FORBIDDEN');});
  t.mock.method(pg.default.Pool.prototype,'query',async(sql:string)=>{
    calls.push(sql);
    if(sql.trimStart().startsWith('INSERT'))return{rows:[],rowCount:0};
    assert.match(sql,/FROM tenant_ai_settings s/);
    return{rows:missing?[]:[{tenant_id:'fixture',active_engine:'self_built_rag',provider:'google',monthly_token_limit:null,
      token_timezone:'Asia/Ho_Chi_Minh',chat_model:'fixture-chat',lesson_author_model:'fixture-lesson',
      embedding_model:'gemini-embedding-001',embedding_dimensions:768,transition_state:'idle',active_transition_job_id:null,
      encrypted_api_key:'opaque-fixture-not-decrypted',api_key_fingerprint:'fixture-fingerprint'}]};
  });
  const {getTenantAiRuntimeSettings}=await import('./ai-settings.service.js');
  const result=await getTenantAiRuntimeSettings('fixture',{requireExisting:true});
  assert.equal(result.lessonAuthorModel,'fixture-lesson');assert.equal(result.hasGoogleAiStudioKey,true);
  assert.equal(calls.length,1);assert.ok(calls.every(sql=>sql.trimStart().startsWith('SELECT')));
  calls.length=0;missing=true;
  await assert.rejects(getTenantAiRuntimeSettings('fixture',{requireExisting:true}),{code:'AI_SETTINGS_NOT_FOUND'});
  assert.equal(calls.length,1);assert.ok(calls.every(sql=>sql.trimStart().startsWith('SELECT')));
  calls.length=0;missing=false;await getTenantAiRuntimeSettings('fixture');
  assert.equal(calls.length,2);assert.match(calls[0],/INSERT INTO tenant_ai_settings/);assert.match(calls[1],/SELECT/);
});
