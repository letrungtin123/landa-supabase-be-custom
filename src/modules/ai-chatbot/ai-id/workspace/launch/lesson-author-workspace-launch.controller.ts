import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AuthUser } from '../../../../../types/express.js';
import type { GenerationJobDatabase } from '../../shared/lesson-author-generation-job.repository.js';
import { createWorkspaceAuthority } from '../edit/lesson-author-workspace-authority.repository.js';
import {
  isLaunchBriefErrorCode, isNormalizedLaunchBrief, LAUNCH_BRIEF_BODY_KEYS, LAUNCH_BRIEF_ERROR_MESSAGES, LaunchBriefError,
  parseLaunchBrief, readStoredLaunchBrief, type LessonAuthorLaunchBrief,
} from '../../contracts/lesson-author-launch-brief.logic.js';
import { ORG_CONTEXT_LAUNCH_ERRORS, isOrgContextLaunchErrorCode } from '../../contracts/lesson-author-org-context.contract.js';
import { UUID_PATTERN, isUuid } from '../../../../../utils/uuid.js';
import { isAiIdActor } from '../../shared/lesson-author-ai-id-access.logic.js';
import { AI_CREDIT_INSUFFICIENT_FOR_RUN_CODE } from '../../../../ai-credits/ai-credit.logic.js';
import { AppError } from '../../../../../utils/errors.js';

const states=['queued','designing','drafting','ready','needs_action','failed','canceled'];
const BASE_CREATE_KEYS='content_locale,operation_id,source_document_ids';
/** Optional Create key: freeze the confirmed organization profile into the new run (absent = false). */
const ORG_CONTEXT_KEY='use_organization_context';
/**
 * `brief` (QLT-6): the validated launch brief of the Create request, stored write-once with the workspace.
 * `useOrganizationContext`: the author's "Dùng hồ sơ doanh nghiệp" switch (absent = false).
 */
export interface WorkspaceLaunchInput{courseId:string;conversationId:string;operationId:string;sourceDocumentIds:string[];locale:'en'|'vi';brief:LessonAuthorLaunchBrief;useOrganizationContext?:boolean;}
/** `launch_brief`: null for a workspace created before QLT-6 (storage `version` is never exposed). */
export interface WorkspaceLaunchResult{workspace_id:string;conversation_id:string;correlation_id:string;content_locale:'en'|'vi';status:string;launch_brief:LessonAuthorLaunchBrief|null;replayed?:boolean;}
function validResult(value:WorkspaceLaunchResult){return[ value.workspace_id,value.conversation_id,value.correlation_id ].every(id=>UUID_PATTERN.test(id))
  &&['en','vi'].includes(value.content_locale)&&states.includes(value.status)
  &&(value.launch_brief===null||isNormalizedLaunchBrief(value.launch_brief));}
