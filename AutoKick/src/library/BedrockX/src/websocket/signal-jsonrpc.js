const { EventEmitter, once } = require('node:events')
const { WebSocket } = require('ws')
const { SignalStructure } = require('../nethernet/index')
const { v4fast: v4 } = require("uuid-1345")
const JSONBigInt = require('json-bigint')({ useNativeBigInt: true })

const MAX_RETRIES = 5

class NethernetJSONRPC extends EventEmitter {
    constructor(networkId, authflow, version, serverNetworkId) {
        super()
        this.networkId = networkId
        this.serverNetworkId = serverNetworkId
        this.authflow = authflow
        this.version = version
        this.ws = null
        this.credentials = []
        this.candidates = []
        this.signalCandidates = []

        this.pingInterval = null
        this.retryCount = 0
        this.destroyed = false
        this.lastLiveness = 0
        this.connectionId = null
        this.didSendCandidates = false
        this.connectRequestSent = false
        this.sentSignalCount = 0
        this.receivedSignalCount = 0
        this.lastSendTarget = null
        this.lastRpcError = null
    }

    async connect() {
        if (this.ws?.readyState === WebSocket.OPEN) throw new Error('Already connected signaling server');
        this.destroyed = false

        console.log('[NetherNet] signaling WebSocket connecting')
        await this.init()
        await Promise.race([
            once(this, "credentials"),
            new Promise((_, reject) => setTimeout(() => reject(), 15000))
        ])
        console.log('[NetherNet] TURN credentials received')
    }

    async destroy(resume = false) {
        this.destroyed = !resume

        if (this.pingInterval) {
            clearInterval(this.pingInterval)
            this.pingInterval = null
        }

        const ws = this.ws
        this.ws = null

        if (ws) {
            ws.removeAllListeners("open")
            ws.removeAllListeners("close")
            ws.removeAllListeners("error")
            ws.removeAllListeners("message")

            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                await Promise.race([new Promise((resolve) => {
                    const done = () => resolve()

                    ws.once("close", done)

                    try {
                        ws.close(1000, "Normal Closure")
                    } catch {
                        resolve()
                    }
                }), new Promise((resolve) => setTimeout(() => {
                    try { ws.terminate() } catch { }
                    resolve()
                }, 2000))])
            }
        }

