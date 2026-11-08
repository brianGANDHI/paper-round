import { makeHandler } from './handler'
import type { WorkerReply, WorkerRequest } from './protocol'

/** The worker Optimise Route runs in, so the phone's screen stays alive through it. All it does is in `handler.ts`, where a test can reach it. */

const scope = self as unknown as { postMessage: (reply: WorkerReply) => void; onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null }
const handle = makeHandler((reply) => scope.postMessage(reply))

scope.onmessage = (event) => {
  void handle(event.data)
}
