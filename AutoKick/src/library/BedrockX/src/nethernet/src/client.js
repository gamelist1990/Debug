const dgram = require('node:dgram')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { Connection } = require('./connection')
const { PACKET_TYPE, createDeserializer, createSerializer } = require('./serializer')
const { SignalStructure, SignalType } = require('./signalling')
const { createPacketData, getRandomUint64, prepareSecurePacket, processSecurePacket } = require('./util')
const { RTCPeerConnection, RTCIceCandidate } = require('@roamhq/wrtc')
const { CompactSign, importPKCS8 } = require("jose");

const PORT = 7551
const BROADCAST_ADDRESS = '255.255.255.255'

class Client extends EventEmitter {
  constructor(networkId, broadcastAddress = BROADCAST_ADDRESS, token, identityPrivateKey, signalServerNetworkId) {
    super()

    this.serverNetworkId = networkId
    this.signalServerNetworkId = signalServerNetworkId ?? networkId
    this.broadcastAddress = broadcastAddress
    this.token = token
    this.identityPrivateKey = identityPrivateKey
    this.networkId = getRandomUint64()
    this.connectionId = getRandomUint64()
    this.socket = dgram.createSocket('udp4')
    this.socket.on('message', (buffer, rinfo) => this.processPacket(buffer, rinfo))
    this.socket.bind(() => this.socket.setBroadcast(true))

    this.serializer = createSerializer()
    this.deserializer = createDeserializer()

    this.responses = new Map()
    this.addresses = new Map()
    this.serverData = null
    this.serverDataWaiters = []
    this.pendingCandidates = []
    this.credentials = []
    this.signalHandler = this.sendDiscoveryMessage

    this.running = false
    this.localCandidateCount = 0
    this.remoteCandidateCount = 0
    this.connectResponseCount = 0
    this.connectResponseTimer = null
    this.connectResponseStartedAt = 0
    this.connectRequestSignal = null
    this.connectRequestRetryCount = 0
    this.terminalEvent = false

    this.sendDiscoveryRequest()

    this.pingInterval = setInterval(() => this.sendDiscoveryRequest(), 2000);
  }

  handleCandidate(signal) {
    this.remoteCandidateCount++
    // CONNECTRESPONSE and CANDIDATEADD can arrive in either order.  wrtc
    // rejects remote ICE candidates until the answer has been applied, so
    // retain early candidates and flush them from handleAnswer().
    if (!this.rtcConnection || this.rtcConnection.signalingState !== 'stable') {
      this.pendingCandidates.push(signal)
      return
    }

    this.addCandidate(signal)
  }

  addCandidate(signal) {
    const rawData = typeof signal.data === 'string' ? signal.data : signal.data.candidate;

    const parts = rawData.replace(/^candidate:/, "").trim().split(" ");

    const parsedData = {
      candidate: signal.data,
      foundation: parts[0],
      component: parseInt(parts[1]),
      protocol: parts[2],
      priority: parseInt(parts[3]),
      address: parts[4],
      port: parseInt(parts[5]),
      type: parts[7],
      sdpMid: signal.data.sdpMid || "0",
      sdpMLineIndex: signal.data.sdpMLineIndex ?? 0
    };

    if (parts[8] === "raddr") parsedData.relatedAddress = parts[9];
    if (parts[10] === "rport") parsedData.relatedPort = parseInt(parts[11]);

    const ufragIndex = parts.indexOf("ufrag");
    if (ufragIndex !== -1) parsedData.usernameFragment = parts[ufragIndex + 1];

    this.rtcConnection.addIceCandidate(new RTCIceCandidate(parsedData)).catch(e => console.error("ICE:", e));
  }

  async handleAnswer(signal) {
    if (!this.running || !this.rtcConnection) return

    this.connectResponseCount++
    console.log('[NetherNet][debug] CONNECTRESPONSE accepted for processing', {
      count: this.connectResponseCount,
      connectionId: String(signal.connectionId),
      expectedConnectionId: String(this.connectionId),
      signalingState: this.rtcConnection.signalingState,
      answerLength: String(signal.data ?? '').length
    })

    switch (this.rtcConnection.signalingState) {
      case "stable":
        console.error("Received answer in stable state, ignoring.")
        return
      case "closed":
        console.error("Received answer for closed connection, ignoring.")
        return
    }

    try {
      if (this.connectResponseTimer) {
        clearTimeout(this.connectResponseTimer)
        this.connectResponseTimer = null
      }
      await this.rtcConnection.setRemoteDescription({ type: 'answer', sdp: signal.data })
      console.log('[NetherNet] remote answer applied')
      const pendingCandidates = this.pendingCandidates.splice(0)
      for (const candidate of pendingCandidates) this.addCandidate(candidate)
    } catch (e) {
      console.error("Failed to set remote description:", e)
      this.emit('error', e)
    }
  }

