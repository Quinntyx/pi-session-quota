import assert from "node:assert/strict";
import { test } from "node:test";
import { apis, assertProjected, delay, eventually, fail, lifecycle, rawContext, sdkPath, sentContext, succeed } from "./fixtures/lifecycle.js";

for (const api of apis) {
  test(`real Pi recovery: ${api}: repeated ordinary deficits with held credit survive refill`, {skip:!sdkPath,timeout:20_000}, async () => {
    let fixture: Awaited<ReturnType<typeof lifecycle>>;
    fixture = await lifecycle(api,{available:10.33,held:14.29,handle:(res,index) => {
      if(index <= 2) {
        fixture.state.available = 10.33;
        fail(res,"provisioned_quota_exhausted",40);
      } else succeed(res,api);
    }});
    try {
      const run = fixture.start();
      for (const rejected of [1,2]) {
        await eventually(()=>fixture.requests.length===rejected && fixture.pauses.filter(p=>p.active).length===rejected,"ordinary quota wait");
        await delay(150);
        assert.equal(fixture.settled.length,0,"a refillable deficit cannot settle the run");
        assert.equal(fixture.state.resolved,false,"the caller must remain pending through repeated waits");
        assert.equal(fixture.session.isStreaming,true);
        assert.equal(fixture.requests.length,rejected,"10.33 available + 14.29 held / 100 cap / 40 needed is a wait, not an impossible reservation or tight loop");
        assert.ok(fixture.widgets.some(lines=>lines?.[0]?.match(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Reached provisioned quota cap/)),"the actual SDK UI binding retains an animated quota spinner");
        await fixture.session.steer(`STEERING_${rejected}`);
        fixture.state.available = 50;
        await fixture.session.prompt("/quota set 100 workflow"); // Commands dispatch during an active wait.
        assert.equal(fixture.state.commands,rejected);
      }
      await run;
      assert.equal(fixture.requests.length,3);
      assert.equal(fixture.settled.length,1);
      assert.equal(fixture.pauses.at(-1)?.active,false,"settlement must release the pause clock");
      assert.deepEqual(fixture.pauses.map(p=>p.active),[true,false,true,false]);
      assert.deepEqual(fixture.errors,[]);
      assert.equal(fixture.widgets.at(-1),undefined);
      assert.equal(fixture.workingMessages.at(-1),undefined);
      assert.equal(fixture.session.extensionRunner.getCommand("skim"),undefined,"standalone /skim must remain removed");
      assertProjected(fixture.requests[0],1);
      assertProjected(fixture.requests[1],2);
      assertProjected(fixture.requests[2],3);
      assert.ok(sentContext(fixture.requests[1]).includes("STEERING_1"));
      assert.ok(sentContext(fixture.requests[2]).includes("STEERING_2"));
      assert.ok(JSON.stringify(fixture.session.sessionManager.getEntries()).includes(rawContext),"projection must not rewrite durable user history");
    } finally {await fixture.close();}
  });

  for (const available of [0,26.975]) {
    test(`real Pi recovery: ${api}: impossible 296-point reservation with ${available} available is bounded`, {skip:!sdkPath,timeout:15_000}, async () => {
      const fixture = await lifecycle(api,{available,handle:res=>fail(res,"provisioned_quota_exhausted",296.585)});
      try {
        await fixture.start();
        assert.equal(fixture.requests.length,2,"one live-context rebuild, never endless refill or retries");
        assert.equal(fixture.settled.length,1);
        assert.match(fixture.session.messages.at(-1).errorMessage,/cannot fit the rebuilt request/);
        assert.equal(fixture.state.statusChecks,2,"classification must refresh provisioned capacity on the rebuilt rejection");
        assert.equal(fixture.pauses.at(-1)?.active,false);
        assertProjected(fixture.requests[0],1);
        assertProjected(fixture.requests[1],2);
        assert.deepEqual(fixture.errors,[]);
      } finally {await fixture.close();}
    });
  }

  test(`real Pi recovery: ${api}: transformed rebuild becomes refillable`, {skip:!sdkPath,timeout:15_000}, async () => {
    const fixture = await lifecycle(api,{available:10.33,held:14.29,handle:(res,index) => {
      if(index <= 2) fail(res,"provisioned_quota_exhausted",index === 1 ? 296.585 : 40);
      else succeed(res,api);
    }});
    try {
      const run = fixture.start();
      await eventually(()=>fixture.requests.length===2 && fixture.pauses.at(-1)?.active === true,"rebuilt request now fits capacity");
      await delay(150);
      assert.equal(fixture.settled.length,0,"a changed sent-view estimate must not inherit a blanket terminal retry guard");
      assert.equal(fixture.state.resolved,false);
      assert.equal(fixture.requests.length,2);
      fixture.state.available = 50;
      fixture.waiter.wake();
      await run;
      assert.equal(fixture.requests.length,3);
      assert.equal(fixture.settled.length,1);
      assert.equal(fixture.session.messages.at(-1).stopReason,"stop");
      assertProjected(fixture.requests[1],2);
      assertProjected(fixture.requests[2],3);
      assert.deepEqual(fixture.errors,[]);
    } finally {await fixture.close();}
  });

  test(`real Pi recovery: ${api}: raised provisioned capacity makes a rebuilt estimate refillable`, {skip:!sdkPath,timeout:15_000}, async () => {
    let fixture: Awaited<ReturnType<typeof lifecycle>>;
    fixture = await lifecycle(api,{available:10.33,held:14.29,handle:(res,index) => {
      if (index === 2) fixture.state.cap = 300;
      if (index <= 2) fail(res,"provisioned_quota_exhausted",296.585);
      else succeed(res,api);
    }});
    try {
      const run = fixture.start();
      await eventually(()=>fixture.requests.length===2 && fixture.pauses.at(-1)?.active === true,"rebuilt estimate now fits the raised cap");
      await delay(150);
      assert.equal(fixture.settled.length,0,"capacity changes must supersede the old impossible classification");
      assert.equal(fixture.state.resolved,false);
      assert.equal(fixture.requests.length,2);
      fixture.state.available = 300;
      fixture.waiter.wake();
      await run;
      assert.equal(fixture.requests.length,3);
      assert.equal(fixture.settled.length,1);
      assert.equal(fixture.pauses.at(-1)?.active,false);
      assert.equal(fixture.session.messages.at(-1).stopReason,"stop");
      assertProjected(fixture.requests[2],3);
      assert.deepEqual(fixture.errors,[]);
    } finally {await fixture.close();}
  });

  test(`real Pi recovery: ${api}: rebuilt-cap classification survives a status outage with scoped cancellation`, {skip:!sdkPath,timeout:15_000}, async () => {
    let fixture: Awaited<ReturnType<typeof lifecycle>>;
    fixture = await lifecycle(api,{available:26.975,
      statusFailure:()=>fixture.requests.length===2,
      handle:res=>fail(res,"provisioned_quota_exhausted",296.585)});
    try {
      const run = fixture.start();
      await eventually(()=>fixture.requests.length===2 && fixture.state.statusChecks>=2,"status outage on rebuilt request");
      await delay(150);
      assert.equal(fixture.settled.length,0,"an unavailable status is not evidence of impossible capacity");
      assert.equal(fixture.state.resolved,false);
      assert.equal(fixture.pauses.at(-1)?.active,true,"all classification waiting belongs to the live pause clock");
      assert.equal(fixture.requests.length,2);
      await fixture.session.abort();
      await run;
      assert.equal(fixture.settled.length,1);
      assert.equal(fixture.settled[0].aborted,true);
      assert.equal(fixture.pauses.at(-1)?.active,false,"Escape must release the classification pause too");
      assert.equal(fixture.widgets.at(-1),undefined);
      assert.equal(fixture.workingMessages.at(-1),undefined);
      assert.deepEqual(fixture.errors,[]);
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
