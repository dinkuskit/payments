import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Principal } from "./connection.js";

export function createAccountAuthenticator(config: { issuer: string; audience: string; jwksUrl: string }, key?: JWTVerifyGetKey) {
  if (new URL(config.issuer).protocol !== "https:" || new URL(config.jwksUrl).protocol !== "https:" || !config.audience) throw new Error("invalid_identity_configuration");
  const resolveKey = key ?? createRemoteJWKSet(new URL(config.jwksUrl));
  return async (request: Request, scope: "payments:admin" | "payments:checkout"): Promise<Principal> => {
    const bearer = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (!bearer) throw new Error("unauthorized");
    const { payload } = await jwtVerify(bearer, resolveKey, {
      issuer: config.issuer, audience: config.audience, algorithms: ["RS256", "ES256"], requiredClaims: ["exp", "iat", "sub"], maxTokenAge: "1h",
    });
    if (typeof payload.sub !== "string" || !payload.sub.trim() || payload.sub.length > 200 || typeof payload.site_id !== "string" || !payload.site_id.trim() || payload.site_id.length > 200 || typeof payload.scope !== "string" || !payload.scope.split(" ").includes(scope) || request.headers.get("x-dinkus-site") !== payload.site_id) throw new Error("unauthorized");
    // Same canonical subject representation as the hosted Inventory boundary.
    return { accountId: JSON.stringify([config.issuer, payload.sub]), siteId: payload.site_id };
  };
}
