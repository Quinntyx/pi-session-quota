import assert from "node:assert/strict";
import test from "node:test";
import { cacheHints, INPUT_TOKENS_HEADER, CACHED_TOKENS_HEADER } from "../src/cache-hints.js";
const success = {type:"message",id:"success",message:{role:"assistant",stopReason:"toolUse",provider:"cliproxyapi",model:"sol",usage:{input:210,cacheRead:87680,cacheWrite:0,output:1496}}};

test("observed cache estimates include previous output and new tool results", () => {
 const branch=[success,{type:"message",message:{role:"toolResult",content:[{type:"text",text:"new tool output"}]}}];
 const hints=cacheHints(branch,"cliproxyapi","sol");
 assert.equal(Number(hints[CACHED_TOKENS_HEADER]),78912);
 assert.ok(Number(hints[INPUT_TOKENS_HEADER])>210+87680+1496+1024);
});
test("changed models, compaction, and edited successful context discard cache hints",()=>{
 assert.deepEqual(cacheHints([success],"other","sol"),{});
 assert.deepEqual(cacheHints([success],"cliproxyapi","other"),{});
 for(const entry of [{type:"compaction"},{type:"model_change"},{type:"context_edit",targetId:"success"}])
  assert.deepEqual(cacheHints([success,entry],"cliproxyapi","sol"),{});
});
test("quota failure removal preserves the successful cache observation",()=>{
 const failure={type:"message",id:"error",message:{role:"assistant",stopReason:"error"}};
 assert.ok(cacheHints([success,failure,{type:"context_edit",targetId:"error"}],"cliproxyapi","sol")[INPUT_TOKENS_HEADER]);
 assert.deepEqual(cacheHints([],"cliproxyapi","sol"),{});
});
test("invalid usage cannot fabricate a cache estimate",()=>{
 assert.deepEqual(cacheHints([{...success,message:{...success.message,usage:{input:-1,cacheRead:10}}}],"cliproxyapi","sol"),{});
});
