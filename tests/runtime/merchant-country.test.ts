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

test("additive multi-site binding admits a new site alongside legacy singleton correction and saved-account preservation", async () => {
  const principalNew = { accountId: "synthetic-owner-new", siteId: crypto.randomUUID() };
  const principalLegacy = { accountId: "synthetic-owner-legacy", siteId: crypto.randomUUID() };

  const stubNew = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", principalNew.siteId]));
  const stubLegacy = env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", principalLegacy.siteId]));

  const legacyAt = Date.now() - 2000;
  const legacyRecord = {
    bindingRef: "stripe_legacy_fixture",
    owner: principalLegacy,
    mode: "test",
    providerId: "stripe",
    startedAt: legacyAt - 1000,
    stripeAccountId: null,
    authorizeNetMerchantId: null,
    creationProtocol: "accounts_v2",
    creationScope: "acct_platform",
    creationFailure: { category: "unknown", status: 400, at: legacyAt },
  };

  const sharedEnv = {
    STRIPE_TEST_MERCHANT_COUNTRY_CONFIG: JSON.stringify({
      siteId: principalLegacy.siteId,
      country: "US",
      rejectedCreation: { bindingRef: legacyRecord.bindingRef, failureAt: legacyAt, code: "identity_country_required" },
    }),
    STRIPE_TEST_MERCHANT_COUNTRY_SITES: JSON.stringify([
      { siteId: principalNew.siteId, country: "FR" },
    ]),
  };

  await runInDurableObject(stubNew, instance => {
    Object.assign((instance as unknown as { env: Record<string, string> }).env, sharedEnv);
  });
  await runInDurableObject(stubLegacy, (instance, state) => {
    Object.assign((instance as unknown as { env: Record<string, string> }).env, sharedEnv);
    state.storage.sql.exec("INSERT INTO connection_state (id,value) VALUES (1,?)", JSON.stringify(legacyRecord));
  });

  const createdBodies: unknown[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/account") return Response.json({ object: "account", id: "acct_platform" });
    if (path === "/v2/core/accounts") {
      createdBodies.push(JSON.parse(String(init?.body)));
      return Response.json(stripeV2Account());
    }
    return Response.json(stripeV2Account());
  });

  // 1. Admit new site via STRIPE_TEST_MERCHANT_COUNTRY_SITES
  const newStatus = await stubNew.startOnboarding(principalNew);
  expect(newStatus.state).toBe("ready");
  await runInDurableObject(stubNew, (_instance, state) => {
    const saved = JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM connection_state WHERE id=1").one().value);
    expect(saved).toMatchObject({
      creationCountry: "FR",
      stripeAccountId: "acct_fixture",
    });
  });

  // 2. Legacy site executes its singleton country correction using legacy fallback
  const legacyStatus = await stubLegacy.startOnboarding(principalLegacy);
  expect(legacyStatus.state).toBe("ready");
  await runInDurableObject(stubLegacy, (_instance, state) => {
    const saved = JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM connection_state WHERE id=1").one().value);
    expect(saved).toMatchObject({
      bindingRef: legacyRecord.bindingRef,
      creationCountry: "US",
      creationCountryRepair: { code: "identity_country_required", failureAt: legacyAt },
      stripeAccountId: "acct_fixture",
    });
  });

  // 3. Saved account resumes and survives eviction without reading configuration
  await evictDurableObject(stubNew);
  await evictDurableObject(stubLegacy);

  expect((await env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", principalNew.siteId])).startOnboarding(principalNew)).state).toBe("ready");
  expect((await env.PAYMENT_CONNECTIONS.getByName(JSON.stringify(["test", principalLegacy.siteId])).startOnboarding(principalLegacy)).state).toBe("ready");

  // Verify created account bodies
  expect(createdBodies).toHaveLength(2);
  expect((createdBodies[0] as { identity: { country: string } }).identity.country).toBe("FR");
  expect((createdBodies[1] as { identity: { country: string } }).identity.country).toBe("US");
});