  async createAssertion(fingerprint, token) {
    if (!this.identityPrivateKey) {
      throw new Error('Missing private key for NetherNet identity assertion')
    }
    const payload = JSON.stringify({ fingerprint: [{ algorithm: "sha-256", digest: fingerprint }] });

    const pkcs8Key = this.identityPrivateKey.export({ type: "pkcs8", format: "pem" })
    const ecPrivateKey = await importPKCS8(pkcs8Key, "ES384");
    const encoder = new TextEncoder();

    const jws = await new CompactSign(encoder.encode(payload)).setProtectedHeader({ alg: "ES384" }).sign(ecPrivateKey);

    const parts = jws.split(".");
    const fingerprints = `${parts[0]}..${parts[2]}`;

    const data = {
      assertion: JSON.stringify({
        fingerprints,
        token
      }),
      idp: {
        domain: "https://authorization.franchise.minecraft-services.net/",
        protocol: "default",
      }
    }

    return Buffer.from(JSON.stringify(data)).toString('base64')
  }

  async createOffer() {
    this.rtcConnection = new RTCPeerConnection({ iceServers: this.credentials, bundlePolicy: 'max-bundle' })
    this.connection = new Connection(this, this.connectionId, this.rtcConnection)

    const reliable = this.rtcConnection.createDataChannel('ReliableDataChannel', { ordered: true })
    const unreliable = this.rtcConnection.createDataChannel('UnreliableDataChannel', { ordered: false, maxRetransmits: 0 })
    this.connection.setChannels(reliable, unreliable)

    this.rtcConnection.onicecandidate = (event) => {
      if (!event.candidate) {
        console.log('[NetherNet][debug] ICE gathering complete', {
          localCandidateCount: this.localCandidateCount,
          iceGatheringState: this.rtcConnection?.iceGatheringState
        })
        return
      }

      if (event.candidate.candidate.includes("tcp") || event.candidate.candidate.includes("::1") || event.candidate.candidate.includes("127.0.0.1")) return;

      this.localCandidateCount++
      const candidateParts = event.candidate.candidate.split(' ')
      console.log('[NetherNet][debug] local ICE candidate', {
        count: this.localCandidateCount,
        protocol: candidateParts[2],
        type: candidateParts[7],
        addressFamily: candidateParts[4]?.includes(':') ? 'ipv6' : 'ipv4'
      })

      this.signalHandler(new SignalStructure(SignalType.CandidateAdd, this.connectionId, event.candidate.candidate, this.networkId, this.signalServerNetworkId))
    }

    this.rtcConnection.onconnectionstatechange = () => {
      // transfer後に旧NetherNetのICEイベントが遅れて届くことがある。
      // close()でlistenerを削除した後にerrorをemitすると、Node.jsの
      // EventEmitterがUnhandled 'error'でバックエンドを終了させてしまう。
      if (!this.running) return
      const state = this.rtcConnection?.connectionState
      console.log('[NetherNet][debug] peer connection state', {
        connectionState: state,
        iceConnectionState: this.rtcConnection?.iceConnectionState,
        iceGatheringState: this.rtcConnection?.iceGatheringState,
        signalingState: this.rtcConnection?.signalingState
      })
      
      switch (state) {
        case "connected":
          this.emit('connected', this.connection)
          break;
        case "closed":
          if (this.terminalEvent) return
          this.terminalEvent = true
          this.emit('disconnect', this.connectionId, state)
          break
        case "failed":
          if (this.terminalEvent) return
          this.terminalEvent = true
          // errorをdisconnectより後にemitすると、disconnect処理で
          // EventEmitterのlistenerが削除された後にUnhandled errorになる。
          // ICE失敗はerrorだけを通知し、上位のclose処理に後始末を任せる。
          if (this.connectResponseTimer) {
            clearTimeout(this.connectResponseTimer)
            this.connectResponseTimer = null
          }
          this.emit('error', new Error('NetherNet ICE接続に失敗しました'))
          break;
      }
    }

    this.rtcConnection.oniceconnectionstatechange = () => {
      console.log('[NetherNet][debug] ICE connection state', {
        iceConnectionState: this.rtcConnection?.iceConnectionState,
        connectionState: this.rtcConnection?.connectionState
      })
    }

    this.rtcConnection.onicegatheringstatechange = () => {
      console.log('[NetherNet][debug] ICE gathering state', {
        iceGatheringState: this.rtcConnection?.iceGatheringState,
        localCandidateCount: this.localCandidateCount
      })
    }

    // The SDP must be applied unchanged first. Feeding a rewritten SDP back to
    // wrtc can make its certificate fingerprint differ from the local identity.
    // Remove identity attributes only from the copy sent through NetherNet.
    const offer = await this.rtcConnection.createOffer()
    await this.rtcConnection.setLocalDescription(offer)
    const baseSdp = this.rtcConnection.localDescription?.sdp ?? offer.sdp ?? ''

    const fingerprint = baseSdp.match(/^a=fingerprint:sha-256\s+(.*)$/m);
    const fingerprintValue = fingerprint?.[1];
    if (!fingerprintValue) {
      throw new Error('NetherNet offer SDPにDTLS sha-256 fingerprintがありません')
    }

    let sdp = baseSdp.replace(/^o=.*$/m, `o=- ${this.networkId} 2 IN IP4 127.0.0.1`);

    const assertion = await this.createAssertion(fingerprintValue, this.token);
    // NetherNet expects identity at session level (before the first m= line).
    // Putting it next to the media fingerprint makes the assertion invisible
    // to strict implementations such as go-nethernet.
    sdp = sdp.replace(/^m=/m, `a=identity:${assertion}\r\nm=`);

    this.connectRequestSignal = new SignalStructure(SignalType.ConnectRequest, this.connectionId, sdp, this.networkId, this.signalServerNetworkId)
    this.signalHandler(this.connectRequestSignal)
    console.log('[NetherNet] offer sent, waiting for CONNECTRESPONSE')
    console.log('[NetherNet][debug] offer diagnostics', {
      connectionId: String(this.connectionId),
      localNetworkId: String(this.networkId),
      sessionNetworkId: String(this.serverNetworkId),
      signalingTargetId: String(this.signalServerNetworkId),
      sdpLength: sdp.length,
      hasIdentity: sdp.includes('a=identity:'),
      hasFingerprint: Boolean(fingerprintValue),
      credentialCount: this.credentials.length
    })
  }

