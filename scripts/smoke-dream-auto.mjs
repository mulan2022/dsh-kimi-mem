// Exercise the actual plugin wiring with a controlled clock and fake model transport.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as mem from '../lib/index.js';
const home = mkdtempSync(join(tmpdir(), 'dsh-dream-auto-'));
const RealDate = Date, realInterval = setInterval, realClear = clearInterval;
let now = new RealDate(2026, 10, 2, 4).getTime();
const timers = [], effects = [], events = new Map(), tools = new Map(), calls = [], requests = [], owned = [];
let mergeHealthy = false;
let disposed = 0;
globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
globalThis.setInterval = fn => { const timer = { fn, unref() {}, stopped: false }; timers.push(timer); return timer; };
globalThis.clearInterval = timer => { timer.stopped = true; };
const put = (path, body) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, body); utimesSync(path, new Date(now), new Date(now)); };
const turns = join(home, '.dsh-mem/raw/turns');
put(join(turns, 'sample.jsonl'), JSON.stringify({ session: 'sample', turn: 1, at: new Date().toISOString(), space: 'chat', user: 'test', assistant: 'test', tools: [] }) + '\n');
put(join(turns, 'skipped.jsonl'), '{}\n');
mem.setDreamSkip(home, 'skipped', true);
const logs = [];
const logger = { info(message) { logs.push(message); }, warn(message) { logs.push(message); }, error(message) { logs.push(message); } };
const ctx = { logger, effect(fn) { effects.push(fn()); },
  on(event, fn) { const list = events.get(event) || []; list.push(fn); events.set(event,list); return () => list.splice(list.indexOf(fn),1); },
  systemPrompt: { section() { return () => {}; } }, tools: { register(t) { tools.set(t.name,t); return () => tools.delete(t.name); } },
  get(name) {
    if (name === 'subagents') return { async start(_provider, req) {
      const prompt = req.prompt.map(part => part.text ?? '').join('');
      const session = prompt.match(/会话 id：`([^`]+)`/)?.[1];
      calls.push(req.label); requests.push({ ...req, prompt });
      const text = req.label === 'dream:merge' ? { health: { ok: mergeHealthy } } : {
        space: req.label.includes(':chat:') ? 'chat' : 'project', session, project: req.label.includes(':project:') ? prompt.match(/项目名：`([^`]+)`/)?.[1] : null,
        observations: ['task-a','task-b'].includes(session) ? [{text:`pattern-${session}`,anchor:1,kind:'pattern',confidence:'high'}] : [], digest: 'test digest' };
      return { result: Promise.resolve({ output: [{type:'text',text:JSON.stringify(text)}] }), async dispose() {} };
    } };
    if (name === 'agents') return { roots: () => [], get: () => undefined, async create(options) {
      await options.setup({get: () => ({async mount(_scope, id) { assert.equal(id,'chat'); }})});
      owned.push(options); return { agent: { session: { header: { id: options.sessionId, origin: options.meta.origin } } }, async dispose() { disposed++; } };
    } };
    if (name === 'agentDefaultModel') return { currentSelection: () => ({provider:'test',model:'test'}) };
    if (name === 'webServer') return { register() { return () => {}; } };
  },
};
const drain = async () => { for(let i=0;i<30;i++) await new Promise(r => setImmediate(r)); };
try {
  await mem.apply(ctx, { home, dreamAt:'03:00', dreamIdleMinutes:15, rcc:false });
  assert.equal(timers.length,1,'plugin really installs its automatic timer');
  timers[0].fn(); await drain(); assert.equal(calls.length,0,'startup respects idle delay');
  now += 16*60_000;
  for(const listener of events.get('session/event')) listener({}, {type:'user/message',data:{source:{kind:'plugin'}}});
  timers[0].fn(); timers[0].fn(); await drain();
  assert.equal(calls.length,2,'one chat session = one extract + one merge; overlapping tick ignored: ' + logs.join(' | '));
  assert.equal(calls.some(c=>c.includes('skipped')),false);
  assert.equal(mem.readState(home).dream.lastRunAt,null,'unhealthy merge does not consume the schedule');
  assert.equal(mem.readState(home).dream.lease,null);
  assert.equal(mem.readCompact(home,'sample','chat'),null,'failed merge does not advance incremental progress');
  assert.equal(owned[0].meta.origin,'subagent','headless parent is not a new user root chat');
  assert.equal(owned[0].meta.parentSession,'sample');
  assert.equal(disposed,1,'headless parent cleaned up after failure');
  mergeHealthy = true;
  timers[0].fn(); await drain();
  assert.equal(calls.length,4,'failed run retries next check');
  assert.equal(mem.readState(home).dream.lastOutcome,'ok');
  assert.equal(mem.readState(home).dream.lastRunAt,new Date(now).toISOString());
  assert.equal(mem.readCompact(home,'sample','chat').coveredThroughTurn,1);
  assert.equal(disposed,2);
  timers[0].fn(); await drain(); assert.equal(calls.length,4,'successful run is not repeated');
  now += 24*3600_000;
  put(join(turns,'sample.jsonl'),JSON.stringify({session:'sample',turn:2,at:new Date().toISOString(),user:'new',assistant:'',tools:[],space:'chat'})+'\n');
  for(const listener of events.get('session/event')) listener({}, {type:'user/message',data:{source:{kind:'user'}}});
  timers[0].fn(); await drain(); assert.equal(calls.length,4,'real user activity postpones work');
  now += 16*60_000;
  mem.acquireLease(home,'kimi-import');
  timers[0].fn(); await drain(); assert.equal(calls.length,4,'import lease blocks automatic dream');
  mem.releaseLease(home);
  timers[0].fn(); await drain(); assert.equal(calls.length,6,'next day new material is processed');
  const beforeManual = now;
  await tools.get('mem_dream').execute({action:'run',sessionIds:['sample']},{agent:{session:{header:{id:'sample'}}}});
  assert.equal(mem.readState(home).dream.lastRunAt,new Date(beforeManual).toISOString(),'manual path also records success');
  now += 60_000;
  put(join(turns,'other.jsonl'),JSON.stringify({session:'other',turn:1,at:new Date().toISOString(),user:'other material',assistant:'',tools:[],space:'chat'})+'\n');
  await tools.get('mem_dream').execute({action:'run',sessionIds:['sample']},{agent:{session:{header:{id:'sample'}}}});
  assert.equal(mem.readState(home).dream.lastRunAt,new Date(beforeManual).toISOString(),'manual subset does not advance the global watermark');
  assert.equal(mem.listPendingSessions(home,mem.readState(home).dream.lastRunAt).includes('other'),true,'untouched sessions remain pending');
  // One chat session inside a repository plus two separate project sessions.
  const projectA = join(home,'work','Project-A'), projectB = join(home,'work','Project-B');
  put(join(projectA,'.git/HEAD'),'ref: main'); put(join(projectB,'.git/HEAD'),'ref: main');
  for(const [root,session] of [[projectA,'task-a'],[projectB,'task-b']]) {
    const entry = mem.ensureProjectPartition(home,root,['.git']);
    mem.appendAnchor(entry.dir,{session,turn:1,at:new Date().toISOString(),kind:'observe'});
  }
  const cases = [
    {session:'chat-in-a',cwd:projectA,space:'project',agentPreset:'chat'},
    {session:'task-a',cwd:projectA,space:'project',agentPreset:'standard'},
    {session:'task-b',cwd:projectB,space:'project',agentPreset:'standard'},
  ];
  for(const record of cases) put(join(turns,`${record.session}.jsonl`),JSON.stringify({...record,turn:1,at:new Date().toISOString(),user:'isolated material',assistant:'',tools:[]})+'\n');
  const requestStart = requests.length;
  const routed = await tools.get('mem_dream').execute({action:'run',sessionIds:cases.map(c=>c.session)},{agent:{session:{header:{id:'sample'}}}});
  assert.equal(routed.ok,true);
  assert.equal(routed.text.includes('3 份 / 2 条观察'),true,'same anchor number in different projects is validated against its own vault');
  const routedRequests = requests.slice(requestStart);
  assert.equal(routedRequests.filter(r=>r.label!=='dream:merge').length,3,'one extractor per session');
  assert.equal(routedRequests.filter(r=>r.label==='dream:merge').length,3,'chat and both projects merge independently');
  assert.equal(routedRequests.some(r=>r.label==='dream:chat:chat-in-'),true,'chat preset wins over repository cwd and legacy coarse space');
  assert.equal(routedRequests.some(r=>r.label==='dream:project:chat-in-'),false);
  const merges = routedRequests.filter(r=>r.label==='dream:merge');
  for(const record of cases) {
    const own = merges.filter(r=>r.prompt.includes(`"session": "${record.session}"`));
    assert.equal(own.length,1);
    for(const other of cases.filter(c=>c!==record)) assert.equal(own[0].prompt.includes(`"session": "${other.session}"`),false,'other spaces are absent from merge context');
  }
  assert.equal(mem.readCompact(home,'chat-in-a','project'),null);
  assert.equal(mem.readCompact(home,'task-a','chat'),null);
  assert.equal(mem.readCompact(home,'task-a','project').coveredThroughTurn,1);
  for(const dispose of effects) await dispose(); effects.length=0;
  assert.equal(timers[0].stopped,true,'plugin teardown removes timer');
  console.log('Automatic dream: headless wiring, idle, plugin messages, skip, locks, retry, incremental progress, cooldown, manual bookkeeping and cleanup passed.');
} finally {
  for(const dispose of effects) await dispose();
  globalThis.Date=RealDate; globalThis.setInterval=realInterval; globalThis.clearInterval=realClear;
  rmSync(home,{recursive:true,force:true});
}