        if (resume) return this.reconnectWithBackoff()
    }

    async reconnectWithBackoff() {
        if (this.retryCount >= MAX_RETRIES) {
            this.emit("error", new Error("Signal reconnection failed after max retries"));
            return;
        }

        await new Promise((r) => setTimeout(r, 15000));

        try {
            await this.init();
        } catch (e) { }
    }

    async init() {
        const xbl = await this.authflow.getMinecraftBedrockServicesToken({ version: this.version })

        const address = `https://signal.franchise.minecraft-services.net/ws/v1.0/messaging/connect`;

        try {
            const ws = new WebSocket(address, { headers: { Authorization: xbl.mcToken, "session-id": v4(), "request-id": v4() } })
            this.ws = ws
            this.lastLiveness = Date.now()

            ws.on("open", () => this.onOpen())
            ws.on("close", (code, reason) => this.onClose(code, reason.toString()))
            ws.on("error", (err) => this.onError(err))
            ws.on("message", (data) => this.onMessage(data))
            console.log('[NetherNet] signaling WebSocket initialized')

            if (!this.pingInterval) {
                this.pingInterval = setInterval(() => {
                    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

                    this.ws.send(JSON.stringify({ params: {}, jsonrpc: "2.0", method: "System_Ping_v1_0", id: v4() }))

                    if (Date.now() - this.lastLiveness > 60000) {
                        try {
                            this.ws.terminate?.()
                        } catch { }
                    }
                }, 2000)
            }
        } catch (error) {
            this.emit("error", error)
        }
    }

    onOpen() {
        this.retryCount = 0
        this.lastLiveness = Date.now()
        console.log('[NetherNet][debug] signaling open', {
            networkId: String(this.networkId),
            configuredServerNetworkId: String(this.serverNetworkId ?? ''),
            wsReadyState: this.ws?.readyState
        })
        this.ws.send(JSON.stringify({
            params: {},
            jsonrpc: "2.0",
            method: "Signaling_TurnAuth_v1_0",
            id: v4()
        }))
    }

    onError(err) {
        console.error(err);
        this.emit("error", err instanceof Error ? err : new Error(`Signaling WebSocket error: ${String(err)}`))
    }

    async onClose(code, reason) {
        if (this.ws === null && this.pingInterval) {
            clearInterval(this.pingInterval)
            this.pingInterval = null
        }

        if (this.destroyed) return

        // 1006 closure
        // 1011 error
        // 4401 unauthorized
        const retryable = [1000, 1006, 1011, 4401].includes(code) || code === 0

        if (retryable && this.retryCount < MAX_RETRIES) {
            this.retryCount++
            await this.destroy(true)
        } else {
            await this.destroy(false)
            this.emit("error", new Error(`Signal closed: ${code} ${reason}`))
        }
    }

    onMessage(res) {
        this.lastLiveness = Date.now()

        let message = null

        try {
            if (typeof res === "string") {
                message = JSON.parse(res)
            } else if (Buffer.isBuffer(res)) {
                message = JSON.parse(res.toString("utf8"))
            } else {
                return
            }
        } catch (error) {
            console.error('[NetherNet] invalid signaling message:', error)
            return
        }

        if (message?.error) {
            console.error('[NetherNet] signaling RPC error:', message.error)
            this.lastRpcError = message.error
        }

        if (Array.isArray(message.result?.TurnAuthServers)) {
            this.credentials = parseTurnServers(JSON.stringify(message.result))
            this.emit("credentials", this.credentials)
        }

        switch (message.method) {
            case "System_Pong_v1_0":
                this.ws.send(JSON.stringify({ id: message.id, result: null, jsonrpc: "2.0" }))
                break
            case "Signaling_ReceiveMessage_v1_0":
                this.ws.send(JSON.stringify({ id: message.id, result: null, jsonrpc: "2.0" }))
                const params = Array.isArray(message.params)? message.params : message.params ? [message.params]: []
                for (const param of params) {
                    this.sendDeliveryNotification(param.From, param.Id)
                    let signalMessage = param.Message
                    try {
                        const parsed = JSON.parse(param.Message)

                        switch (parsed.method) {
                            case "Signaling_WebRtc_v1_0":
                                if (parsed.params?.message) signalMessage = parsed.params.message
                                break
                            case "Signaling_DeliveryNotification_V1_0":
                                continue
                        }
                    } catch (e) {
                        console.error(e)
                    }

                    if (signalMessage.includes("could not be delivered")) {
                        console.error('[NetherNet] delivery failure:', signalMessage)
                        continue
                    }

                    let signal
                    try {
                        signal = SignalStructure.fromString(signalMessage)
                    } catch (error) {
                        console.error('[NetherNet] invalid NetherNet signal:', error)
                        continue
                    }
                    signal.connectionId = BigInt(signal.connectionId)
                    signal.networkId = this.networkId
                    signal.serverNetworkId = param.From ?? this.serverNetworkId

                    // 同じPmsgIdでは、終了済みまたは並行中の別接続に対する信号も
                    // 配信される。connectionIdが現在の接続と一致しない信号を
                    // WebRTCへ渡すと、別接続のDataChannelデータが混ざり、Bedrock
                    // パケットを巨大な文字列長として誤読する原因になるため破棄する。
                    if (this.connectionId !== null && signal.connectionId !== this.connectionId) {
                        continue
                    }

                    this.receivedSignalCount++
                    if (signal.type !== "CANDIDATEADD") {
                        console.log(`[NetherNet] signal received: ${signal.type}`, {
                            connectionId: String(signal.connectionId),
                            expectedConnectionId: String(this.connectionId ?? ''),
                            from: String(param.From ?? ''),
                            expectedServerNetworkId: String(this.serverNetworkId ?? ''),
                            dataLength: String(signal.data ?? '').length,
                            receivedSignalCount: this.receivedSignalCount
                        })
                    }

                    if (signal.type === "CANDIDATEADD") {
                        signal.data += " network-cost 10";

                        if (!this.didSendCandidates) {
                            this.signalCandidates.push(signal);
                            continue
                        }
                    }

                    if (
                        signal.type === "CONNECTRESPONSE" &&
                        signal.connectionId === this.connectionId &&
                        !this.didSendCandidates
                    ) {
                        for (const candidate of this.candidates) {
                            this.write(candidate)
                        }

                        for (const signalCandidate of this.signalCandidates) {
                            this.emit("signal", signalCandidate)
                        }

                        this.didSendCandidates = true
                    }

                    this.emit("signal", signal)
                }
                break
            default:
                break
        }
    }

    write(signal) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('WebSocket not connected')

        let uuidv4 = v4()

        if (signal.type === "CANDIDATEADD" && !this.candidates.includes(signal)) {
            this.candidates.length === 0 ? signal.data += " network-cost 50" : signal.data += " network-cost 10"

            if (signal.data.includes("tcp") || signal.data.includes("::1") || signal.data.includes("127.0.0.1")) return;

            this.candidates.push(signal)
            // CONNECTREQUESTより前に生成された候補だけを一時保持する。
            // CONNECTREQUEST送信後の候補までCONNECTRESPONSE待ちにすると、相手が
            // ICE候補を受け取れず応答を返せないデッドロックになるため即時送信する。
            if (!this.connectRequestSent) return
        }

        if (signal.type === "CONNECTREQUEST") {
            this.connectionId = signal.connectionId
            this.connectRequestSent = true
            console.log('[NetherNet] sending CONNECTREQUEST', {
                connectionId: String(signal.connectionId),
                networkId: String(signal.networkId),
                serverNetworkId: String(signal.serverNetworkId ?? this.serverNetworkId),
                sdpLength: String(signal.data ?? '').length
            })
        }

        const target = String(signal.serverNetworkId ?? this.serverNetworkId)
        this.sentSignalCount++
        this.lastSendTarget = target

        const message = JSONBigInt.stringify({
            params: {
                toPlayerId: target,
                messageId: uuidv4,
                message: JSONBigInt.stringify({
                    params: {
                        netherNetId: String(signal.networkId),
                        message: signal.toString(),
                    },
                    jsonrpc: "2.0",
                    method: "Signaling_WebRtc_v1_0",
                })
            },
            jsonrpc: "2.0",
            method: "Signaling_SendClientMessage_v1_0",
            id: uuidv4
        })

        this.ws.send(message)
        console.log('[NetherNet][debug] signaling send queued', {
            type: signal.type,
            target,
            connectionId: String(signal.connectionId),
            wsBufferedAmount: this.ws.bufferedAmount,
            sentSignalCount: this.sentSignalCount,
            storedLocalCandidates: this.candidates.length,
            storedRemoteCandidates: this.signalCandidates.length
        })
    }

    debugState() {
        return {
            wsReadyState: this.ws?.readyState,
            networkId: String(this.networkId),
            configuredServerNetworkId: String(this.serverNetworkId ?? ''),
            connectionId: String(this.connectionId ?? ''),
            lastSendTarget: this.lastSendTarget,
            sentSignalCount: this.sentSignalCount,
            receivedSignalCount: this.receivedSignalCount,
            storedLocalCandidates: this.candidates.length,
            storedRemoteCandidates: this.signalCandidates.length,
            didSendCandidates: this.didSendCandidates,
            connectRequestSent: this.connectRequestSent,
            lastLivenessAgeMs: Date.now() - this.lastLiveness,
            lastRpcError: this.lastRpcError
        }
    }

    sendDeliveryNotification(toPlayerId, messageId) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

        const uuidv4 = v4()
        const message = JSONBigInt.stringify({
            params: {
                toPlayerId,
                messageId: uuidv4,
                message: JSONBigInt.stringify({
                    params: {
                        messageId
                    },
                    jsonrpc: "2.0",
                    method: "Signaling_DeliveryNotification_V1_0"
                })
            },
            jsonrpc: "2.0",
            method: "Signaling_SendClientMessage_v1_0",
            id: uuidv4
        })

        this.ws.send(message)
    }
}

