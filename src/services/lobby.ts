import EventEmitter from 'events';

import Visitor from './visitor';
import Waiter from './waiter';

class Lobby extends EventEmitter {
  roomId: string;
  private visitors: Map<string, Visitor>;
  private waiters: Map<string, Waiter>;
  private selfDestructTimeout: NodeJS.Timeout | undefined;
  private static lobbys = new Map<string, Lobby>();

  constructor({ roomId }: { roomId: string }) {
    super();
    this.roomId = roomId;
    this.visitors = new Map();
    this.waiters = new Map();
    this.selfDestructTimeout = undefined;

    Lobby.lobbys.set(roomId, this);
  }

  close(): void {
    this.visitors.clear();
    this.waiters.clear();
    Lobby.lobbys.delete(this.roomId);
    clearTimeout(this.selfDestructTimeout);
    this.removeAllListeners();
  }

  static getLobby(roomId: string): Lobby | undefined {
    return Lobby.lobbys.get(roomId);
  }

  // visitor
  addVisitor(visitor: Visitor): void {
    this.visitors.set(visitor.peerId, visitor);
  }
  getVistor(peerId: string): Visitor | undefined {
    return this.visitors.get(peerId);
  }
  removeVistor(peerId: string): void {
    this.visitors.delete(peerId);
  }

  // waiter
  addWaiter(waiter: Waiter): void {
    this.visitors.set(waiter.peerId, waiter);
  }
  getWaiter(peerId: string): Waiter | undefined {
    return this.waiters.get(peerId);
  }
  removeWaiter(peerId: string): void {
    this.waiters.delete(peerId);
  }
}

export default Lobby;