  processPacket(buffer, rinfo) {
    const parsedPacket = processSecurePacket(buffer, this.deserializer)

    switch (parsedPacket.name) {
      case 'discovery_request':
        break
      case 'discovery_response':
        this.handleResponse(parsedPacket, rinfo)
        break
      case 'discovery_message':
        this.handleMessage(parsedPacket)
        break
      default:
        throw new Error('Unknown packet type')
    }
  }

  handleResponse(packet, rinfo) {
    const senderId = BigInt(packet.params.sender_id)
    this.addresses.set(senderId, rinfo)
    this.responses.set(senderId, packet.params)
    if (senderId === this.serverNetworkId && packet.params.data) {
      this.serverData = packet.params.data
      for (const waiter of this.serverDataWaiters.splice(0)) waiter(packet.params.data)
    }
    this.emit('pong', packet.params)
  }

  handleMessage(packet) {
    const data = packet.params.data
    if (data === 'Ping') return

    const signal = SignalStructure.fromString(data)
    signal.networkId = BigInt(packet.params.sender_id)

    this.handleSignal(signal)
  }

  handleSignal(signal) {
    if (!this.running) return
    switch (signal.type) {
      case SignalType.ConnectResponse:
        if (String(signal.connectionId) !== String(this.connectionId)) {
          console.warn('[NetherNet] 古いCONNECTRESPONSEを無視します', {
            connectionId: String(signal.connectionId),
            expectedConnectionId: String(this.connectionId)
          })
          return
        }
        console.log('[NetherNet][debug] CONNECTRESPONSE routed to client', {
          connectionId: String(signal.connectionId),
          expectedConnectionId: String(this.connectionId),
          sourceNetworkId: String(signal.networkId ?? '')
        })
        void this.handleAnswer(signal)
        break
      case SignalType.ConnectError:
        if (String(signal.connectionId) !== String(this.connectionId)) return
        console.error('[NetherNet] CONNECTERROR:', signal.data)
        this.emit('error', new Error(`NetherNet CONNECTERROR: ${signal.data}`))
        break
      case SignalType.CandidateAdd:
        if (String(signal.connectionId) !== String(this.connectionId)) return
        if (signal.networkId === this.serverNetworkId) signal.networkId = this.networkId
        
        this.handleCandidate(signal)
        break
    }
  }

