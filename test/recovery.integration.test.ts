import assert from "node:assert/strict";
import { test } from "node:test";
import { apis, assertProjected, delay, eventually, fail, lifecycle, rawContext, sdkPath, sentContext, succeed } from "./fixtures/lifecycle.js";

for (const api of apis) {
  test(`real Pi soft caps: ${api}: repeated empty-budget waits retain the workflow and steering`,{skip:!sdkPath,timeout:20000},async()=>{
    let fixture:Awaited<ReturnType<typeof lifecycle>>;
    fixture=await lifecycle(api,{handle:(res,index)=>{if(index<=2){fixture.state.available=0;fail(res,"provisioned_quota_exhausted",296.585);}else succeed(res,api);}});
    try {const run=fixture.start();for(const rejected of [1,2]) {
      await eventually(()=>fixture.requests.length===rejected && fixture.pauses.filter(p=>p.active).length===rejected,"empty soft-cap wait");
      await delay(150);assert.equal(fixture.settled.length,0);assert.equal(fixture.state.resolved,false);assert.equal(fixture.requests.length,rejected);
      await fixture.session.steer(`STEERING_${rejected}`);fixture.state.available=0.000001;
      await fixture.session.prompt("/quota set 100 workflow");
    }
    await run;assert.equal(fixture.requests.length,3);assert.equal(fixture.settled.length,1);
    assert.deepEqual(fixture.pauses.map(p=>p.active),[true,false,true,false]);assert.equal(fixture.widgets.at(-1),undefined);
    for(let i=0;i<3;i++) assertProjected(fixture.requests[i],i+1);
    assert.ok(sentContext(fixture.requests[1]).includes("STEERING_1"));assert.ok(sentContext(fixture.requests[2]).includes("STEERING_2"));
    assert.ok(JSON.stringify(fixture.session.sessionManager.getEntries()).includes(rawContext));assert.deepEqual(fixture.errors,[]);
    } finally {await fixture.close();}
  });
  test(`real Pi soft caps: ${api}: huge obsolete estimate cannot block tiny positive credit`,{skip:!sdkPath,timeout:15000},async()=>{
    const fixture=await lifecycle(api,{available:0.000001,handle:(res,index)=>index===1?fail(res,"provisioned_quota_exhausted",3000000):succeed(res,api)});
    try {await fixture.start();assert.equal(fixture.requests.length,2);assert.equal(fixture.settled.length,1);
      assert.equal(fixture.compactions.length,0);assertProjected(fixture.requests[1],2);assert.deepEqual(fixture.errors,[]);
      assert.ok(fixture.widgets.every(w=>!w?.join(" ").includes("reservation estimate")));
    } finally {await fixture.close();}
  });
  test(`real Pi soft caps: ${api}: near-floor active request gates retries without settling`,{skip:!sdkPath,timeout:15000},async()=>{
    const fixture=await lifecycle(api,{available:0.2,admissionReady:false,inFlight:1,handle:(res,index)=>index===1?fail(res,"provisioned_quota_exhausted"):succeed(res,api)});
    try {const run=fixture.start();await eventually(()=>fixture.pauses.at(-1)?.active===true,"in-flight gate");await delay(150);
      assert.equal(fixture.requests.length,1);assert.equal(fixture.settled.length,0);
      fixture.state.inFlight=0;fixture.state.admissionReady=true;fixture.waiter.wake();await run;
      assert.equal(fixture.requests.length,2);assert.equal(fixture.settled.length,1);assert.deepEqual(fixture.errors,[]);
    } finally {await fixture.close();}
  });
  test(`real Pi soft caps: ${api}: forced burn readiness resumes an empty indebted session`,{skip:!sdkPath,timeout:15000},async()=>{
    const fixture=await lifecycle(api,{available:0,debt:8,admissionReady:false,handle:(res,index)=>index===1?fail(res,"provisioned_quota_exhausted"):succeed(res,api)});
    try {const run=fixture.start();await eventually(()=>fixture.pauses.at(-1)?.active===true,"empty session waiting before burn");
      assert.equal(fixture.settled.length,0);fixture.state.admissionReady=true;fixture.waiter.wake();await run;
      assert.equal(fixture.state.available,0);assert.equal(fixture.requests.length,2);assert.equal(fixture.settled.length,1);
      assert.deepEqual(fixture.pauses.map(p=>p.active),[true,false]);assert.deepEqual(fixture.errors,[]);
    } finally {await fixture.close();}
  });
  test(`real Pi soft caps: ${api}: status outages remain cancelable without settling early`,{skip:!sdkPath,timeout:15000},async()=>{
    const fixture=await lifecycle(api,{statusFailure:()=>true,handle:res=>fail(res,"provisioned_quota_exhausted")});
    try {const run=fixture.start();await eventually(()=>fixture.state.statusChecks>0,"status unavailable");
      assert.equal(fixture.settled.length,0);await fixture.session.abort();await run;assert.equal(fixture.requests.length,1);
      assert.equal(fixture.settled.length,1);assert.equal(fixture.pauses.at(-1)?.active,false);assert.deepEqual(fixture.errors,[]);
    } finally {await fixture.close();}
  });

  test(`real Pi recovery: ${api}: canceled threshold compaction does not create a cap loop`, {skip:!sdkPath,timeout:15_000}, async () => {
    const fixture = await lifecycle(api,{smallWindow:true,compact:"cancel",handle:(res,index) =>
      index === 1 ? fail(res,"provisioned_quota_exhausted",0.5) : succeed(res,api)});
    try {
      const run = fixture.start();
      await eventually(()=>fixture.pauses.at(-1)?.active === true,"quota wait before compaction");
      await delay(150);
      assert.equal(fixture.settled.length,0);
      assert.equal(fixture.requests.length,1);
      fixture.state.available = 1;
      fixture.waiter.wake();
      await run;
      assert.ok(fixture.compactions.some(event=>event.reason==="threshold"),"must actually execute the installed SDK's threshold-compaction lifecycle");
      assert.ok(fixture.compactions.length<=2,"canceling compaction cannot repeatedly restart the workflow");
      assert.equal(fixture.requests.length,2);
      assert.equal(fixture.settled.length,1);
      assertProjected(fixture.requests[0],1);
      assertProjected(fixture.requests[1],2);
      assert.deepEqual(fixture.errors,[]);
    } finally {await fixture.close();}
  });

  for (const code of ["context_length_exceeded", "context_too_large"]) {
    test(`real Pi recovery: ${api}: ${code} retains native overflow recovery`, {skip:!sdkPath,timeout:15_000}, async () => {
      const fixture = await lifecycle(api,{smallWindow:true,compact:"provide",handle:(res,index) =>
        index === 1 ? fail(res,code,296.585,code === "context_too_large" ? 413 : 400,"Your input exceeds the context window of this model") : succeed(res,api)});
      try {
        await fixture.start();
        assert.equal(fixture.requests.length,2,"native overlong-context recovery must remain enabled");
        assert.equal(fixture.settled.length,1);
        assert.equal(fixture.state.statusChecks,0,"typed request/context errors are not provisioned waits");
        assert.deepEqual(fixture.pauses,[]);
        assert.ok(fixture.compactions.some(event=>event.reason==="overflow" && event.willRetry));
        assert.ok(sentContext(fixture.requests[1]).includes("COMPACTED_SAFE_CONTEXT"));
        assert.equal(fixture.session.messages.at(-1).stopReason,"stop");
        assert.deepEqual(fixture.errors,[]);
      } finally {await fixture.close();}
    });
  }

  test(`real Pi recovery: ${api}: quota metadata from a native compaction call is isolated`, {skip:!sdkPath,timeout:20_000}, async () => {
    const fixture = await lifecycle(api,{smallWindow:true,compact:"native",handle:(res,index) =>
      index === 1 ? fail(res,"context_length_exceeded",0,400) : fail(res,"provisioned_quota_exhausted",0.5)});
    try {
      await fixture.start();
      assert.equal(fixture.requests.length,2,"second HTTP call must be the actual SDK compaction model call");
      assert.ok(fixture.compactions.some(event=>event.reason==="overflow"));
      assert.equal(fixture.settled.length,1);
      assert.equal(fixture.state.statusChecks,0,"summary-call response headers cannot leak into assistant retry state");
      assert.deepEqual(fixture.pauses,[]);
      assert.ok(!fixture.events.filter(e=>e.type==="message_end").some(e=>e.message.errorMessage?.includes("waiting for reset")));
      assert.deepEqual(fixture.errors,[]);
    } finally {await fixture.close();}
  });

  test(`real Pi recovery: ${api}: typed admission-size error is terminal, not a refill wait or genuine overflow`, {skip:!sdkPath,timeout:15_000}, async () => {
    const fixture = await lifecycle(api,{smallWindow:true,compact:"cancel",handle:res=>fail(res,"context_too_large",296.585,413)});
    try {
      await fixture.start();
      assert.equal(fixture.requests.length,1);
      assert.equal(fixture.settled.length,1);
      assert.equal(fixture.state.statusChecks,0);
      assert.deepEqual(fixture.pauses,[]);
      assert.equal(fixture.compactions.length,0,"Pi 1.1.0 does not classify the proxy admission-size code as genuine context overflow");
      assert.match(fixture.session.messages.at(-1).errorMessage,/maximum provisioned admission size/);
      assert.equal(fixture.session.messages.at(-1).stopReason,"error");
      assert.deepEqual(fixture.errors,[]);
    } finally {await fixture.close();}
  });

  test(`real Pi recovery: ${api}: untyped upstream 429 is never a quota wait`, {skip:!sdkPath,timeout:20_000}, async () => {
    const fixture = await lifecycle(api,{handle:res=>fail(res,"usage_limit_reached",0)});
    try {
      await fixture.start();
      assert.equal(fixture.settled.length,1);
      assert.equal(fixture.state.statusChecks,0);
      assert.deepEqual(fixture.pauses,[]);
      assert.equal(fixture.session.messages.at(-1).stopReason,"error");
      assert.ok(!fixture.session.messages.at(-1).errorMessage.includes("waiting for reset"));
      assert.deepEqual(fixture.errors,[]);
    } finally {await fixture.close();}
  });
}
