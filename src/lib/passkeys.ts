import { activateSession, canEnrollPasskey, sessionRequest } from './fubon-session';

export function decodeBase64url(value: string): ArrayBuffer {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
    return bytes.buffer;
}

export function encodeBase64url(value: ArrayBuffer): string {
    return btoa(Array.from(new Uint8Array(value), byte => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type Descriptor = Omit<PublicKeyCredentialDescriptor, 'id'> & { id: string };
export type CreationJSON = Omit<PublicKeyCredentialCreationOptions, 'challenge' | 'user' | 'excludeCredentials'> & {
    challenge: string; user: Omit<PublicKeyCredentialUserEntity, 'id'> & { id: string }; excludeCredentials?: Descriptor[];
};
export type RequestJSON = Omit<PublicKeyCredentialRequestOptions, 'challenge' | 'allowCredentials'> & {
    challenge: string; allowCredentials?: Descriptor[];
};

export function creationOptions(value: CreationJSON): PublicKeyCredentialCreationOptions {
    return { ...value, challenge: decodeBase64url(value.challenge), user: { ...value.user, id: decodeBase64url(value.user.id) },
        excludeCredentials: value.excludeCredentials?.map(item => ({ ...item, id: decodeBase64url(item.id) })) };
}

export function requestOptions(value: RequestJSON): PublicKeyCredentialRequestOptions {
    return { ...value, challenge: decodeBase64url(value.challenge),
        allowCredentials: value.allowCredentials?.map(item => ({ ...item, id: decodeBase64url(item.id) })) };
}

function serialize(credential: PublicKeyCredential, register: boolean) {
    const base = { id: credential.id, rawId: encodeBase64url(credential.rawId), type: credential.type,
        clientExtensionResults: credential.getClientExtensionResults(), authenticatorAttachment: credential.authenticatorAttachment };
    if (register) {
        const response = credential.response as AuthenticatorAttestationResponse;
        return { ...base, response: { clientDataJSON: encodeBase64url(response.clientDataJSON),
            attestationObject: encodeBase64url(response.attestationObject), transports: response.getTransports?.() ?? [] } };
    }
    const response = credential.response as AuthenticatorAssertionResponse;
    return { ...base, response: { clientDataJSON: encodeBase64url(response.clientDataJSON), authenticatorData: encodeBase64url(response.authenticatorData),
        signature: encodeBase64url(response.signature), userHandle: response.userHandle ? encodeBase64url(response.userHandle) : null } };
}

export function passkeysSupported(): boolean {
    return location.hostname === 'localhost' && window.isSecureContext && typeof PublicKeyCredential !== 'undefined' && !!navigator.credentials;
}

export async function unlockWithPasskey(register: boolean): Promise<void> {
    if (!passkeysSupported()) throw new Error('此瀏覽器或網址無法使用 Passkey，請使用新版瀏覽器開啟 localhost 啟動視窗。');
    if (register && !canEnrollPasskey()) throw new Error('首次註冊需要啟動授權，請重新執行 pnpm start。');
    const action = register ? 'register' : 'authenticate';
    const options = await sessionRequest(`/api/v1/passkeys/${action}/options`, {}, register);
    let credential: Credential | null;
    try {
        credential = register
            ? await navigator.credentials.create({ publicKey: creationOptions(options.public_key as CreationJSON) })
            : await navigator.credentials.get({ publicKey: requestOptions(options.public_key as RequestJSON) });
    } catch {
        throw new Error('驗證已取消或未完成。請再次點選，使用 Touch ID、裝置解鎖或安全金鑰完成驗證。');
    }
    if (!credential || credential.type !== 'public-key') throw new Error('未取得 Passkey，請重試。');
    const result = await sessionRequest(`/api/v1/passkeys/${action}/verify`, {
        request_id: options.request_id, credential: serialize(credential as PublicKeyCredential, register),
    }, register);
    if (!await activateSession(result.access_token)) throw new Error('工作階段未建立，請重試。');
}