  waitForServerData(timeout = 10000) {
    if (this.serverData) return Promise.resolve(this.serverData)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.serverDataWaiters.indexOf(onData)
        if (index !== -1) this.serverDataWaiters.splice(index, 1)
        reject(new Error('Timed out waiting for NetherNet discovery response'))
      }, timeout)
      const onData = (data) => {
        clearTimeout(timer)
        resolve(data)
      }
      this.serverDataWaiters.push(onData)
    })
  }

  sendDiscoveryRequest() {
    const packetData = createPacketData('discovery_request', PACKET_TYPE.DISCOVERY_REQUEST, this.networkId)
    const packetToSend = prepareSecurePacket(this.serializer, packetData)
    this.socket.send(packetToSend, PORT, this.broadcastAddress)
  }

  sendDiscoveryMessage(signal) {
    const rinfo = this.addresses.get(BigInt(signal.networkId))
    if (!rinfo) return

    const packetData = createPacketData('discovery_message', PACKET_TYPE.DISCOVERY_MESSAGE, this.networkId, {
      recipient_id: BigInt(signal.networkId),
      data: signal.toString()
    })

    const packetToSend = prepareSecurePacket(this.serializer, packetData)
    this.socket.send(packetToSend, rinfo.port, rinfo.address)
  }

  async connect() {
    this.running = true
    this.terminalEvent = false

    await this.createOffer()
    if (!this.rtcConnection) return
    this.connectResponseStartedAt = Date.now()
    this.connectRequestRetryCount = 0
    const waitForResponse = () => {
      if (this.rtcConnection?.connectionState === 'new') {
        console.error('[NetherNet][debug] CONNECTRESPONSE timeout state', {
          connectionId: String(this.connectionId),
          localNetworkId: String(this.networkId),
          sessionNetworkId: String(this.serverNetworkId),
          signalingTargetId: String(this.signalServerNetworkId),
          signalingState: this.rtcConnection?.signalingState,
          connectionState: this.rtcConnection?.connectionState,
          iceConnectionState: this.rtcConnection?.iceConnectionState,
          iceGatheringState: this.rtcConnection?.iceGatheringState,
          localCandidateCount: this.localCandidateCount,
          remoteCandidateCount: this.remoteCandidateCount,
          connectResponseCount: this.connectResponseCount
        })
        const elapsed = Date.now() - this.connectResponseStartedAt
        if (elapsed < 60000 && this.connectRequestSignal && this.connectRequestRetryCount < 2) {
          this.connectRequestRetryCount++
          console.warn('[NetherNet] CONNECTRESPONSE未受信のためCONNECTREQUESTを再送します', {
            retry: this.connectRequestRetryCount,
            elapsed,
            connectionId: String(this.connectionId),
            target: String(this.signalServerNetworkId)
          })
          try { this.signalHandler(this.connectRequestSignal) } catch (error) { console.error('[NetherNet] CONNECTREQUEST再送失敗', error) }
          this.connectResponseTimer = setTimeout(waitForResponse, 15000)
          return
        }
        const error = new Error('NetherNet CONNECTRESPONSE待機がタイムアウトしました')
        console.error('[NetherNet]', error.message)
        // close()は内部listenerを削除するため、先にerrorを通知する。
        // 順番を逆にするとEventEmitterの未処理errorになりNode.jsが終了する。
        this.emit('error', error)
        this.close('connect-response-timeout')
      }
      this.connectResponseTimer = null
    }
    this.connectResponseTimer = setTimeout(waitForResponse, 15000)
  }

  send(buffer) {
    if (!this.running || !this.connection) return false
    this.connection.send(buffer)
    return true
  }

  ping() {
    this.running = true

    this.sendDiscoveryRequest()
  }

  close(reason) {
    if (!this.running) return
    // 以降の遅延ICEイベントを無効化してから接続を閉じる。
    this.running = false
    this.terminalEvent = true
    if (this.connectResponseTimer) {
      clearTimeout(this.connectResponseTimer)
      this.connectResponseTimer = null
    }
    clearInterval(this.pingInterval)
    this.connection?.close()
    this.socket.close()
    this.connection = null
    this.removeAllListeners()
  }
}

module.exports = { Client }