module.exports = { NethernetJSONRPC }

function parseTurnServers(dataString) {
    const iceServers = []
    const TurnAuthServers = JSON.parse(dataString)?.TurnAuthServers ?? []

    for (const server of TurnAuthServers) {
        const urls = server?.Urls ?? []
        const username = typeof server?.Username === "string" ? server.Username : undefined
        const credential = typeof server?.Password === "string" ? server.Password : (typeof server?.Credential === "string" ? server.Credential : undefined)

        for (const rawUrl of urls) {
            const parsedUrl = parseIceUrl(rawUrl)
            if (!parsedUrl) continue

            const urlCandidates = new Set([formatIceUrl(parsedUrl)])

            if (parsedUrl.isTurn) {
                if (parsedUrl.transport !== "tcp") urlCandidates.add(formatIceUrl({ ...parsedUrl, transport: "udp" }))
                if (parsedUrl.scheme !== "turns") urlCandidates.add(formatIceUrl({ ...parsedUrl, scheme: "turns", port: 5349, transport: "udp" }))
            }

            for (const url of urlCandidates) {
                parsedUrl.isTurn ? iceServers.push({ urls: url, username, credential }) : iceServers.push({ urls: url })
            }
        }
    }

    return iceServers
}

function parseIceUrl(url) {
    const match = url.trim().match(/^(?<scheme>stuns?|turns?)(?::\/\/|:)?(?<host>[^:?\s]+)(?::(?<port>\d+))?(?:\?(?<query>.*))?$/i)
    if (!match || !match.groups) return null

    const scheme = match.groups.scheme.toLowerCase()
    const hostname = match.groups.host
    const port = match.groups.port ? parseInt(match.groups.port, 10) : defaultPortForScheme(scheme)

    if (!hostname || Number.isNaN(port)) return null

    const isTurn = scheme.startsWith("turn")

    let transport
    if (scheme === "turns") transport = "tcp"

    if (isTurn) transport = match.groups.query?.split("&").find(param => param.startsWith("transport="))?.split("=")[1] ?? "udp"
    if (!transport) transport = "udp"

    return { scheme, hostname, port, transport, isTurn }
}

function formatIceUrl(parsed) {
    const protocol = parsed.scheme
    const base = `${protocol}:${parsed.hostname}:${parsed.port}`

    if (!parsed.isTurn) return base

    return `${base}?transport=${parsed.transport ?? "udp"}`
}

function defaultPortForScheme(scheme) {
    return scheme === "stuns" ? 3478 : 5349
}
