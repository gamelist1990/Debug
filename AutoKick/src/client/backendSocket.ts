import type { BackendEvent, BackendRequest } from "../backend/protocol";

type Listener = (event: BackendEvent) => void;
export class BackendSocket {
  private socket?: WebSocket;
  private listeners = new Set<Listener>();
  private pending = new Map<string, (event: BackendEvent) => void>();
  private connecting?: Promise<void>;
  connect(url = "ws://127.0.0.1:47821"): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.onopen = () => { this.connecting = undefined; resolve(); };
      socket.onerror = () => { this.connecting = undefined; reject(new Error("Node.jsバックエンドへ接続できません。")); };
      socket.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data)) as BackendEvent;
          if ("requestId" in parsed && parsed.requestId)
            this.pending.get(parsed.requestId)?.(parsed);
          this.listeners.forEach((listener) => listener(parsed));
        } catch {
          /* 不正なイベントは破棄 */
        }
      };
      socket.onclose = () => {
        this.socket = undefined;
        for (const [id, resolve] of this.pending) {
          resolve({ type: "error", requestId: id, message: "バックエンド接続が切断されました。" });
        }
        this.pending.clear();
      };
    });
    return this.connecting;
  }
  send(request: BackendRequest): void {
    if (this.socket?.readyState !== WebSocket.OPEN)
      throw new Error("バックエンド接続が確立されていません。");
    this.socket.send(JSON.stringify(request));
  }
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  isConnected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }
  async request<T extends BackendEvent>(
    request: BackendRequest,
    requestId: string,
  ): Promise<T> {
    if (!this.isConnected()) throw new Error("バックエンドに接続されていません。Node.jsバックエンドを起動してください。");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("バックエンド応答がタイムアウトしました。"));
      }, 30_000);
      this.pending.set(requestId, (event) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        if (event.type === "error") reject(new Error(event.message));
        else resolve(event as T);
      });
      try { this.send(request); } catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  close(): void {
    this.socket?.close();
    this.socket = undefined;
    this.connecting = undefined;
  }
}
