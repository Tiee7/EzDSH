import type { ChannelAdapter, ChannelAdapterCreateOptions, ChannelAdapterFactory } from './types.js'

export class AdapterRegistry {
  private readonly factories = new Map<string, ChannelAdapterFactory>()

  register(factory: ChannelAdapterFactory): void {
    if (this.factories.has(factory.name)) {
      throw new Error(`Adapter "${factory.name}" is already registered`)
    }
    this.factories.set(factory.name, factory)
  }

  create(name: string, options: ChannelAdapterCreateOptions): ChannelAdapter {
    const factory = this.factories.get(name)
    if (factory === undefined) {
      throw new Error(`Unknown adapter "${name}"`)
    }
    return factory.create(options)
  }

  list(): string[] {
    return [...this.factories.keys()]
  }

  has(name: string): boolean {
    return this.factories.has(name)
  }
}