function object(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v);}
export function createWorkspaceLaunchHandlers(deps:{
  readEnabled():boolean;executionReady():boolean;editEnabled?():boolean;db:GenerationJobDatabase;
  create(user:AuthUser,input:WorkspaceLaunchInput):Promise<WorkspaceLaunchResult>;
  report(event:Record<string,unknown>):void;
}){
  function handler(action:'latest'|'create'){
    return async(req:Request,res:Response):Promise<void>=>{
      const start=performance.now(),requestId=randomUUID(),locale=req.query.ui_locale==='en'?'en':'vi';
      res.setHeader('Cache-Control','no-store');res.setHeader('X-Request-ID',requestId);
      let root:string|null=null,workspaceId:string|null=null;
      const failure=(status:number,external:string,internal=external,message?:string)=>{
        try{deps.report({event:'workspace_launch_failed',action,request_id:requestId,correlation_id:root,workspace_id:workspaceId,
          failure_stage:`workspace_${action}`,internal_failure_code:internal,external_failure_code:external,http_status:status,duration_ms:Math.round(performance.now()-start)});}catch{/* telemetry never changes the response */}
        // QLT-6: a launch brief problem is the author's to fix, so it says exactly what to change.
        const brief=isLaunchBriefErrorCode(external)?LAUNCH_BRIEF_ERROR_MESSAGES[external]:null;
        res.status(status).json({success:false,code:external,request_id:requestId,message:message??(brief?brief[locale==='en'?1:0]:locale==='en'
          ? 'The workspace operation could not be confirmed. Refresh the state before trying again.'
          : 'Chưa thể xác nhận thao tác bản thảo. Hãy tải lại trạng thái trước khi thử lại.')});
      };
      const user=req.user,courseId=req.params.courseId;
      if(!user){failure(401,'AUTH_REQUIRED');return;}
      if(!isAiIdActor(user)){failure(403,'WORKSPACE_READ_FORBIDDEN');return;}
      if(typeof courseId!=='string'||!courseId.trim()||courseId.length>255||/[\x00-\x1f\x7f]/.test(courseId)
        ||Object.keys(req.query).some(k=>k!=='ui_locale')||(req.query.ui_locale!==undefined&&!['en','vi'].includes(req.query.ui_locale as string))){failure(400,'WORKSPACE_CREATE_INPUT_INVALID');return;}
      if(!deps.readEnabled()||(action==='create'&&!deps.executionReady())){failure(503,'WORKSPACE_EXECUTION_DISABLED');return;}
      try{
        let result:WorkspaceLaunchResult|null;
        if(action==='create'){
          const body:unknown=req.body,conversationId=req.params.conversationId;
          // Exactly the three base keys plus the QLT-6 brief keys and the optional organization context switch;
          // the brief keys are checked below with their own codes.
          if(!UUID_PATTERN.test(conversationId??'')||!object(body)
            ||Object.keys(body).filter(k=>!(LAUNCH_BRIEF_BODY_KEYS as readonly string[]).includes(k)&&k!==ORG_CONTEXT_KEY).sort().join(',')!==BASE_CREATE_KEYS
            ||(Object.hasOwn(body,ORG_CONTEXT_KEY)&&typeof body[ORG_CONTEXT_KEY]!=='boolean')
            ||!isUuid(body.operation_id)||typeof body.content_locale!=='string'||!['en','vi'].includes(body.content_locale)
            ||!Array.isArray(body.source_document_ids)||body.source_document_ids.length<1||body.source_document_ids.length>5
            ||body.source_document_ids.some(id=>!isUuid(id))||new Set(body.source_document_ids).size!==body.source_document_ids.length){failure(400,'WORKSPACE_CREATE_INPUT_INVALID');return;}
          let brief:LessonAuthorLaunchBrief;
          try{brief=parseLaunchBrief(body);}
          catch(error){if(error instanceof LaunchBriefError){failure(400,error.code);return;}throw error;}
          result=await deps.create(user,{courseId,conversationId,operationId:body.operation_id,locale:body.content_locale as 'en'|'vi',sourceDocumentIds:body.source_document_ids,brief,
            ...(body[ORG_CONTEXT_KEY]===true?{useOrganizationContext:true}:{})});
        }else{
          result=await deps.db.transaction(async tx=>{
            const a=createWorkspaceAuthority(user),owner={tenantId:user.tenantId!,userId:user.id,courseId,conversationId:''};
            if(!await a.canEdit(tx,owner))throw Object.assign(new Error('WORKSPACE_READ_FORBIDDEN'),{code:'WORKSPACE_READ_FORBIDDEN'});
            const found=await tx.query(`SELECT w.id AS workspace_id,w.conversation_id,w.correlation_id,w.content_locale,w.status,w.launch_brief
              FROM lesson_author_workspaces w JOIN courses course ON course.id=w.course_id AND course.tenant_id=w.tenant_id AND course.deleted_at IS NULL
              JOIN chat_conversations c ON c.id=w.conversation_id AND c.tenant_id=w.tenant_id AND c.course_id=w.course_id
                AND c.user_id=w.requested_by AND c.bot_id=w.bot_id AND c.target='lesson_author'
              JOIN tenant_bot_assignments b ON b.tenant_id=w.tenant_id AND b.bot_id=w.bot_id AND b.target='lesson_author'
              JOIN tenant_kb_assignments k ON k.tenant_id=w.tenant_id AND k.kb_id=w.kb_id AND k.target='lesson_author'
              WHERE w.tenant_id=$1 AND w.course_id=$2 AND w.requested_by=$3 AND w.contract_version=1 AND w.engine='self_built_rag'
                AND NOT EXISTS (SELECT 1 FROM lesson_author_session_deletion_jobs deletion
                  WHERE deletion.tenant_id=w.tenant_id AND deletion.requested_by=w.requested_by
                    AND deletion.course_id=w.course_id AND deletion.conversation_id=w.conversation_id
                    AND deletion.is_terminal=false AND deletion.status IN ('queued','running','failed'))
                AND cardinality(w.source_document_ids)=(SELECT count(*) FROM kb_documents d WHERE d.id=ANY(w.source_document_ids)
                  AND d.tenant_id=w.tenant_id AND d.kb_id=w.kb_id)
              ORDER BY w.created_at DESC,w.id DESC LIMIT 1`,[user.tenantId,courseId,user.id]);
            const row=found.rows[0] as Record<string,unknown>|undefined;
            // A stored brief of another shape throws (fails closed); NULL is a workspace from before QLT-6.
            return row?{...row,launch_brief:readStoredLaunchBrief(row.launch_brief)} as unknown as WorkspaceLaunchResult:null;
          });
        }
        if(result&&!validResult(result)){failure(503,'WORKSPACE_READ_UNAVAILABLE','WORKSPACE_LAUNCH_READBACK_INVALID');return;}
        root=result?.correlation_id??null;workspaceId=result?.workspace_id??null;
        const status=action==='create'&&!result?.replayed?202:200;
        try{deps.report({event:'workspace_launch_completed',action,request_id:requestId,correlation_id:root,workspace_id:workspaceId,
          http_status:status,duration_ms:Math.round(performance.now()-start)});}catch{/* telemetry never changes the response */}
        // This is a display capability only. Every Save/Reset still checks fresh
        // actor authority and all revision/source fences in its transaction.
        res.status(status).json({success:true,data:result?{...result,can_edit:deps.editEnabled?.()===true}:null});
      }catch(error){
        const c=error&&typeof error==='object'?(error as {code?:unknown}).code:undefined;
        const internal=typeof c==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(c)?c:'WORKSPACE_RUNTIME_UNAVAILABLE';
        if(isLaunchBriefErrorCode(internal)){failure(400,internal);return;}
        // Organization profile requested but not usable for this run, or not confirmed: the author's to fix.
        if(isOrgContextLaunchErrorCode(internal)){const[status,vi,en]=ORG_CONTEXT_LAUNCH_ERRORS[internal];
          failure(status,internal,internal,locale==='en'?en:vi);return;}
        // AI points: the run is refused before anything is created, so it goes out as raised (its 429, code and
        // plain message), not as a runtime failure that tells the author to reload and try again.
        if(internal===AI_CREDIT_INSUFFICIENT_FOR_RUN_CODE&&error instanceof AppError){failure(error.statusCode,internal,internal,error.message);return;}
        const denied=internal.includes('FORBIDDEN'),conflict=internal.includes('CONFLICT')||internal==='WORKSPACE_ALREADY_ACTIVE';
        failure(denied?403:conflict?409:503,denied?'WORKSPACE_READ_FORBIDDEN':conflict?internal:'WORKSPACE_RUNTIME_UNAVAILABLE',internal);
      }
    };
  }
  return{latest:handler('latest'),create:handler('create')};
}
