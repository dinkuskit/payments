import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { stripeV2Account } from "../helpers/stripe-v2.js";
afterEach(()=>vi.restoreAllMocks());
test("known missing-country rejection retries the same v2 key with explicit country and survives eviction",async()=>{
 const principal={accountId:"synthetic-owner",siteId:crypto.randomUUID()};
 const stub=env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test",principal.siteId]));
 const at=Date.now()-1000;
 const record={bindingRef:"stripe_country_fixture",owner:principal,mode:"test",providerId:"stripe",startedAt:at-1000,stripeAccountId:null,authorizeNetMerchantId:null,creationProtocol:"accounts_v2",creationScope:"acct_platform",creationFailure:{category:"unknown",status:400,at}};
 await runInDurableObject(stub,(instance,state)=>{
  (instance as unknown as {env:{STRIPE_TEST_MERCHANT_COUNTRY_CONFIG?:string}}).env.STRIPE_TEST_MERCHANT_COUNTRY_CONFIG=JSON.stringify({siteId:principal.siteId,country:"US",rejectedCreation:{bindingRef:record.bindingRef,failureAt:at,code:"identity_country_required"}});
  state.storage.sql.exec("INSERT INTO connection_state (id,value) VALUES (1,?)",JSON.stringify(record));
 });
 let creates=0;
 vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
  const path=new URL(String(input)).pathname;
  if(path==="/v1/account")return Response.json({object:"account",id:"acct_platform"});
  if(path==="/v2/core/accounts"){
   creates++;expect(JSON.parse(String(init?.body)).identity).toEqual({country:"US"});expect(new Headers(init?.headers).get("idempotency-key")).toBe("dinkus-connect:v2:stripe_country_fixture");
  }
  return Response.json(stripeV2Account());
 });
 expect((await stub.startOnboarding(principal)).state).toBe("ready");
 await runInDurableObject(stub,(_instance,state)=>{
  const saved=JSON.parse(state.storage.sql.exec<{value:string}>("SELECT value FROM connection_state WHERE id=1").one().value);
  expect(saved).toMatchObject({bindingRef:record.bindingRef,startedAt:record.startedAt,creationScope:"acct_platform",creationCountry:"US",creationCountryRepair:{code:"identity_country_required",failureAt:at},stripeAccountId:"acct_fixture"});
 });
 await evictDurableObject(stub);
 expect((await env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test",principal.siteId])).startOnboarding(principal)).state).toBe("ready");expect(creates).toBe(1);
});
