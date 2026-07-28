const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');

const sessions = new Map();
const credentials = new Map();

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function randomChallenge() {
  return base64url(crypto.randomBytes(32));
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function getSession(req, res) {
  const cookies = parseCookies(req);
  let sessionId = cookies.passkey_session;

  if (!sessionId || !sessions.has(sessionId)) {
    sessionId = base64url(crypto.randomBytes(24));
    sessions.set(sessionId, {});
    res.setHeader(
      'Set-Cookie',
      `passkey_session=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Strict; Path=/`,
    );
  }

  return sessions.get(sessionId);
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('Request body is too large');
  }
  return body ? JSON.parse(body) : {};
}

function serveStatic(req, res) {
  const urlPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  const relativePath = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, relativePath);

  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Not found');
      return;
    }

    const type = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
    }[path.extname(filePath)] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const session = getSession(req, res);

    if (req.method === 'POST' && url.pathname === '/api/register/options') {
      const { username = 'local-user' } = await readJson(req);
      const challenge = randomChallenge();
      const userId = base64url(crypto.createHash('sha256').update(username).digest().subarray(0, 16));

      session.registrationChallenge = challenge;
      session.username = username;

      sendJson(res, 200, {
        challenge,
        rp: { name: 'Windows Passkey Test', id: 'localhost' },
        user: { id: userId, name: username, displayName: username },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        timeout: 60000,
        attestation: 'none',
        authenticatorSelection: {
          residentKey: 'required',
          requireResidentKey: true,
          userVerification: 'required',
        },
        excludeCredentials: [...credentials.values()]
          .filter((item) => item.username === username)
          .map((item) => ({ type: 'public-key', id: item.id })),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/register/complete') {
      const body = await readJson(req);
      if (!session.registrationChallenge || !body.id || !body.response) {
        sendJson(res, 400, { error: '登録情報またはチャレンジがありません。' });
        return;
      }

      credentials.set(body.id, {
        id: body.id,
        rawId: body.rawId,
        username: session.username,
        type: body.type,
        authenticatorAttachment: body.authenticatorAttachment,
        clientExtensionResults: body.clientExtensionResults,
        transports: body.response.transports || [],
        attestationObject: body.response.attestationObject,
        clientDataJSON: body.response.clientDataJSON,
        publicKey: body.response.publicKey || null,
        publicKeyAlgorithm: body.response.publicKeyAlgorithm ?? null,
        createdAt: new Date().toISOString(),
      });

      delete session.registrationChallenge;
      sendJson(res, 200, {
        ok: true,
        message: 'パスキーを登録しました。秘密鍵はOSから取得できないため、Credential IDと公開鍵情報のみ表示します。',
        credential: credentials.get(body.id),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/options') {
      const { username = 'local-user' } = await readJson(req);
      const challenge = randomChallenge();
      const allowCredentials = [...credentials.values()]
        .filter((item) => item.username === username)
        .map((item) => ({ type: 'public-key', id: item.id, transports: item.transports }));

      if (allowCredentials.length === 0) {
        sendJson(res, 404, { error: '先にこのユーザーのパスキーを登録してください。' });
        return;
      }

      session.authenticationChallenge = challenge;
      session.username = username;
      sendJson(res, 200, {
        challenge,
        rpId: 'localhost',
        allowCredentials,
        userVerification: 'required',
        timeout: 60000,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/complete') {
      const body = await readJson(req);
      const saved = credentials.get(body.id);
      if (!session.authenticationChallenge || !saved || !body.response) {
        sendJson(res, 400, { error: '認証情報またはチャレンジがありません。' });
        return;
      }

      delete session.authenticationChallenge;
      sendJson(res, 200, {
        ok: true,
        message: 'OSパスキーによる署名レスポンスを取得しました。',
        credential: {
          id: body.id,
          username: saved.username,
          authenticatorAttachment: body.authenticatorAttachment,
          authenticatorData: body.response.authenticatorData,
          clientDataJSON: body.response.clientDataJSON,
          signature: body.response.signature,
          userHandle: body.response.userHandle,
        },
        warning: 'このアプリはAPI動作確認用です。実運用ではサーバー側でclientDataJSON、origin、challenge、RP ID hash、署名、カウンターを検証してください。',
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/credentials') {
      sendJson(res, 200, { credentials: [...credentials.values()] });
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || 'Internal server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Passkey test app: http://localhost:${PORT}`);
  console.log('終了するには Ctrl+C を押してください。');
});
