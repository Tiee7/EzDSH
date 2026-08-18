import { describe, expect, it } from 'vitest'
import { ChannelBridgeServer } from '../../src/main/channel-bridge/server.js'
import { FeishuAdapter } from '../../src/main/channel-bridge/feishu.js'

describe('ChannelBridgeServer', () => {
  it('starts and stops on a given port', async () => {
    const adapter = new FeishuAdapter({ appId: 'a', appSecret: 'b' }, [])
    const adapters = new Map<string, FeishuAdapter>()
    adapters.set(adapter.name, adapter)
    const server = new ChannelBridgeServer({ port: 17892, adapters })

    await server.start()
    expect(server.port).toBe(17892)
    await server.stop()
  })
})
