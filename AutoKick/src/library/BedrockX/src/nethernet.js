const { Client } = require('./nethernet/index')

class NethernetClient {
  constructor(options = {}) {
    this.connected = false
    this.onConnected = () => {}
    this.onCloseConnection = () => {}
    this.onEncapsulated = () => {}
    this.onError = options.onError ?? (() => {})

    this.nethernet = new Client(
      options.networkId,
      "255.255.255.255",
      options.token,
      options.identityPrivateKey,
      options.serverNetworkId
    )

    this.nethernet.on('connected', (client) => {
      if (this.connected) return

      this.onConnected(client)
      this.connected = true
    });

    this.nethernet.on('disconnect', (_id, reason) => {
      this.onCloseConnection(reason)
      this.connected = false
    });

    // NetherNet内部のタイムアウトやCONNECTERRORは、内部EventEmitterに
    // errorリスナーがないとNode.jsのuncaughtExceptionになります。
    // BedrockX Clientへ転送し、通常の接続エラーとして処理させる。
    this.nethernet.on('error', (error) => {
      this.connected = false
      this.onError(error instanceof Error ? error : new Error(String(error)))
    });

    this.nethernet.on('encapsulated', (buffer) => {
      this.onEncapsulated({ buffer })
    });
  }

  async connect() {
    await this.nethernet.connect()
  }

  sendReliable(data) {
    this.nethernet.send(data)
  }

  waitForServerData(timeout) {
    return this.nethernet.waitForServerData(timeout)
  }

  set credentials(value) {
    this.nethernet.credentials = value
  }

  get credentials() {
    return this.nethernet.credentials
  }

  set signalHandler(handler) {
    this.nethernet.signalHandler = handler
  }

  handleSignal(signal) {
    this.nethernet.handleSignal(signal)
  }

  close() {
    this.connected = false
    this.nethernet.close()
  }
}

module.exports = { NethernetClient }