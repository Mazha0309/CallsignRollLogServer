import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { beforeEach, afterEach, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import { openDatabase } from '../src/db/database';
import { listSharedSessions, listSharedSessionLogs } from '../src/account-share/catalog';
import { acceptShareRequest, createShareRequest, revokeShareGrant, updateShareGrant } from '../src/account-share/service';
import { mutateSharedRecord } from '../src/account-share/records';
import { validatePersonalSnapshot } from '../src/personal-snapshot/model';
import { AppError } from '../src/errors/app-error';
import { runMigrations } from '../src/db/migrations';

let db: ReturnType<typeof openDatabase>;
const now = new Date().toISOString();
function session(id: string, owner = 'owner') {
  db.prepare(`INSERT INTO sessions (id,title,status,owner_user_id,created_at,updated_at) VALUES (?,?,'active',?,?,?)`).run(id,id,owner,now,now);
  db.prepare(`INSERT INTO session_members (id,session_id,user_id,role,created_at,updated_at) VALUES (?,?,?,'owner',?,?)`).run(randomUUID(),id,owner,now,now);
}
function personal(owner = 'owner') {
  const valid = validatePersonalSnapshot({ version: 1, exportedAt: now,
    sessions: ['p1','p2'].map(id => ({session_id:id,title:`${owner}-${id}`,status:'active',created_at:now,updated_at:now,closed_at:null,deleted_at:null})),logs:[] });
  db.prepare(`INSERT INTO personal_cloud_snapshots (user_id,revision,format_version,snapshot_json,session_count,log_count,byte_size,checksum,created_at,updated_at)
    VALUES (?,1,1,?,?,?,?,?,?,?)`).run(owner,valid.serialized,valid.sessionCount,valid.logCount,valid.byteSize,valid.checksum,now,now);
}
function grant(options: Partial<Parameters<typeof createShareRequest>[1]> = {}) {
  const g = createShareRequest(db, {grantorUserId:'owner',granteeUsername:'reader',includePersonal:true,includeOwned:true,includeEditor:false,canJoinAs:'none',requestId:randomUUID(),mutationId:randomUUID(),...options});
  acceptShareRequest(db,{grantId:g.id,actorUserId:'reader',requestId:randomUUID(),mutationId:randomUUID()});
  return g;
}
function write(grantId:string, source:'personal'|'collaboration', sessionId:string, body:Record<string,unknown>, actorUserId='reader', mutationId=randomUUID()) {
  return mutateSharedRecord(db,{actorUserId,source,sessionId,body:{grantId,...body},requestId:randomUUID(),mutationId});
}
const value = {time:now,controller:'BG5CRL',callsign:'BG5AAA'};
function fails(code: string) { return (e:unknown) => e instanceof AppError && e.code === code; }
beforeEach(() => {
  db = openDatabase(':memory:');
  for (const id of ['owner','reader','other']) db.prepare(`INSERT INTO users (id,username,password_hash,role,created_at,updated_at) VALUES (?,?,'unused','user',?,?)`).run(id,id,now,now);
  session('c1'); session('c2'); session('foreign','other'); personal();
});
afterEach(() => db.close());

test('selected sharing excludes unselected and future sessions; all is ongoing', () => {
  const g = grant({scopeMode:'selected',selectedSessions:[{source:'personal',sessionId:'p1'},{source:'collaboration',sessionId:'c1'}]});
  session('future');
  assert.deepEqual(listSharedSessions(db,'reader').items.map(i=>i.sessionId).sort(),['c1','p1']);
  updateShareGrant(db,{grantId:g.id,actorUserId:'owner',scopeMode:'all',requestId:'update',mutationId:'update'});
  assert.deepEqual(listSharedSessions(db,'reader').items.map(i=>i.sessionId).sort(),['c1','c2','future','p1','p2']);
  session('future-2');
  assert.ok(listSharedSessions(db,'reader').items.some(i=>i.sessionId==='future-2'));
  assert.equal(db.prepare("SELECT COUNT(*) FROM session_members WHERE user_id='reader'").pluck().get(),0);
});
test('only owned sessions can be selected and delete requires explicit edit permission', () => {
  assert.throws(()=>grant({scopeMode:'selected',selectedSessions:[{source:'collaboration',sessionId:'foreign'}]}),fails('SHARE_SESSION_UNAVAILABLE'));
  assert.throws(()=>grant({canDeleteLogs:true}),fails('VALIDATION_FAILED'));
  assert.throws(()=>grant({includeEditor:true,canEditLogs:true}),fails('VALIDATION_FAILED'));
  assert.throws(()=>grant({scopeMode:'selected',selectedSessions:[]}),fails('VALIDATION_FAILED'));
});
test('legacy grants remain read-only and edit grants cannot delete, re-share or change session state', () => {
  const g = grant();
  assert.equal(g.canEditLogs,false);
  assert.throws(()=>write(g.id,'collaboration','c1',{operation:'create',syncId:'r1',baseVersion:0,value}),fails('SHARE_PERMISSION_DENIED'));
  updateShareGrant(db,{grantId:g.id,actorUserId:'owner',canEditLogs:true,requestId:'u',mutationId:'u'});
  write(g.id,'collaboration','c1',{operation:'create',syncId:'r1',baseVersion:0,value});
  write(g.id,'collaboration','c1',{operation:'update',syncId:'r1',baseVersion:1,patch:{qth:'杭州'}});
  assert.throws(()=>write(g.id,'collaboration','c1',{operation:'delete',syncId:'r1',baseVersion:2}),fails('SHARE_PERMISSION_DENIED'));
  assert.throws(()=>write(g.id,'collaboration','c1',{operation:'close',syncId:'r1',baseVersion:2}),fails('VALIDATION_FAILED'));
  assert.throws(()=>updateShareGrant(db,{grantId:g.id,actorUserId:'reader',canDeleteLogs:true,requestId:'no',mutationId:'no'}),fails('FORBIDDEN'));
  assert.throws(()=>createShareRequest(db,{grantorUserId:'reader',granteeUsername:'other',includePersonal:true,includeOwned:true,includeEditor:false,canJoinAs:'none',scopeMode:'selected',selectedSessions:[{source:'collaboration',sessionId:'c1'}],requestId:'no',mutationId:'no'}),fails('SHARE_SESSION_UNAVAILABLE'));
  const row = db.prepare("SELECT created_by,updated_by,qth,version FROM logs WHERE sync_id='r1'").get();
  assert.deepEqual(row,{created_by:'reader',updated_by:'reader',qth:'杭州',version:2});
  assert.equal(db.prepare("SELECT COUNT(*) FROM session_members WHERE user_id='reader'").pluck().get(),0);
  updateShareGrant(db,{grantId:g.id,actorUserId:'owner',canDeleteLogs:true,requestId:'d',mutationId:'d'});
  write(g.id,'collaboration','c1',{operation:'delete',syncId:'r1',baseVersion:2});
  assert.ok(db.prepare("SELECT deleted_at FROM logs WHERE sync_id='r1'").pluck().get());
});
test('personal writes preserve valid snapshots, use revisions, scope and idempotency', () => {
  const g = grant({canEditLogs:true,canDeleteLogs:true,scopeMode:'selected',selectedSessions:[{source:'personal',sessionId:'p1'}]});
  const body={operation:'create',syncId:'r1',expectedRevision:1,value};
  const key=randomUUID();
  const first=write(g.id,'personal','p1',body,'reader',key);
  assert.deepEqual(write(g.id,'personal','p1',body,'reader',key),first);
  assert.equal(listSharedSessionLogs(db,'reader','personal','p1',{grantId:g.id}).total,1);
  assert.throws(()=>write(g.id,'personal','p1',{operation:'update',syncId:'r1',expectedRevision:1,patch:{qth:'old'}}),fails('VERSION_CONFLICT'));
  write(g.id,'personal','p1',{operation:'update',syncId:'r1',expectedRevision:2,patch:{qth:'new'}});
  assert.throws(()=>write(g.id,'personal','p2',{operation:'delete',syncId:'r1',expectedRevision:3}),fails('NOT_FOUND'));
  write(g.id,'personal','p1',{operation:'delete',syncId:'r1',expectedRevision:3});
  assert.equal(listSharedSessionLogs(db,'reader','personal','p1',{grantId:g.id}).total,0);
  assert.throws(()=>listSharedSessionLogs(db,'reader','personal','p1',{grantId:g.id,includeDeleted:'true'}),fails('FORBIDDEN'));
  const row=db.prepare("SELECT revision,log_count FROM personal_cloud_snapshots WHERE user_id='owner'").get();
  assert.deepEqual(row,{revision:4,log_count:1});
  assert.equal(db.prepare("SELECT COUNT(*) FROM account_share_audit_events WHERE actor_user_id='reader' AND action LIKE 'account_share.log_%'").pluck().get(),3);
});
test('revocation, wrong actor, closed sessions and stale versions fail closed', () => {
  const g=grant({canEditLogs:true}); const body={operation:'create',syncId:'r1',baseVersion:0,value}; const key=randomUUID();
  assert.throws(()=>write(g.id,'collaboration','c1',body,'other'),fails('NOT_FOUND'));
  write(g.id,'collaboration','c1',body,'reader',key);
  assert.throws(()=>write(g.id,'collaboration','c1',{operation:'update',syncId:'r1',baseVersion:0,patch:{qth:'stale'}}),fails('VERSION_CONFLICT'));
  db.prepare("UPDATE sessions SET status='closed' WHERE id='c2'").run();
  assert.throws(()=>write(g.id,'collaboration','c2',body),fails('SHARE_PERMISSION_DENIED'));
  revokeShareGrant(db,{grantId:g.id,actorUserId:'owner',requestId:'revoke',mutationId:'revoke'});
  assert.throws(()=>write(g.id,'collaboration','c1',body,'reader',key),fails('NOT_FOUND'));
});
test('same personal IDs in different accounts require an exact grant selector', () => {
  personal('other'); const a=grant(); const b=grant({grantorUserId:'other'});
  assert.throws(()=>listSharedSessionLogs(db,'reader','personal','p1',{}),fails('SHARE_GRANT_REQUIRED'));
  assert.equal(listSharedSessionLogs(db,'reader','personal','p1',{grantId:a.id}).session.grantorUsername,'owner');
  assert.equal(listSharedSessionLogs(db,'reader','personal','p1',{grantId:b.id}).session.grantorUsername,'other');
});
test('migration preserves legacy sharing without granting write access', () => {
  const g=grant();
  db.exec(`ALTER TABLE account_share_grants DROP COLUMN scope_mode;
    ALTER TABLE account_share_grants DROP COLUMN selected_sessions_json;
    ALTER TABLE account_share_grants DROP COLUMN can_edit_logs;
    ALTER TABLE account_share_grants DROP COLUMN can_delete_logs;
    DELETE FROM schema_migrations WHERE version >= 32;`);
  runMigrations(db); runMigrations(db);
  assert.deepEqual(db.prepare('SELECT status,scope_mode,selected_sessions_json,can_edit_logs,can_delete_logs FROM account_share_grants WHERE id=?').get(g.id),
    {status:'accepted',scope_mode:'all',selected_sessions_json:'[]',can_edit_logs:0,can_delete_logs:0});
  assert.equal(listSharedSessions(db,'reader').items.length,4);
});
test('expired grants reject reads and writes; failed audits roll back data and receipts', () => {
  const g=grant({canEditLogs:true});
  db.exec(`CREATE TRIGGER fail_shared_audit BEFORE INSERT ON account_share_audit_events WHEN NEW.action='account_share.log_created' BEGIN SELECT RAISE(ABORT,'audit failed'); END;`);
  assert.throws(()=>write(g.id,'personal','p1',{operation:'create',syncId:'r1',expectedRevision:1,value}));
  assert.equal(listSharedSessionLogs(db,'reader','personal','p1',{grantId:g.id}).total,0);
  assert.equal(db.prepare("SELECT revision FROM personal_cloud_snapshots WHERE user_id='owner'").pluck().get(),1);
  assert.equal(db.prepare('SELECT COUNT(*) FROM processed_mutations').pluck().get(),0);
  db.prepare('UPDATE account_share_grants SET expires_at=? WHERE id=?').run('2020-01-01T00:00:00Z',g.id);
  assert.throws(()=>write(g.id,'personal','p1',{operation:'create',syncId:'r1',expectedRevision:1,value}),fails('NOT_FOUND'));
  assert.equal(listSharedSessions(db,'reader').items.length,0);
});
test('modernizing a legacy share removes its broad editor membership but preserves independent invitations', () => {
  const g=grant({canJoinAs:'editor'});
  db.prepare(`INSERT INTO session_members (id,session_id,user_id,role,created_at,updated_at,join_source,account_share_grant_id)
    VALUES ('legacy','c1','reader','editor',?,?,'account_share',?)`).run(now,now,g.id);
  db.prepare(`INSERT INTO session_members (id,session_id,user_id,role,created_at,updated_at,join_source)
    VALUES ('independent','c2','reader','editor',?,?,'invite')`).run(now,now);
  updateShareGrant(db,{grantId:g.id,actorUserId:'owner',canJoinAs:'none',canEditLogs:true,canDeleteLogs:false,requestId:'modernize',mutationId:'modernize'});
  assert.ok(db.prepare("SELECT removed_at FROM session_members WHERE id='legacy'").pluck().get());
  assert.equal(db.prepare("SELECT removed_at FROM session_members WHERE id='independent'").pluck().get(),null);
  const shared=listSharedSessions(db,'reader').items.find(s=>s.sessionId==='c1');
  assert.equal(shared?.canEditLogs,true);assert.equal(shared?.canDeleteLogs,false);
});
test('an independent viewer membership does not mask an explicit editable share', () => {
  const g=grant({canEditLogs:true});
  db.prepare(`INSERT INTO session_members (id,session_id,user_id,role,created_at,updated_at,join_source)
    VALUES ('viewer','c1','reader','viewer',?,?,'invite')`).run(now,now);
  assert.equal(listSharedSessions(db,'reader').items.find(s=>s.sessionId==='c1')?.canEditLogs,true);
  write(g.id,'collaboration','c1',{operation:'create',syncId:'shared-editor',baseVersion:0,value});
  assert.equal(db.prepare("SELECT role FROM session_members WHERE id='viewer'").pluck().get(),'viewer');
  assert.throws(()=>write(g.id,'collaboration','c1',{operation:'delete',syncId:'shared-editor',baseVersion:1}),fails('SHARE_PERMISSION_DENIED'));
});
test('HTTP validates batch payloads and mutation permissions', async () => {
  const secret='batch-sharing-tests-secret-long-enough';
  const server:Server=createServer(createApp({db,config:{jwtSecret:secret,jwtIssuer:'batch',environment:'test',rateLimitEnabled:false}}));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/account`;
  const headers=(id:string)=>({authorization:`Bearer ${jwt.sign({type:'access',role:'user',jti:randomUUID(),av:1},secret,{issuer:'batch',audience:'openlogtool-v1',subject:id,expiresIn:300})}`,'content-type':'application/json','idempotency-key':randomUUID()});
  try {
    const create=await fetch(`${url}/session-shares`,{method:'POST',headers:headers('owner'),body:JSON.stringify({granteeUsername:'reader',scopeMode:'selected',selectedSessions:[{source:'collaboration',sessionId:'c1'}],canEditLogs:true})});
    assert.equal(create.status,201); const {share}=await create.json() as {share:{id:string}};
    const accept=await fetch(`${url}/session-shares/${share.id}/accept`,{method:'POST',headers:headers('reader'),body:'{}'}); assert.equal(accept.status,200);
    const write=await fetch(`${url}/shared-sessions/collaboration/c1/logs/mutations`,{method:'POST',headers:headers('reader'),body:JSON.stringify({grantId:share.id,operation:'create',syncId:'http-r1',baseVersion:0,value})}); assert.equal(write.status,200);
    const denied=await fetch(`${url}/shared-sessions/collaboration/c1/logs/mutations`,{method:'POST',headers:headers('reader'),body:JSON.stringify({grantId:share.id,operation:'delete',syncId:'http-r1',baseVersion:1})}); assert.equal(denied.status,403);
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
