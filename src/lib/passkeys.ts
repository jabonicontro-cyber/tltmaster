// Face or fingerprint sign-in (passkeys, master plan DS1) — browser-side conversions. Taviron's session cookie is
// httpOnly and there is no browser database client, so the server talks to Supabase Auth (options, verification,
// session) and the browser only runs the WebAuthn ceremony. These helpers turn the server's JSON options into what
// navigator.credentials expects and the browser's credential back into JSON (the WebAuthn Level 3 JSON format, the
// same one @supabase/auth-js sends). Pure: tested in tests/unit/passkeys.test.ts.

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(buf: ArrayBuffer | ArrayBufferView): string {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type JsonDescriptor = { id: string; type?: string; transports?: string[] };

export interface CreationOptionsJson {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: string; alg: number }>;
  excludeCredentials?: JsonDescriptor[];
  [key: string]: unknown;
}

export interface RequestOptionsJson {
  challenge: string;
  allowCredentials?: JsonDescriptor[];
  [key: string]: unknown;
}

const descriptor = (d: JsonDescriptor): PublicKeyCredentialDescriptor => ({
  id: base64UrlToBytes(d.id),
  type: "public-key",
  ...(d.transports ? { transports: d.transports as AuthenticatorTransport[] } : {}),
});

/** Server JSON → options for navigator.credentials.create (some servers wrap them in { publicKey }). */
export function creationOptionsFromJson(raw: CreationOptionsJson | { publicKey: CreationOptionsJson }): PublicKeyCredentialCreationOptions {
  const json: CreationOptionsJson = (raw as { publicKey?: CreationOptionsJson }).publicKey ?? (raw as CreationOptionsJson);
  const { challenge, user, excludeCredentials, ...rest } = json;
  return {
    ...(rest as unknown as PublicKeyCredentialCreationOptions),
    challenge: base64UrlToBytes(challenge),
    user: { ...user, id: base64UrlToBytes(user.id) },
    ...(excludeCredentials?.length ? { excludeCredentials: excludeCredentials.map(descriptor) } : {}),
  };
}

/** Server JSON → options for navigator.credentials.get. */
export function requestOptionsFromJson(raw: RequestOptionsJson | { publicKey: RequestOptionsJson }): PublicKeyCredentialRequestOptions {
  const json: RequestOptionsJson = (raw as { publicKey?: RequestOptionsJson }).publicKey ?? (raw as RequestOptionsJson);
  const { challenge, allowCredentials, ...rest } = json;
  return {
    ...(rest as unknown as PublicKeyCredentialRequestOptions),
    challenge: base64UrlToBytes(challenge),
    ...(allowCredentials?.length ? { allowCredentials: allowCredentials.map(descriptor) } : {}),
  };
}

interface CredentialLike {
  id: string;
  rawId: ArrayBuffer;
  type: string;
  authenticatorAttachment?: string | null;
  getClientExtensionResults(): AuthenticationExtensionsClientOutputs;
  response: {
    clientDataJSON: ArrayBuffer;
    attestationObject?: ArrayBuffer;
    authenticatorData?: ArrayBuffer;
    signature?: ArrayBuffer;
    userHandle?: ArrayBuffer | null;
    getTransports?: () => string[];
  };
}

/** A credential from navigator.credentials.create/get → JSON for the server. */
export function credentialToJson(credential: CredentialLike): Record<string, unknown> {
  const r = credential.response;
  const response: Record<string, unknown> = { clientDataJSON: bytesToBase64Url(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = bytesToBase64Url(r.attestationObject);
    const transports = typeof r.getTransports === "function" ? r.getTransports() : undefined;
    if (transports?.length) response.transports = transports;
  }
  if (r.authenticatorData) response.authenticatorData = bytesToBase64Url(r.authenticatorData);
  if (r.signature) response.signature = bytesToBase64Url(r.signature);
  if (r.userHandle) response.userHandle = bytesToBase64Url(r.userHandle);
  return {
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    type: "public-key",
    response,
    clientExtensionResults: credential.getClientExtensionResults(),
    ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
  };
}

/** What the person sees when the ceremony did not finish (the browser's error names, never technical text). */
export function passkeyErrorMessage(name: string | undefined): string {
  switch (name) {
    case "NotAllowedError":
    case "AbortError":
      return "Face or fingerprint was cancelled or timed out. Try again, or sign in with your password.";
    case "InvalidStateError":
      return "Face or fingerprint is already set up for this sign-in on this phone.";
    case "NotSupportedError":
    case "SecurityError":
      return "This phone or browser cannot use face or fingerprint sign-in here. Sign in with your password.";
    default:
      return "Face or fingerprint sign-in did not work. Try again, or sign in with your password.";
  }
}

/** Why face or fingerprint sign-in is refused for this person (public.my_passkey_refusal, migration 20261120017100). */
export type PasskeyRefusal = "signed_out" | "staff" | "not_driver" | "money" | "demo" | "unavailable";

/** Plain words for each refusal; each says what to do instead. */
export function passkeyRefusalMessage(reason: PasskeyRefusal | string): string {
  switch (reason) {
    case "signed_out":
      return "Your session ended. Sign in again.";
    case "staff":
      return "Face or fingerprint sign-in is not available for the Taviron team. Sign in with your password and authenticator app.";
    case "money":
      return "Your sign-in can see or change money, so it uses your password and two-step verification. Sign in with your password.";
    case "demo":
      return "Demo sign-ins do not use face or fingerprint. Sign in with your password.";
    case "not_driver":
      return "Face or fingerprint sign-in is for driver sign-ins. Sign in with your password.";
    default:
      return "Face or fingerprint sign-in is not available right now. Sign in with your password.";
  }
}
