/** 管理一个读操作的代次；新的读取和销毁会使旧结果失效。 */
export class RequestGate {
  private controller?: AbortController
  begin(): { signal: AbortSignal; current: () => boolean } {
    this.cancel()
    const controller = new AbortController()
    this.controller = controller
    return { signal: controller.signal, current: () => this.controller === controller && !controller.signal.aborted }
  }
  cancel(): void { this.controller?.abort(); this.controller = undefined }
}
