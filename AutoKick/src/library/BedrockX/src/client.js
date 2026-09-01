const { ClientStatus, Connection } = require('./connection')
const { createDeserializer, createSerializer } = require('./transforms/serializer')
const { NethernetClient } = require('./nethernet')
const { RakClient } = require('./rak')
const { authenticate } = require('./client/auth')
const { NethernetSignal } = require('./websocket/signal')
const { NethernetJSONRPC } = require('./websocket/signal-jsonrpc')

const JWT = require('jsonwebtoken')
const crypto = require('crypto')

const steve = require("./skins/steve.json");

const { v3, v4, NIL } = require('uuid')

const pem = { format: 'pem', type: 'sec1' }
const der = { format: 'der', type: 'spki' }

class Client extends Connection {
    connection

    constructor(options) {
        super()
        this.options = { ...options }
        this.compressionAlgorithm = 'none'
        this.compressionThreshold = 512
        this.compressionLevel = options.compressionLevel
        this.closing = false

        if (this.options.transport.includes('NETHERNET')) this.nethernet = {}

        if (!options.delayedInit) this.init()
    }

    async init() {
        this.serializer = createSerializer()
        this.deserializer = createDeserializer()
        this.features = { compressorInHeader: true }

        this.ecdhKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: "secp384r1" })
        this.clientX509 = this.ecdhKeyPair.publicKey.export(der).toString('base64')
        this.privateKeyPEM = this.ecdhKeyPair.privateKey.export(pem)

        await authenticate(this, this.options)

        switch (this.options.transport) {
            case "NETHERNET":
            case "NETHERNET_JSONRPC":
                this.connection = new NethernetClient({
                    networkId: this.options.networkId,
                    serverNetworkId: this.options.serverNetworkId,
                    token: this.token,
                    identityPrivateKey: this.ecdhKeyPair.privateKey,
                    onError: (error) => this.emit('error', error)
                })

                this.batchHeader = null
                this.disableEncryption = true

                this.nethernet.signalling = this.options.transport === "NETHERNET_JSONRPC" ? new NethernetJSONRPC(this.connection.nethernet.networkId, this.options.authflow, this.options.version, this.options.serverNetworkId) : new NethernetSignal(this.connection.nethernet.networkId, this.options.authflow, this.options.version, this.options.serverNetworkId)

                await this.nethernet.signalling.connect()

                this.connection.nethernet.credentials = this.nethernet.signalling.credentials
                this.connection.nethernet.signalHandler = this.nethernet.signalling.write.bind(this.nethernet.signalling)

                this.nethernet.signalling.on('signal', signal => this.connection.nethernet.handleSignal(signal))
                break;
            case "DEFAULT":
                this.connection = new RakClient({ host: this.options.host, port: this.options.port })

                this.batchHeader = 0xfe
                this.disableEncryption = false
                break;
        }

        this.batch.updateCompressionSettings(this)

        this.emit('connect_allowed')
    }

    connect() {
        if (!this.connection) throw new Error('Connect not currently allowed')
        return this._connect()
    }

    onEncapsulated = (encapsulated) => {
        this.handle(Buffer.from(encapsulated.buffer))
    }

    _connect = async () => {
        this.connection.onConnected = () => {
            this.status = ClientStatus.Connecting
            this.write('request_network_settings', { client_protocol: this.options.protocolVersion })
        }

        this.connection.onCloseConnection = (reason) => {
            this.close(reason)
        }

        this.connection.onEncapsulated = this.onEncapsulated
        if (typeof this.connection.on === 'function') {
            this.connection.on('error', (error) => this.emit('error', error))
        }
        try {
            await this.connection.connect()
        } catch (error) {
            this.emit('error', error)
            throw error
        }
    }

    async handleTransfer(params) {
        const address = typeof params?.server_address === 'string' ? params.server_address.trim() : ''
        const port = Number(params?.port)
        if (!address || !Number.isInteger(port) || port < 1 || port > 65535) {
            this.emit('error', new Error(`不正なtransferパケット: server_address=${String(params?.server_address ?? '')} port=${String(params?.port ?? '')}`))
            return
        }

        // フレンドワールドはSession Directory/NetherNetで開始した後、
        // transferパケットで外部Bedrockサーバーへ接続先を切り替えることがある。
        // 同じClient・同じXbox認証を維持したまま、転送先だけRakNetへ切り替える。
        const previousSignalling = this.nethernet?.signalling
        const previousConnection = this.connection
        this.emit('transfer_start', { server_address: address, port })
        this.clearPendingTimers()
        // 旧接続のclose通知でClient全体を終了させない。
        if (previousConnection) {
            previousConnection.onCloseConnection = () => {}
            previousConnection.onEncapsulated = () => {}
            previousConnection.close()
        }
        if (previousSignalling) {
            try { await previousSignalling.destroy() } catch { /* 転送を継続 */ }
        }
        this.nethernet = null
        this.options.transport = 'DEFAULT'
        this.options.host = address
        this.options.port = port
        this.batchHeader = 0xfe
        this.disableEncryption = false
        this.compressionAlgorithm = 'none'
        this.compressionThreshold = 512
        this.compressionReady = false
        this.connection = new RakClient({ host: address, port })
        this.emit('transfer', { server_address: address, port, reload_world: params?.reload_world === true })
        try {
            await this._connect()
        } catch (error) {
            this.emit('transfer_error', { server_address: address, port, error })
            throw error
        }
    }

    sendLogin() {
        this.status = ClientStatus.Authenticating

        let payload = {
            GameVersion: this.options.version,
            PersonaSkin: true,
            DeviceOS: 2,
            DeviceId: v3(v4(), NIL).replace(/-/g, '').toUpperCase(),
            DeviceModel: 'iPhone14,3',
            CurrentInputMode: 2,
            DefaultInputMode: 2,
            SelfSignedId: v3(v4(), NIL),
            GUIScale: 0,
            UIProfile: 1,
            LanguageCode: 'en_US',
            MaxViewDistance: 12,
            MemoryTier: 4,
            PlatformType: 1,
            GraphicsMode: 1,
            TrustedSkin: true,
            OverrideSkin: false,
            ...steve,
            ...this.options.skinData
        }

        const PlayFabId = this.tokenData.mid.toLowerCase() || "";

        const updPFID = (data) => btoa(atob(data).replaceAll(`aed7e8a4d485a49a-5`, `${PlayFabId}-5`));
        payload.SkinId = `persona-${PlayFabId || ""}-5`;
        payload.SkinGeometryData = updPFID(payload.SkinGeometryData);
        payload.SkinResourcePatch = updPFID(payload.SkinResourcePatch);

        this.write('login', {
            protocol_version: this.options.protocolVersion,
            tokens: {
                identity: JSON.stringify({ AuthenticationType: 0, Certificate: JSON.stringify({ chain: [] }), Token: this.token }),
                client: JWT.sign(payload, this.ecdhKeyPair.privateKey, { algorithm: 'ES384', header: { x5u: this.clientX509 } })
            }
        })
    }

    disconnect(reason = 'Client leaving') {
        if (this.status === ClientStatus.Disconnected) return

        this.close(reason)
    }

    close(reason) {
        if (this.status === ClientStatus.Disconnected || this.closing) return
        this.closing = true
        this.clearPendingTimers()
        const signalling = this.nethernet?.signalling
        this.status = ClientStatus.Disconnected
        this.emit('close', reason)
        this.batch = null;
        this.connection?.close()
        this.removeAllListeners()
        if (!this.options.transport.includes("NETHERNET")) return
        if (signalling) void signalling.destroy()
        this.nethernet = null
    }

    readPacket(packet) {
        try {
            var des = this.deserializer.parsePacketBuffer(packet) // eslint-disable-line
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            // 一部のBedrockサーバーは、ログイン完了後に現在のプロトコル定義へ
            // 未登録の追加パケットを送る。このパケットを既知の文字列フィールド
            // として解析すると、実データより極端に大きい長さを読み取り
            // "Read error for undefined / Missing characters in string" になる。
            // 接続済みセッション全体を切断せず、不明な1パケットだけ破棄する。
            const isUnsupportedPacket = message.includes('Read error for undefined') && (
                message.includes('Missing characters in string') ||
                message.includes('varint is too big')
            )
            if (isUnsupportedPacket) {
                console.warn('[BedrockX] 未対応パケットを破棄しました', {
                    packetLength: Buffer.isBuffer(packet) ? packet.length : undefined,
                    packetPrefix: Buffer.isBuffer(packet) ? packet.subarray(0, 12).toString('hex') : undefined,
                    protocolVersion: this.options.protocolVersion,
                    status: this.status
                })
                return
            }
            this.emit('error', e)
            return
        }

        // Abstract some boilerplate before sending to listeners
        switch (des.data.name) {
            case 'network_settings':
                this.compressionAlgorithm = des.data.params.compression_algorithm || 'deflate'
                this.compressionThreshold = des.data.params.compression_threshold
                this.compressionReady = true
                this.batch.updateCompressionSettings(this)

                this.sendLogin()
                break
            case 'server_to_client_handshake':
                const [header, payload] = des.data.params.token.split('.', 2).map(part => JSON.parse(Buffer.from(part, 'base64url').toString()))

                if (!this.disableEncryption) {
                    this.secretKeyBytes = crypto.createHash('sha256').update(Buffer.from(payload.salt, 'base64')).update(crypto.diffieHellman({ privateKey: this.ecdhKeyPair.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.from(header.x5u, 'base64'), ...der }) })).digest()
                    this.startEncryption(this.secretKeyBytes.slice(0, 16))
                }

                this.write('client_to_server_handshake', {})
                this.status = ClientStatus.Initializing
                break
            case 'disconnect': // Client kicked
                this.emit('kick', des.data.params)
                this.close()
                break
            case 'transfer':
                void this.handleTransfer(des.data.params).catch((error) => this.emit('error', error))
                break
            case 'item_registry':
                des.data.params.itemstates?.forEach(state => {
                    if (state.name === 'minecraft:shield') {
                        this.serializer.proto.setVariable('ShieldItemID', state.runtime_id)
                        this.deserializer.proto.setVariable('ShieldItemID', state.runtime_id)
                    }
                })
                break
            case 'play_status':
                if (this.status === ClientStatus.Authenticating) this.status = ClientStatus.Initializing
                break
            default:
                break
        }

        this.emit(des.data.name, des.data.params)
    }
}

module.exports = { Client }