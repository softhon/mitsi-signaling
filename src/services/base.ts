import EventEmitter from 'events';
import { Socket } from 'socket.io';
import { MessageData } from '../types';
import { SignalingClientActions } from '../types/actions';

abstract class Base extends EventEmitter {
  id: string;
  roomId: string;
  peerId: string;
  connection: Socket;
  closed: boolean;

  constructor({
    roomId,
    peerId,
    connection,
  }: {
    roomId: string;
    peerId: string;
    connection: Socket;
  }) {
    super();
    this.id = peerId;
    this.peerId = peerId;
    this.roomId = roomId;
    this.connection = connection;
    this.closed = false;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.removeAllListeners();
  }

  message({
    message,
    broadcast,
    includeMe,
  }: {
    message: MessageData;
    broadcast?: boolean;
    includeMe?: boolean;
  }): void {
    if (broadcast) {
      this.connection.broadcast
        .to(this.roomId)
        .emit(SignalingClientActions.Message, message);
      if (includeMe) {
        this.connection.emit(SignalingClientActions.Message, message);
      }
    } else {
      this.connection.emit(SignalingClientActions.Message, message);
    }
  }
}

export default Base;
