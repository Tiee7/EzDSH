type ShutdownTask = () => Promise<void> | void

/** Stops user-managed processes before the rest of the application components. */
export async function shutdownExternalServicesFirst(
  stopExternalServices: ShutdownTask,
  stopOtherComponents: readonly ShutdownTask[],
): Promise<void> {
  await stopExternalServices()
  await Promise.all(stopOtherComponents.map((stop) => stop()))
}
