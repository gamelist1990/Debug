const { Client } = require('./client')

function createClient(options) {
    const client = new Client({ port: 19132, ...options, delayedInit: true })

    client.once('connect_allowed', () => {
      connect(client).catch((error) => client.emit('error', error))
    })
    client.init().catch((error) => client.emit('error', error))

    return client
}

async function connect(client) {
    client.once('resource_packs_info', () => {
        const isNetherNet = String(client.options?.transport ?? '').includes('NETHERNET')
        client.write('resource_pack_client_response', {
          // NetherNetのフレンドワールドは従来の即時completedを要求する。
          // 通常のRakNet/Geyser・Bedrockサーバーはhave_all_packsを返して
          // stackを待たないと、Geyser側のリソースパック状態が不整合になる。
          response_status: isNetherNet ? 'completed' : 'have_all_packs',
          response_status_name: isNetherNet ? 'resourcepackstackfinished' : 'haveallpacks',
          resourcepackids: []
        })
        const sendStackResponse = () => {
          client.write('resource_pack_client_response', {
            response_status: 'completed',
            response_status_name: 'resourcepackstackfinished',
            resourcepackids: []
          })
          // resource_pack_stack完了後に次の初期化パケットを送る。
          // Geyser/Javaプロキシによっては、stack前のtick_syncや
          // client_cache_statusを受け取ると初期化状態がnullのまま処理される。
          client.write('client_cache_status', { enabled: false })
          client.write('tick_sync', { request_time: BigInt(Date.now()), response_time: 0n })
          client.scheduleTimer(() => {
            if (client.status !== 'Disconnected') client.write('request_chunk_radius', { chunk_radius: 8, max_radius: 8 })
          }, 500)
        }
        client.once('resource_pack_stack', sendStackResponse)
    })
    await client.connect()
}

module.exports = { createClient }