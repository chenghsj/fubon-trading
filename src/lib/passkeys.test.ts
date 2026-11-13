import { afterEach, expect, it, vi } from 'vitest';
import { creationOptions, requestOptions, decodeBase64url, encodeBase64url } from './passkeys';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

function environment() {
    vi.stubGlobal('location', { hostname: 'localhost', hash: '', origin: 'http://localhost:5179', pathname: '/', search: '' });
    vi.stubGlobal('history', { replaceState: vi.fn() });
    vi.stubGlobal('sessionStorage', { getItem: () => '', setItem: vi.fn(), removeItem: vi.fn() });
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('PublicKeyCredential', class {});
}

it('decodes WebAuthn option buffers without weakening user verification or RP binding', () => {
    const options = creationOptions({ challenge: 'AAECAw', rp: { id: 'localhost', name: 'Fubon' }, user: { id: 'BAU', name: 'local', displayName: 'Local' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' } });
    expect([...new Uint8Array(options.challenge as ArrayBuffer)]).toEqual([0, 1, 2, 3]);
    expect(options.authenticatorSelection?.userVerification).toBe('required');
    expect(options.rp.id).toBe('localhost');
    const request = requestOptions({ challenge: 'AAECAw', rpId: 'localhost', userVerification: 'required', allowCredentials: [{ type: 'public-key', id: 'BAU' }] });
    expect([...new Uint8Array(request.allowCredentials![0]!.id as ArrayBuffer)]).toEqual([4, 5]);
    expect(request.userVerification).toBe('required');
    expect(encodeBase64url(decodeBase64url('_-4'))).toBe('_-4');
});

it('cancelling device verification never submits credentials or grants a session', async () => {
    environment();
    const native = vi.fn().mockResolvedValue(Response.json({ request_id: 'fixture', public_key: { challenge: 'AAECAw', rpId: 'localhost', userVerification: 'required' } }));
    vi.stubGlobal('fetch', native);
    vi.stubGlobal('navigator', { credentials: { get: vi.fn().mockRejectedValue(new DOMException('Cancelled', 'NotAllowedError')) } });
    const { unlockWithPasskey } = await import('./passkeys');
    await expect(unlockWithPasskey(false)).rejects.toThrow('驗證已取消');
    expect(native).toHaveBeenCalledTimes(1);
    expect(native.mock.calls[0]?.[0]).toBe('/api/v1/passkeys/authenticate/options');
});

it('serializes a verified assertion and activates only the returned server session', async () => {
    environment();
    const token = 'T'.repeat(43);
    const native = vi.fn()
        .mockResolvedValueOnce(Response.json({ request_id: 'fixture', public_key: { challenge: 'AAECAw', rpId: 'localhost', userVerification: 'required' } }))
        .mockResolvedValueOnce(Response.json({ access_token: token }))
        .mockResolvedValueOnce(Response.json({}));
    vi.stubGlobal('fetch', native);
    const get = vi.fn().mockResolvedValue({ id: 'AAECAw', type: 'public-key', rawId: new Uint8Array([0, 1, 2, 3]).buffer, authenticatorAttachment: 'platform',
        getClientExtensionResults: () => ({}), response: { clientDataJSON: new Uint8Array([1]).buffer, authenticatorData: new Uint8Array([2]).buffer,
            signature: new Uint8Array([3]).buffer, userHandle: null } });
    vi.stubGlobal('navigator', { credentials: { get } });
    const { unlockWithPasskey } = await import('./passkeys');
    await unlockWithPasskey(false);
    expect(get.mock.calls[0]?.[0].publicKey.userVerification).toBe('required');
    const body = JSON.parse(native.mock.calls[1]?.[1].body);
    expect(body.request_id).toBe('fixture');
    expect(body.credential.response.signature).toBe('Aw');
    expect(sessionStorage.setItem).toHaveBeenCalledWith('fubon-trading-session', token);
    expect(native.mock.calls[2]?.[1].headers.Authorization).toBe(`Bearer ${token}`);
});

it('IP origins and missing enrollment authority cannot create a Passkey', async () => {
    environment();
    const native = vi.fn(); vi.stubGlobal('fetch', native);
    vi.stubGlobal('navigator', { credentials: { create: vi.fn() } });
    const { unlockWithPasskey } = await import('./passkeys');
    await expect(unlockWithPasskey(true)).rejects.toThrow('首次註冊需要啟動授權');
    vi.stubGlobal('location', { hostname: '127.0.0.1' });
    await expect(unlockWithPasskey(false)).rejects.toThrow('localhost');
    expect(native).not.toHaveBeenCalled();
});
