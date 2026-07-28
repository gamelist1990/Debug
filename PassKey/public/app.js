const output = document.querySelector('#output');
const statusBox = document.querySelector('#status');
const usernameInput = document.querySelector('#username');
const registerButton = document.querySelector('#register');
const authenticateButton = document.querySelector('#authenticate');

function toBase64url(value) {
  if (value == null) return null;
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function fromBase64url(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function request(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function setStatus(message, kind) {
  statusBox.textContent = message;
  statusBox.className = `status ${kind}`;
}

function showResult(value) {
  output.textContent = JSON.stringify(value, null, 2);
}

function setBusy(isBusy) {
  registerButton.disabled = isBusy;
  authenticateButton.disabled = isBusy;
}

function serializeRegistration(credential) {
  const response = credential.response;
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      attestationObject: toBase64url(response.attestationObject),
      clientDataJSON: toBase64url(response.clientDataJSON),
      transports: response.getTransports?.() || [],
      publicKey: response.getPublicKey ? toBase64url(response.getPublicKey()) : null,
      publicKeyAlgorithm: response.getPublicKeyAlgorithm?.() ?? null,
      authenticatorData: response.getAuthenticatorData ? toBase64url(response.getAuthenticatorData()) : null,
    },
  };
}

function serializeAuthentication(credential) {
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      authenticatorData: toBase64url(credential.response.authenticatorData),
      clientDataJSON: toBase64url(credential.response.clientDataJSON),
      signature: toBase64url(credential.response.signature),
      userHandle: toBase64url(credential.response.userHandle),
    },
  };
}

async function registerPasskey() {
  setBusy(true);
  setStatus('Windows Hello / OS認証器を呼び出しています…', 'busy');
  try {
    const options = await request('/api/register/options', { username: usernameInput.value.trim() || 'local-user' });
    options.challenge = fromBase64url(options.challenge);
    options.user.id = fromBase64url(options.user.id);
    options.excludeCredentials = options.excludeCredentials.map((item) => ({
      ...item,
      id: fromBase64url(item.id),
    }));

    const credential = await navigator.credentials.create({ publicKey: options });
    if (!credential) throw new Error('認証器からCredentialが返されませんでした。');

    const registration = serializeRegistration(credential);
    const result = await request('/api/register/complete', registration);
    showResult(result);
    setStatus('登録成功：Credential IDと公開鍵情報を取得しました', 'success');
  } catch (error) {
    showResult({ error: error.name, message: error.message });
    setStatus(`登録失敗：${error.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

async function authenticatePasskey() {
  setBusy(true);
  setStatus('OSパスキーによる本人確認を待っています…', 'busy');
  try {
    const options = await request('/api/auth/options', { username: usernameInput.value.trim() || 'local-user' });
    options.challenge = fromBase64url(options.challenge);
    options.allowCredentials = options.allowCredentials.map((item) => ({
      ...item,
      id: fromBase64url(item.id),
    }));

    const credential = await navigator.credentials.get({ publicKey: options });
    if (!credential) throw new Error('認証器からCredentialが返されませんでした。');

    const authentication = serializeAuthentication(credential);
    const result = await request('/api/auth/complete', authentication);
    showResult(result);
    setStatus('認証成功：OSが生成した署名を取得しました', 'success');
  } catch (error) {
    showResult({ error: error.name, message: error.message });
    setStatus(`認証失敗：${error.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

async function inspectEnvironment() {
  const secure = document.querySelector('#secure-context');
  const api = document.querySelector('#api-support');
  const platform = document.querySelector('#platform-support');

  secure.textContent = window.isSecureContext ? '利用可能' : '未対応';
  secure.className = window.isSecureContext ? 'yes' : 'no';

  const hasApi = Boolean(window.PublicKeyCredential && navigator.credentials);
  api.textContent = hasApi ? '利用可能' : '未対応';
  api.className = hasApi ? 'yes' : 'no';

  if (!hasApi) {
    platform.textContent = '確認不可';
    platform.className = 'no';
    registerButton.disabled = true;
    authenticateButton.disabled = true;
    return;
  }

  try {
    const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    platform.textContent = available ? '利用可能' : '見つかりません';
    platform.className = available ? 'yes' : 'no';
  } catch {
    platform.textContent = '確認失敗';
    platform.className = 'no';
  }
}

registerButton.addEventListener('click', registerPasskey);
authenticateButton.addEventListener('click', authenticatePasskey);
document.querySelector('#copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(output.textContent);
  setStatus('結果をクリップボードへコピーしました', 'success');
});

inspectEnvironment();
