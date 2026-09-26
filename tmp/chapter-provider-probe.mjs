// One explicitly authorized provider probe. Read-only DB; no persistence/Apply.
// Default is inspection only. Never prints request, secrets, or returned content.
process.env.NODE_ENV = 'production';
process.env.PGOPTIONS = '-c default_transaction_read_only=on';
const { env } = await import('../dist/config/env.js');
const { pool } = await import('../dist/config/database.js');
const { blueprintDraftArchitecture, normalizeLessonAuthorProposal, lockProposalToBlueprintChapter } = await import('../dist/modules/ai-chatbot/chat.service.js');
const { assertLessonAuthorProposalComponentsValid } = await import('../dist/modules/ai-chatbot/lesson-author-component-registry.logic.js');
const { assertLessonAuthorPedagogicalQuality } = await import('../dist/modules/ai-chatbot/lesson-author-pedagogical-validator.logic.js');
const { getTenantAllowedCourseComponentTypeSet } = await import('../dist/modules/tenants/tenant-course-components.service.js');
const { generationSnapshotHash } = await import('../dist/modules/ai-chatbot/lesson-author-generation-job.logic.js');
const { decryptAiProviderKey } = await import('../dist/modules/ai-chatbot/ai-secret.service.js');
const { randomUUID } = await import('node:crypto');
const { spawnSync } = await import('node:child_process');
const draftId = 'ad3f6818-1cf0-47bf-9a33-28a2f1019e6a';
if (process.argv[2] === '--columns') {
  const columns=await pool.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name IN ('lesson_author_chapter_drafts','lesson_author_chapter_attempts','system_prompt_templates') ORDER BY table_name,ordinal_position`);
  console.log(JSON.stringify(columns.rows));
  await pool.end(); process.exit(0);
}
try {
  const { rows: [d] } = await pool.query(`SELECT d.*, b.blueprint, b.source_documents, b.kb_id, b.bot_id,
    a.max_output_tokens, a.max_provider_attempts, a.user_message_id
    FROM lesson_author_chapter_drafts d
    JOIN lesson_author_blueprints b ON b.id=d.blueprint_id AND b.tenant_id=d.tenant_id AND b.course_id=d.course_id
    JOIN lesson_author_chapter_attempts a ON a.draft_id=d.id AND a.tenant_id=d.tenant_id
    WHERE d.id=$1 AND a.id=$2`, [draftId, 'c94b88ac-0d18-45e2-8bc6-cfc0ceca8c7c']);
  if (!d) throw new Error('DRAFT_NOT_FOUND');
  const architecture = blueprintDraftArchitecture({ blueprint: d.blueprint, chapterIndex: d.chapter_index });
  if (generationSnapshotHash(architecture) !== d.blueprint_hash) throw new Error('BLUEPRINT_HASH_MISMATCH');
  console.log(JSON.stringify({event:'readonly_probe_preflight', draft_id:d.id, blueprint_id:d.blueprint_id,
    chapter_index:d.chapter_index, total_units:d.total_units, architecture_hash_matches:true,
    source_document_count:d.source_documents.length, document_metadata_keys:Object.keys(d.source_documents[0]),
    max_output_tokens:d.max_output_tokens, max_attempts:d.max_provider_attempts, model:d.model, locale:d.locale,
    first_unit_components:architecture.lessons[0].units[0].component_plan.map(p=>({type:p.type,owned_count:p.source_fact_ids.length}))}));
  if (['--authorized-one-call','--authorized-local-one-call'].includes(process.argv[2])) {
    const { rows: [s] } = await pool.query(`SELECT s.*, k.encrypted_api_key FROM tenant_ai_settings s
      JOIN tenant_ai_provider_secrets k ON k.tenant_id=s.tenant_id AND k.provider=s.provider WHERE s.tenant_id=$1`,[d.tenant_id]);
    const { rows: [m] } = await pool.query('SELECT content FROM chat_messages WHERE id=$1 AND conversation_id=$2',[d.user_message_id,d.conversation_id]);
    const { rows: [p] } = await pool.query(`SELECT spt.prompt AS system_prompt FROM chat_conversations cc
      JOIN bot_personas bp ON bp.id=cc.persona_id JOIN system_prompt_templates spt ON spt.id=bp.template_id
      WHERE cc.id=$1 AND cc.tenant_id=$2`,[d.conversation_id,d.tenant_id]);
    if (!s?.encrypted_api_key || !m || !p || s.lesson_author_model !== d.model) throw new Error('RUNTIME_MISMATCH');
    const sources = d.source_documents.map(doc => ({document_id:doc.document_id,kb_id:doc.kb_id,name:doc.name,type:doc.type,status:doc.status}));
    const correlation = randomUUID();
    const request = {tenant_id:d.tenant_id,kb_id:d.kb_id,conversation_id:d.conversation_id,correlation_id:correlation,
      target:'lesson_author',model:d.model,max_output_tokens:Number(d.max_output_tokens),max_attempts:Number(d.max_provider_attempts),
      embedding_model:s.embedding_model,embedding_dimensions:s.embedding_dimensions,
      system_prompt:p.system_prompt+'\n\nYou are an Instructional Design expert. Build rigorous learner-centered course content from the provided source material. Return only a pending proposal for approval.',
      user_message:m.content,history:[],source_documents:sources,course_context:d.blueprint.course_title,
      blueprint_architecture:architecture,output_schema_hint:'Return only the approved chapter content as structured JSON.',
      operation:'create',target_type:'chapter',generation_mode:'staged',locale:d.locale,
      checkpoint_version:1,checkpoint_action:'generate_unit',checkpoint_unit_index:0,remaining_workflow_budget_ms:480000,
      api_key:decryptAiProviderKey(s.encrypted_api_key)};
    console.log(JSON.stringify({event:'authorized_probe_dispatch',correlation_id:correlation,unit_index:0,db_writes:false}));
    const started=Date.now();
    if (process.argv[2] === '--authorized-local-one-call') {
      const child=spawnSync('../landa-ai-rag/.venv/Scripts/python.exe',['-X','utf8','-B','tmp/chapter_provider_probe.py'],{
        cwd:'../landa-ai-rag',input:JSON.stringify(request),encoding:'utf8',timeout:490000,maxBuffer:8000000});
      if (child.status!==0) { console.log(JSON.stringify({event:'probe_child_failed',status:child.status,stderr_chars:child.stderr?.length})); process.exitCode=1; }
      else {
        const lines=child.stdout.split(/\r?\n/);
        const output=JSON.parse(lines.find(line=>line.startsWith('SAFE_PROBE_METADATA ')).slice('SAFE_PROBE_METADATA '.length));
        console.log(JSON.stringify({event:'probe_sdk_diagnostics',correlation_id:correlation,events:output.safe}));
        const result=JSON.parse(lines.find(line=>line.startsWith('PRIVATE_RESULT_JSON ')).slice('PRIVATE_RESULT_JSON '.length));
        console.log(JSON.stringify({event:'authorized_probe_result',correlation_id:correlation,http_status:output.status,
          duration_ms:Date.now()-started,status:result.status??null,code:result.detail?.code,
          internal_failure_code:result.detail?.internal_failure_code,failure_stage:result.detail?.failure_stage,
          component_count:result.unit?.components?.length??0,generation_http_calls:output.generation_http_calls,persisted:false}));
        if(result.probe_final?.status==='ready') {
          const context={blueprint:d.blueprint,chapterIndex:d.chapter_index};
          const proposal=lockProposalToBlueprintChapter(normalizeLessonAuthorProposal(result.probe_final.proposal),context);
          assertLessonAuthorProposalComponentsValid(proposal,await getTenantAllowedCourseComponentTypeSet(d.tenant_id));
          const quality=assertLessonAuthorPedagogicalQuality({proposal,blueprint_chapter:d.blueprint.chapters[d.chapter_index]});
          console.log(JSON.stringify({event:'authorized_probe_acceptance',python_final:result.probe_final.status,
            node_registry:'PASS',node_quality:quality?.status??'PASS',
            component_types:result.unit.components.map(c=>c.type),persisted:false}));
        }
      }
      await pool.end(); process.exit(process.exitCode||0);
    }
    const res=await fetch('http://127.0.0.1:8010/v1/lesson-author/chapter-checkpoint', {
      method:'POST',headers:{'Content-Type':'application/json','X-Landa-AI-Service-Token':env.AI_RAG_SERVICE_TOKEN},
      body:JSON.stringify(request),signal:AbortSignal.timeout(490000)});
    const result=await res.json();
    console.log(JSON.stringify({event:'authorized_probe_result',correlation_id:correlation,http_status:res.status,
      duration_ms:Date.now()-started,status:result.status??null,code:result.detail?.code,
      internal_failure_code:result.detail?.internal_failure_code,failure_stage:result.detail?.failure_stage,
      component_count:result.unit?.components?.length??0,persisted:false}));
  }
} catch(error) {
  console.log(JSON.stringify({event:'probe_failed_locally',error_type:error.constructor.name,
    code:typeof error.code==='string'&&/^[A-Z0-9_]{1,64}$/.test(error.code)?error.code:'unavailable'}));
  process.exitCode=1;
} finally { await pool.end(); process.exit(process.exitCode || 0); }
