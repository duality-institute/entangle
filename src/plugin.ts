import type { Hooks, Plugin } from "@opencode-ai/plugin"
import { MobileAuth } from "./server/auth"
import { OpencodeBridge } from "./server/bridge"
import { ControlServer, UnknownSessionError } from "./server/control"
import { EventHub } from "./server/events"
import { MobileServer, type MobileEvent } from "./server/http"
import { buildPairingUrl } from "./server/qr"
import { canonicalDirectory } from "./shared/canonical-directory"
import { EntangleOptions, type Bridge } from "./shared/protocol"

function withoutEventSubscription(bridge: OpencodeBridge): Bridge {
  return {
    getSession: (sessionID) => bridge.getSession(sessionID),
    getMessages: (sessionID, cursor) => bridge.getMessages(sessionID, cursor),
    sendPrompt: (sessionID, request) => bridge.sendPrompt(sessionID, request),
    abort: (sessionID) => bridge.abort(sessionID),
    listAgents: () => bridge.listAgents(),
    listProviders: () => bridge.listProviders(),
    respondPermission: (sessionID, id, reply) => bridge.respondPermission(sessionID, id, reply),
    currentAgentModel: (sessionID) => bridge.currentAgentModel(sessionID),
    // The composition root owns this subscription. MobileServer must not create a second wire id.
    onEvent: () => () => {},
  }
}

export const EntanglePlugin: Plugin = async (
  { client, directory, worktree },
  options,
) => {
  let mobileServer: MobileServer | undefined
  let controlServer: ControlServer | undefined
  let unsubscribeBridge: (() => void) | undefined

  const log = async (level: "info" | "error", message: string): Promise<void> => {
    await client.app.log({ body: { service: "entangle", level, message } }).catch(() => {})
  }

  try {
    const config = EntangleOptions.parse(options ?? {})
    const canonical = canonicalDirectory(directory)
    const bridge = new OpencodeBridge(client, canonical)
    const events = new EventHub<MobileEvent>()
    const auth = new MobileAuth(config.pairingTtlMs)

    auth.onFirstPairing(() => {
      void client.tui.showToast({
        body: {
          title: "Entangle",
          message: "Phone connected.",
          variant: "success",
          duration: 5_000,
        },
      }).catch(() => {})
    })

    unsubscribeBridge = bridge.onEvent((frame) => {
      if (!auth.hasActiveSession(frame.sessionID)) return
      events.publish(frame.sessionID, {
        sessionID: frame.sessionID,
        event: frame.event,
        data: frame.data,
      })
    })

    const mobile = new MobileServer({
      bridge: withoutEventSubscription(bridge),
      auth,
      events,
      options: config,
      reportError: (message, error) => {
        void log("error", `${message}: ${String(error)}`)
      },
    })
    mobileServer = mobile
    /*
     * Membership is checked against this project's own root-session list rather
     * than trusting `session.get` to reject foreign ids, so the boundary holds
     * regardless of how opencode scopes session storage across projects.
     */
    const resolveSession = async (requested?: string) => {
      if (requested === undefined) return bridge.getLatestSession()
      const roots = await bridge.listRootSessions()
      if (!roots.some((session) => session.id === requested)) {
        throw new UnknownSessionError(`${requested} is not a chat in this project`)
      }
      return bridge.getSession(requested)
    }

    controlServer = new ControlServer({
      directory: canonical,
      worktree: canonicalDirectory(worktree),
      listSessions: () => bridge.listRootSessions(),
      requestPairing: async (requested, advertisedHost) => {
        const session = await resolveSession(requested)
        await mobile.start()
        const pairing = auth.createPairing(session.id)
        events.retain(auth.activeSessionIDs())
        events.channel(session.id)
        const origin = new URL(mobile.originFor(advertisedHost))
        return {
          pairingUrl: buildPairingUrl({
            host: origin.hostname,
            port: Number(origin.port),
            token: pairing.token,
          }),
          expiresAt: pairing.expiresAt,
          session: { id: session.id, title: session.title },
        }
      },
      isMobileRunning: () => mobile.listening,
    })
    await controlServer.start()
    await log("info", `Entangle control server listening at ${controlServer.url}`)

    return {
      event: async ({ event }) => bridge.ingestEvent(event),
      dispose: async () => {
        unsubscribeBridge?.()
        unsubscribeBridge = undefined
        await mobileServer?.stop()
        await controlServer?.stop()
      },
    }
  } catch (error) {
    unsubscribeBridge?.()
    await mobileServer?.stop().catch(() => {})
    await controlServer?.stop().catch(() => {})
    const message = error instanceof Error ? error.message : String(error)
    await log("error", `Entangle initialization failed: ${message}`)
    return {} satisfies Hooks
  }
}
